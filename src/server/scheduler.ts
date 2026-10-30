import { existsSync, realpathSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, sep } from "node:path";
import type { Agent, LogKind, Plan, Run, ServerEvent, Task, RateLimitPolicy, QuotaWindow, CheckEvidence, Evidence, DeliveryPolicy, AgentEvent, Handoff, MergeCheck, CapacityLimit, CapacityProposal, CapacityTransfer, DirectorChatTurn, AuditInput, AuditRecord } from "../shared/types.ts";
import { DEFAULT_RUN_LIMITS, DEFAULT_RUN_TIMEOUTS, RUN_TIMEOUT_BOUNDS } from "../shared/types.ts";
import { runCheck as runProjectCheck } from "./checks.ts";
import type { Db, RunPatch, TaskPatch } from "./db.ts";
import { clip, compactHandoff, directorChatPrompt, invokeDirector, nextPlanning, PlanError, validatePlan, type CheckReport, type Revision, type TaskBrief } from "./director.ts";
import { createPreviews } from "./preview.ts";
import { readSecretReport } from "./secrets.ts";
import type { SecretInput } from "./secrets.ts";
import {
  abortMerge, addWorktree, assertWorktreeRevision, commitAll, concludeMerge, deleteBranch, diffText, headCommit, mergeBase, mergeBranch, openDetachedWorktree, openWorktree,
  prepareWorkspace, pruneRun, publishCandidate, removeWorktree, diffFiles, taskMergeCommit, fingerprintInputs, describeInputs,
  currentBranch, localBranchCommit, previewMerge,
} from "./git.ts";
import { invokeRequirementReviews, invokeReview } from "./review.ts";
import { preferredTransport, readQuota, type InvocationControl, type RunAgent } from "./runtimes.ts";
import { rateLimitRetryAt } from "./rate-limits.ts";
import { skillsPrompt } from "./skills.ts";
import { captureArtifacts, missingArtifacts, restoreArtifacts } from "./artifacts.ts";
import { configurationFingerprint, runtimeManifest } from "./manifests.ts";
import { createCallSlots } from "./concurrency.ts";
import { handoffJsonSchema, workerHandoff } from "./handoff.ts";
import { knownTaskAuthors } from "./audit.ts";
import { MAX_GLOBAL_WORKERS, MAX_PROVIDER_WORKERS, chooseReviewer, mergeRequirements, parallelism, recommendStrategy, requirementStatus, tasksOverlap } from "./delivery.ts";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
class RunPaused extends Error {}
class IntegrationProblem extends Error {}

function validateTimeouts(timeouts: Run["timeouts"]) {
  const values = [[timeouts.agentMs, RUN_TIMEOUT_BOUNDS.agentMinutes], [timeouts.checkMs, RUN_TIMEOUT_BOUNDS.checkMinutes]] as const;
  if (values.some(([value, bounds]) => !Number.isInteger(value) || value < bounds.min * 60_000 || value > bounds.max * 60_000)) throw new ConflictError("Agent or check timeout is outside the allowed range");
  return { ...timeouts };
}

/** Work → verify → review passes per task attempt; the task fails when the last one still has problems. */
export const MAX_ITERATIONS = 3;
/** Automatic re-plans after failed tasks in an autonomous run. */
export const MAX_RECOVERIES = 2;
/** Verification rounds whose fix tasks run; after that the director only reports what is still open. */
export const MAX_FIX_ROUNDS = 2;
export const MAX_RATE_LIMIT_RETRIES = 5;
/** At most a baseline replay and an isolated-task replay after an integration failure. */
export const MAX_INTEGRATION_PROBES = 2;
const INTEGRATION_PROBE_TIMEOUT_MS = 30_000;

type Options = {
  db: Db;
  runAgent: RunAgent;
  runCheck?: typeof runProjectCheck;
  publish: (runId: string, ev: ServerEvent) => void;
  worktreeRoot: string;
  now?: () => number;
  getQuota?: typeof readQuota;
  quotaPollMs?: number;
  scheduleRateLimitRetry?: typeof setTimeout;
};

export type Scheduler = ReturnType<typeof createScheduler>;

export function createScheduler({ db, runAgent, runCheck = runProjectCheck, publish, worktreeRoot, now = Date.now, getQuota = readQuota, quotaPollMs = 60_000, scheduleRateLimitRetry = setTimeout }: Options) {
  const previews = createPreviews({ getRun: db.getRun, worktreeRoot, publish: (runId, event) => {
    const run = db.getRun(runId);
    if (event.type === "preview" && event.preview.status === "ready" && run && !run.firstRunnable) {
      const at = now();
      setRun(runId, { firstRunnable: { at, elapsedMs: run.activeElapsedMs + (run.activeSince === null ? 0 : at - run.activeSince), commit: event.preview.commit, draft: event.preview.draft ?? false } });
    }
    publish(runId, event);
  }, getEnvironment: db.secretEnvironment, onSecrets: recordPreviewSecrets, getWorktrees: (id) => db.listTasks(id).filter((task) => task.status === "running" && task.stage !== "definition").map((task) => taskPath(task)) });
  /** Live agent processes, so cancel can stop them. Key: task id, or run id for the director. */
  const inflight = new Map<string, { runId: string; controller: AbortController }>();
  /** Per-run chain that serializes merges into the integration worktree. */
  const mergeChains = new Map<string, Promise<unknown>>();
  /** Removal of a completed run's integration worktree; planning on the run again waits for it. */
  const cleanups = new Map<string, Promise<unknown>>();
  const retired = new Set<Promise<unknown>>();
  const chatReplies = new Set<Promise<void>>();
  const chatControllers = new Map<string, AbortController>();
  const rateLimitTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  const controls = new Map<string, { runId: string; taskId: string | null; agentId: string; control: InvocationControl }>();
  let schedulingCursor = 0;
  const acquireCall = createCallSlots(MAX_GLOBAL_WORKERS, MAX_PROVIDER_WORKERS);
  const acquireCheck = createCallSlots<"check">(MAX_GLOBAL_WORKERS, MAX_GLOBAL_WORKERS);
  const pendingAcquisitions = new Map<string, { runId: string; controller: AbortController; chat: boolean }>();
  const projectIdentities = new Map<string, string>();
  const projectIdentity = (path: string) => {
    const saved = projectIdentities.get(path);
    if (saved) return saved;
    try { const key = realpathSync(path); projectIdentities.set(path, key); return key; } catch { return path; }
  };

  const integrationPath = (runId: string) => join(worktreeRoot, runId, "integration");
  const candidatePath = (runId: string) => join(worktreeRoot, runId, ".candidate", "integration");
  const taskPath = (task: Task) => join(worktreeRoot, task.runId, task.key);
  const taskBranch = (run: Run, task: Task) => `${run.branch}-${task.key}`;
  const authorsOf = (tasks: Task[]) => {
    const runId = tasks[0]?.runId;
    return knownTaskAuthors(tasks, runId ? db.listAudit(runId) : [], runId ? db.listAgentEvents(runId) : []);
  };
  const audit = (input: AuditInput) => {
    const record = db.recordAudit({ ...input, ts: now() });
    publish(record.runId, { type: "audit", runId: record.runId, record });
    return record;
  };
  const digest = (value: string) => createHash("sha256").update(value).digest("hex");
  const runCheckFor = async (runId: string, cwd: string, command: string, signal: AbortSignal, timeoutMs: number) => {
    proceed(runId);
    const requestId = crypto.randomUUID();
    const waiting = new AbortController();
    pendingAcquisitions.set(requestId, { runId, controller: waiting, chat: false });
    let release: () => void;
    try { release = await acquireCheck("check", AbortSignal.any([signal, waiting.signal])); }
    finally { pendingAcquisitions.delete(requestId); }
    try {
      proceed(runId);
      return await runCheck(cwd, command, signal, timeoutMs);
    } finally { release(); }
  };

  const setRun = (id: string, patch: RunPatch) => {
    const before = db.getRun(id)!;
    if (patch.status && !["pausing", "paused"].includes(patch.status)) {
      clearTimeout(rateLimitTimers.get(id));
      rateLimitTimers.delete(id);
      patch = { ...patch, rateLimitResumeAt: null };
    }
    if (patch.status && ["paused", "failed", "completed", "cancelled", "awaiting_approval"].includes(patch.status)) {
      patch = { ...patch, activeElapsedMs: before.activeElapsedMs + (before.activeSince === null ? 0 : now() - before.activeSince), activeSince: null };
      clearTimeout(deadlines.get(id));
      deadlines.delete(id);
    } else if (patch.status && ["planning", "running"].includes(patch.status) && before.activeSince === null) {
      patch = { ...patch, activeSince: now() };
    }
    const run = db.updateRun(id, patch);
    if (run.activeSince !== null && run.limits && !deadlines.has(id)) {
      const remaining = run.limits.maxDurationMs - elapsed(run);
      const timer = setTimeout(() => pauseInternal(id, "Time budget reached", true), Math.max(0, remaining));
      timer.unref();
      deadlines.set(id, timer);
    }
    publish(run.id, { type: "run", run });
    return run;
  };
  const setTask = (id: string, patch: TaskPatch) => {
    const before = db.getTask(id)!;
    const task = db.updateTask(id, patch);
    const state = { runId: task.runId, taskId: id, agentId: task.agentId, attempt: task.attempt, phase: task.phase, status: task.status, commit: task.phase === "done" ? task.mergeCommit : null };
    if (before.agentId !== task.agentId) audit({ ...state, kind: "task-assignment", previousAgentId: before.agentId, reason: "Task reassigned with earlier work preserved" });
    if (before.startedAt === null && task.startedAt !== null) audit({ ...state, kind: "task-attempt" });
    if (before.phase !== task.phase || before.status !== task.status) audit({ ...state, kind: "task-phase" });
    publish(task.runId, { type: "task", task });
    if (before.phase !== task.phase) queueMicrotask(tickAll);
    return task;
  };
  const logger = (runId: string, taskId: string | null) => (kind: LogKind, text: string) =>
    publish(runId, { type: "log", log: db.addLog(runId, taskId, kind, text) });

  function recordEvidence(runId: string, taskId: string | null, scope: Evidence["scope"], commit: string, check: CheckEvidence, producer: string, requirementIds: string[] = [], artifacts: string[] = [], contextIds = requirementIds) {
    const run = db.getRun(runId)!;
    const evidence = db.recordEvidence({
      runId, taskId, scope, commit, producer, requirementIds,
      requirementVersions: Object.fromEntries(run.requirements.filter((r) => contextIds.includes(r.id)).map((r) => [r.id, r.version])),
      command: check.command, status: check.ok ? "passed" : "failed", output: check.output,
      durationMs: check.durationMs ?? 0, artifacts,
    });
    publish(runId, { type: "evidence", runId, evidence });
    return evidence;
  }

  function reviewChecks(runId: string, commit: string, scope: Evidence["scope"]): CheckEvidence[] {
    const latest = new Map<string, CheckEvidence>();
    for (const evidence of db.listEvidence(runId)) {
      if (evidence.commit !== commit || evidence.scope !== scope || !evidence.producer.startsWith("orchestra:")) continue;
      latest.set(JSON.stringify([evidence.command, evidence.requirementIds]), { command: evidence.command, ok: evidence.status === "passed", output: evidence.output, commit, producer: evidence.producer, durationMs: evidence.durationMs });
    }
    const commands = new Map<string, CheckEvidence>();
    for (const check of latest.values()) {
      const previous = commands.get(check.command);
      if (!previous || previous.ok) commands.set(check.command, check);
      else if (!check.ok) commands.set(check.command, { ...previous, output: `${previous.output}\n${check.output}` });
    }
    return [...commands.values()];
  }

  async function checkRequirements(runId: string, cwd: string, scope: "acceptance" | "integration", signal: AbortSignal, taskId: string | null = null, force = false, checked?: CheckEvidence | null): Promise<string[]> {
    const run = mustRun(runId);
    const task = taskId ? db.getTask(taskId) : null;
    const tasks = db.listTasks(runId).filter((t) => t.status !== "superseded");
    const requirements = run.requirements.filter((r) => !task || r.kind === "command" && task.contract.requirementIds.includes(r.id) && !tasks.some((t) => t.id !== task.id && t.status !== "done" && t.contract.requirementIds.includes(r.id)));
    const commit = await headCommit(cwd);
    const problems: string[] = [];
    const pending: typeof requirements = [];
    const rerunCommands = new Set<string>();
    const receipts = db.listEvidence(runId);
    for (const requirement of requirements) {
      const command = requirement.kind === "command" ? requirement.check : `independent review: ${requirement.id}`;
      const previous = receipts.findLast((e) => e.scope === scope && e.command === command && e.producer.startsWith(requirement.kind === "command" ? "orchestra:requirement" : "reviewer:") && e.commit === commit && e.requirementVersions[requirement.id] === requirement.version && e.requirementIds.includes(requirement.id));
      if (previous?.status === "passed" && !force) {
        if (!requirement.artifacts.length) continue;
        const versions = await fingerprintInputs(cwd, commit, requirement.artifacts);
        const tracked = new Set(requirement.artifacts.filter((path) => versions[path] !== "missing"));
        const restored = restoreArtifacts(cwd, requirement.artifacts, join(worktreeRoot, runId, ".artifacts"), previous.artifacts, tracked);
        if (!restored.missing.length) continue;
        logger(runId, taskId)("system", `Saved artifacts unavailable for ${requirement.id}; its check must run again: ${restored.missing.join(", ")}`);
        if (requirement.kind === "command") rerunCommands.add(requirement.check);
      } else if (previous?.status === "failed" && requirement.kind === "command" && requirement.artifacts.length) rerunCommands.add(requirement.check);
      pending.push(requirement);
    }
    const groups = new Map<string, typeof pending>();
    const reviewers = new Map<string, NonNullable<ReturnType<typeof chooseReviewer>>>();
    for (const requirement of pending) {
      let key = `command:${requirement.check}`;
      if (requirement.kind === "review") {
        const owners = tasks.filter((t) => t.contract.requirementIds.includes(requirement.id));
        const authors = authorsOf(owners);
        const director = db.getAgent(run.directorAgentId);
        const reviewContext = `${owners.some((task) => task.contract.ui) ? "Rendered UI visual fidelity. " : ""}${requirement.title} ${requirement.description}`;
        const selected = chooseReviewer(rosterOf(run), authors, reviewContext) ?? (director ? chooseReviewer([director], authors, reviewContext) : null);
        if (!selected) { if (requirement.required) problems.push(`${requirement.id}: no independent reviewer is available`); continue; }
        reviewers.set(requirement.id, selected);
        key = `review:${selected.agent.id}`;
      }
      groups.set(key, [...groups.get(key) ?? [], requirement]);
    }
    for (const group of [...groups.values()].sort((a, b) => Number(a[0]!.kind === "review") - Number(b[0]!.kind === "review"))) {
      proceed(runId);
      const requirement = group[0]!;
      const started = now();
      let check: CheckEvidence;
      let memberChecks: Map<string, CheckEvidence> | undefined;
      let producer = "orchestra:requirement";
      const shared = requirement.kind === "command" && !rerunCommands.has(requirement.check) && checked?.command === requirement.check && checked.commit === commit
        && group.every((member) => !missingArtifacts(cwd, member.artifacts).length);
      if (requirement.kind === "command") {
        logger(runId, taskId)("system", `Checking requirements ${group.map((r) => r.id).join(", ")}: ${requirement.check}`);
        check = shared ? { ...checked!, durationMs: 0 } : { command: requirement.check, ...await runCheckFor(runId, cwd, requirement.check, signal, run.timeouts.checkMs) };
      } else {
        const selected = reviewers.get(requirement.id)!;
        const reviewer = selected.agent;
        const reviews = await invokeRequirementReviews(metered(runId, null, undefined, `${scope}-review`, selected.reason), {
          reviewer, requirements: group.map(({ id, title, description }) => ({ id, title, description })), context: `Review the exact integrated result for the original brief: ${run.prompt}`, author: "the team", diff: await diffText(cwd, run.baseCommit), cwd, checks: reviewChecks(runId, commit, scope), signal, onLog: logger(runId, null),
        });
        memberChecks = new Map(reviews.map((review) => [review.id, { command: `independent review: ${review.id}`, ok: review.verdict === "approve", output: review.findings }]));
        check = memberChecks.get(requirement.id)!;
        producer = `reviewer:${reviewer.id}`;
      }
      if (signal.aborted) throw new RunPaused();
      let revisionProblem: string | null = null;
      try { await assertWorktreeRevision(cwd, commit); }
      catch (e) { revisionProblem = errorText(e); }
      // Share the command execution only within this snapshot and scope. Artifacts
      // and requirement versions still receive their own evidence and failures.
      for (const [index, member] of group.entries()) {
        const captured = captureArtifacts(cwd, member.artifacts, join(worktreeRoot, runId, ".artifacts"));
        const result = { ...memberChecks?.get(member.id) ?? check, commit, producer, durationMs: index === 0 && !shared ? Math.max(0, now() - started) : 0 };
        if (revisionProblem) { result.ok = false; result.output += `\n${revisionProblem}`; }
        if (captured.missing.length) {
          result.ok = false;
          result.output += `\nMissing or unsupported evidence artifacts: ${captured.missing.join(", ")}`;
        }
        recordEvidence(runId, taskId, scope, commit, result, producer, [member.id], captured.artifacts);
        if (member.required && !result.ok) problems.push(`${member.id}: ${result.output.trim() || "Independent review requested changes"}`);
      }
    }
    return problems;
  }

  const elapsed = (run: Run) => run.activeElapsedMs + (run.activeSince === null ? 0 : now() - run.activeSince);

  function settlePause(runId: string) {
    if (db.getRun(runId)?.status !== "pausing" || [...inflight.values()].some((v) => v.runId === runId)) return;
    const run = mustRun(runId);
    const tasks = db.listTasks(runId).filter((task) => task.status !== "superseded");
    const previous = run.pauseReason === "Fix round limit reached" || run.pauseReason === "Recovery limit reached" ? run.report : run.history.findLast((entry) => entry.report)?.report;
    const checkpoints = tasks.map((task) => `- ${task.key}: ${task.status} at ${task.phase}; checks ${task.handoff?.check ? task.handoff.check.ok ? "passed" : "failed" : "not recorded"}; review ${task.handoff?.review?.verdict ?? "not recorded"}`).join("\n");
    const report = `${previous ? `${previous}\n\n` : ""}Paused: ${run.pauseReason}. ${run.agentCalls} agent calls used. Work is preserved on ${run.branch}.\n\n${checkpoints || "Director planning checkpoint saved."}`;
    const paused = setRun(runId, { status: "paused", report });
    clearTimeout(rateLimitTimers.get(runId));
    rateLimitTimers.delete(runId);
    if (paused.rateLimitResumeAt !== null) {
      const timer = scheduleRateLimitRetry(async () => {
        rateLimitTimers.delete(runId);
        const current = db.getRun(runId);
        if (current?.status !== "paused" || current.rateLimitResumeAt === null) return;
        try {
          if (current.quotaWait && !await quotaRefilled(current)) return;
          resume(runId);
        }
        catch (e) {
          setRun(runId, { rateLimitResumeAt: null });
          logger(runId, null)("error", `Automatic continuation stopped: ${errorText(e)}`);
        }
      }, Math.max(0, paused.rateLimitResumeAt - now()));
      timer.unref();
      rateLimitTimers.set(runId, timer);
    }
  }

  function pauseInternal(runId: string, reason: string, hard = false) {
    const run = mustRun(runId);
    if (["completed", "cancelled", "failed", "paused"].includes(run.status)) return run;
    const updated = setRun(runId, { status: "pausing", pauseReason: reason, ...(!reason.startsWith("Rate limit") && !reason.startsWith("Usage safeguard") && { rateLimitResumeAt: null }) });
    logger(runId, null)("system", `Pausing: ${reason}. Work and checkpoints are preserved.`);
    for (const waiting of pendingAcquisitions.values()) if (waiting.runId === runId && !waiting.chat) waiting.controller.abort(new RunPaused());
    if (hard) for (const v of inflight.values()) if (v.runId === runId) v.controller.abort();
    settlePause(runId);
    return db.getRun(runId) ?? updated;
  }

  function proceed(runId: string) {
    const run = mustRun(runId);
    if (run.limits && elapsed(run) >= run.limits.maxDurationMs && ["running", "planning"].includes(run.status)) pauseInternal(runId, "Time budget reached", true);
    if (!["running", "planning"].includes(mustRun(runId).status)) throw new RunPaused();
  }

  const quotaReads = new Map<string, Promise<QuotaWindow[]>>();
  async function quota(agent: Agent) {
    let pending = quotaReads.get(agent.runtime);
    if (!pending) {
      pending = getQuota(agent);
      quotaReads.set(agent.runtime, pending);
    }
    try { return await pending; }
    finally { if (quotaReads.get(agent.runtime) === pending) quotaReads.delete(agent.runtime); }
  }

  async function guardQuota(runId: string, agent: Agent, chat?: AbortController) {
    const run = mustRun(runId);
    const policy = run.rateLimitPolicy ?? agent.rateLimitPolicy ?? db.getGlobalRateLimitPolicy();
    if (!policy) return;
    try {
      const windows = (await quota(agent)).filter((w) => policy.window === "both" || w.window === policy.window);
      if (chat) chat.signal.throwIfAborted(); else proceed(runId);
      if (!windows.length) throw new Error(`No ${policy.window} quota window reported for ${agent.name}`);
      // An expired, nonzero snapshot cannot authorize more work.
      const reached = windows.find((w) => w.usedPercent >= policy.maxUsedPercent || w.usedPercent > 0 && w.resetsAt <= now());
      if (reached) {
        if (chat) throw new Error(`${agent.name} ${reached.window} usage is ${reached.usedPercent}% (ceiling ${policy.maxUsedPercent}%). Try again after usage refills.`);
        rememberCapacityLimit(runId, agent, `Usage safeguard: ${reached.window} usage ${reached.usedPercent}% (ceiling ${policy.maxUsedPercent}%)`);
        setRun(runId, { quotaWait: { agentId: agent.id, window: reached.window, attempts: 0 }, rateLimitResumeAt: Math.max(now() + 60_000, reached.resetsAt + 1000) });
        pauseInternal(runId, `Usage safeguard: ${agent.name} ${reached.window} usage ${reached.usedPercent}% (ceiling ${policy.maxUsedPercent}%); waiting for 100% available`, true);
        throw new RunPaused();
      }
    } catch (e) {
      if (chat) {
        if (chat.signal.aborted) throw chat.signal.reason;
        const error = new Error(`Chat usage safeguard: ${errorText(e)}`);
        chat.abort(error);
        throw error;
      }
      if (e instanceof RunPaused) throw e;
      proceed(runId);
      pauseInternal(runId, `Usage safeguard unavailable: ${errorText(e)}; resume manually after checking your login`, true);
      throw new RunPaused();
    }
  }

  async function quotaRefilled(run: Run): Promise<boolean> {
    const wait = run.quotaWait;
    if (!wait) return true;
    const agent = db.getAgent(wait.agentId);
    let window: QuotaWindow | undefined;
    try { if (agent) window = (await quota(agent)).find((w) => w.window === wait.window); } catch { /* Bounded rechecks below. */ }
    // A user pause/cancel during the read wins over automatic continuation.
    const current = mustRun(run.id);
    if (current.status !== "paused" || current.quotaWait?.agentId !== wait.agentId) return false;
    if (window?.usedPercent === 0 && window.resetsAt > now()) {
      setRun(run.id, { quotaWait: null, capacityLimits: current.capacityLimits.filter((limit) => limit.runtime !== agent?.runtime) });
      return true;
    }
    const attempts = wait.attempts + 1;
    const exhausted = attempts >= MAX_RATE_LIMIT_RETRIES;
    setRun(run.id, {
      quotaWait: { ...wait, attempts },
      rateLimitResumeAt: exhausted ? null : Math.max(now() + 60_000, (window?.resetsAt ?? now()) + 1000),
      pauseReason: exhausted ? "Usage safeguard: refill could not be confirmed; resume manually" : "Usage safeguard: waiting for 100% available",
      status: "pausing",
    });
    settlePause(run.id);
    return false;
  }

  /** Reserve synchronously at the invocation boundary so parallel workers share one hard call cap. */
  const metered = (runId: string, taskId: string | null, chat?: AbortController, purpose?: string, selectionReason?: string): RunAgent => async (inv) => {
    const queuedAt = now();
    const check = () => { if (chat) { mustRun(runId); chat.signal.throwIfAborted(); } else proceed(runId); };
    check();
    const requestId = crypto.randomUUID();
    const waiting = new AbortController();
    pendingAcquisitions.set(requestId, { runId, controller: waiting, chat: !!chat });
    let release: () => void;
    try { release = await acquireCall(inv.agent.runtime, inv.signal ? AbortSignal.any([inv.signal, waiting.signal]) : waiting.signal); }
    finally { pendingAcquisitions.delete(requestId); }
    const slotAcquiredAt = now();
    try {
    check();
    await guardQuota(runId, inv.agent, chat);
    check();
    const run = mustRun(runId);
    const invocationId = crypto.randomUUID();
    const emit = (kind: AgentEvent["kind"], text: string, parentId: string | null = null, id: string = crypto.randomUUID()) => {
      const event = db.recordAgentEvent({ id, invocationId, runId, taskId, agentId: inv.agent.id, parentId, kind, text, ts: now() });
      publish(runId, { type: "agent-event", runId, event });
    };
    // Memory first: the run's own guidance is newer and wins where they disagree.
    const memory = db.getMemory(run.workdir);
    const projectMemory = memory ? `\n\n## Project memory\nNotes the user kept from earlier runs on this project. Follow them unless the goal or the user's guidance says otherwise.\n${memory}` : "";
    const currentGuidance = run.guidance ? `\n\n## Current guidance from the user\n${run.guidance}` : "";
    const secretNames = db.listSecrets(run.workdir, run.id).filter((secret) => secret.environment).map((secret) => secret.name);
    const secretsGuidance = `\n\n## App credentials and secrets\nOrchestra has a Secrets panel beside the live preview. Saved environment variable names: ${secretNames.join(", ") || "none yet"}. Values are injected into the preview start command only, not agent or check processes. Read configuration from environment variables; use separate test fixtures for verification. Do not put secret values in source, prompts, summaries or logs. If the app needs a preview login, make its preview setup provision a usable preview-only account and write its actual login details as a JSON object of string values (for example username and password) to process.env.ORCHESTRA_SECRETS_FILE when process.env.ORCHESTRA_PREVIEW === "1". Orchestra supplies that private file outside the repository and displays it under Secrets. Preserve existing accounts; never reset a real account to make a preview work. Do not print credentials or invent values that have not been configured in the app.`;
    const previewGuidance = run.preview.enabled ? `\n\n## Live preview\nThe user wants to see runnable progress as the team works. For web projects, plan an early runnable slice and keep a working dev server script (Vite, Next.js or Astro) or a root index.html. Orchestra automatically previews snapshots of active task files in a separate worktree, then updates to checked integrated work after merges; do not leave a preview server running yourself. Do not change the project's stack or add web features just to enable a preview.\n${run.preview.command ? `User's preview command: ${run.preview.command}` : "Other stacks can use a custom preview command in Orchestra."}` : "";
    let checking = false;
    let poll: ReturnType<typeof setInterval> | undefined;
    let res;
    let auditStarted = false;
    let auditFinished = false;
    try {
      const transport = await preferredTransport(inv.agent.runtime);
      check();
      const manifest = await runtimeManifest(inv.agent, inv.cwd);
      const task = taskId ? db.getTask(taskId) : null;
      const prompt = inv.prompt + `\n\n## Delivery preferences\n${JSON.stringify(run.delivery)}\nOrchestra owns delegation, Git integration and acceptance. ${chat ? "This user message authorizes one advisory reply only. Native child spawning is disabled; do not start, resume or alter the team's work." : "Native child spawning is disabled so all calls share this run's persistent budget."}\n` + (chat ? "" : previewGuidance + secretsGuidance) + projectMemory + currentGuidance;
      let inputCommit: string | null = null;
      try { inputCommit = await headCommit(inv.cwd); } catch { /* A missing revision is recorded as unknown, never inferred. */ }
      check();
      const budget = mustRun(runId);
      if (!chat && budget.limits && budget.agentCalls >= budget.limits.maxAgentCalls) {
        pauseInternal(runId, "Agent call budget reached");
        throw new RunPaused();
      }
      // Reserve immediately before invocation, with no await between the cap check and call.
      setRun(runId, chat ? { chatCalls: budget.chatCalls + 1 } : { agentCalls: budget.agentCalls + 1 });
      const selectedIds = purpose === "work" || purpose === "conflict-resolution" ? task?.contract.skillIds : undefined;
      audit({ kind: "invocation-started", runId, taskId, invocationId,
        agent: { id: inv.agent.id, name: inv.agent.name, role: inv.agent.role, runtime: inv.agent.runtime, model: manifest.model, effort: manifest.effort },
        purpose: chat ? "chat" : purpose ?? inv.mode, phase: task?.phase ?? null, attempt: task?.attempt ?? null, inputCommit, queuedAt, slotAcquiredAt,
        promptDigest: digest(prompt), guidanceDigest: digest(projectMemory + currentGuidance), manifest, registeredSkills: manifest.skills,
        selectedSkills: selectedIds === undefined ? [] : manifest.skills.filter((skill) => selectedIds.includes(skill.id)),
        ...(selectionReason ? { selectionReason } : {}),
      });
      auditStarted = true;
      const event = db.recordAgentEvent({ id: invocationId, invocationId, runId, taskId, agentId: inv.agent.id, parentId: null, kind: "started", text: `${inv.agent.name}: ${chat ? "chat" : inv.mode}`, ts: now(), manifest });
      publish(runId, { type: "agent-event", runId, event });
      const children = new Map<string, string>();
      poll = setInterval(() => {
        if (checking || (chat ? chat.signal.aborted : !["planning", "running"].includes(mustRun(runId).status))) return;
        checking = true;
        void guardQuota(runId, inv.agent, chat).catch(() => {}).finally(() => { checking = false; });
      }, quotaPollMs);
      poll.unref();
      res = await runAgent({ ...inv, transport, timeoutMs: run.timeouts.agentMs, nativeDelegation: false, prompt,
        onControl: (control) => {
          if (control && !chat) controls.set(invocationId, { runId, taskId, agentId: inv.agent.id, control });
          else controls.delete(invocationId);
          inv.onControl?.(control);
        },
        onEvent: (event) => {
          const id = `${invocationId}:${event.id}`;
          if (event.kind === "child-started") {
            if (!children.has(event.id)) { children.set(event.id, id); emit(event.kind, event.text, event.parentId ? children.get(event.parentId) ?? invocationId : invocationId, id); }
          } else {
            if (!event.parentId || !children.has(event.parentId)) return;
            emit(event.kind, event.text, children.get(event.parentId)!);
            children.delete(event.parentId);
          }
          inv.onEvent?.(event);
        },
      });
      let skillClaims: string[] | undefined;
      if (res.ok && purpose === "work") {
        try { skillClaims = workerHandoff(res, inv.agent.skills.filter((skill) => selectedIds === undefined || selectedIds.includes(skill.id)).map((skill) => skill.id)).details?.skillIds; } catch { /* The work phase reports invalid handoffs; usage is retained here. */ }
      }
      audit({ kind: "invocation-finished", runId, taskId, invocationId, status: res.ok ? "completed" : "failed", usage: res.usage ?? null, error: res.ok ? null : res.error ?? "Invocation failed", ...(skillClaims ? { skillClaims } : {}) });
      auditFinished = true;
      emit(res.ok ? "completed" : "failed", res.ok ? "Invocation completed" : res.error ?? "Invocation failed", invocationId);
    } catch (e) {
      if (auditStarted && !auditFinished) audit({ kind: "invocation-finished", runId, taskId, invocationId, status: "failed", usage: null, error: errorText(e) });
      if (auditStarted) emit("failed", errorText(e), invocationId);
      throw e;
    } finally { clearInterval(poll); controls.delete(invocationId); }
    // Reviewers share the worktree, but their sessions must never replace the worker's.
    if (taskId && inv.mode === "worker" && inv.cwd === taskPath(db.getTask(taskId)!) && res.session) setTask(taskId, { session: res.session });
    if (res.usage && (res.usage.tokens > 0 || (res.usage.costUsd ?? 0) > 0)) {
      db.addUsage(runId, taskId, res.usage);
      publish(runId, { type: "run", run: db.getRun(runId)! });
      if (taskId) publish(runId, { type: "task", task: db.getTask(taskId)! });
    }
    const retryAt = !res.ok ? rateLimitRetryAt(`${res.error ?? ""} ${res.text}`, now()) : null;
    if (!chat && retryAt !== null && ["running", "planning", "pausing"].includes(mustRun(runId).status)) {
      rememberCapacityLimit(runId, inv.agent, `${res.error ?? ""} ${res.text}`.trim().slice(0, 2000));
      const current = mustRun(runId);
      if (current.limits && current.agentCalls >= current.limits.maxAgentCalls) {
        pauseInternal(runId, "Agent call budget reached");
        throw new RunPaused();
      }
      const exhausted = current.rateLimitRetries >= MAX_RATE_LIMIT_RETRIES;
      // A user pause or budget pause always takes precedence over automatic continuation.
      if (current.status !== "pausing" || current.pauseReason?.startsWith("Rate limit")) {
        const automatic = current.autoContinueOnRateLimit;
        setRun(runId, { error: automatic ? null : `${res.error ?? ""} ${res.text}`.trim(), rateLimitResumeAt: automatic && !exhausted ? Math.max(current.rateLimitResumeAt ?? 0, retryAt) : null, rateLimitRetries: current.rateLimitRetries + (automatic && !exhausted ? 1 : 0) });
        pauseInternal(runId, !automatic ? "Rate limit reached; review available agents or try again later" : exhausted ? "Rate limit retry limit reached; resume manually" : "Rate limit reached; waiting to continue automatically");
      }
      throw new RunPaused();
    }
    if (!chat && res.ok && ["running", "planning"].includes(mustRun(runId).status) && mustRun(runId).capacityLimits.some((limit) => limit.runtime === inv.agent.runtime && !limit.rerouted)) {
      setRun(runId, { capacityLimits: mustRun(runId).capacityLimits.filter((limit) => limit.runtime !== inv.agent.runtime || limit.rerouted) });
    }
    const latest = mustRun(runId);
    if (!chat && latest.limits && latest.agentCalls >= latest.limits.maxAgentCalls && ["planning", "running"].includes(latest.status)) pauseInternal(runId, "Agent call budget reached");
    return res;
    } finally { release(); queueMicrotask(tickAll); }
  };

  function planning(run: Run, tasks: Task[]) {
    const current = tasks.filter((t) => t.cycle === run.cycle);
    const next = nextPlanning(current);
    const base = { doneKeys: new Set(tasks.filter((t) => t.status === "done").map((t) => t.key)), takenKeys: new Set(tasks.map((t) => t.key)), requirements: run.requirements,
      agentSkills: new Map(rosterOf(run).map((agent) => [agent.id, new Set(agent.skills.map((skill) => skill.id))])),
    };
    if (run.purpose === "improve") return { purpose: "improve" as const, stage: null, rules: { ...base, stages: ["build", "fix"] as Plan["stage"][], improvement: true } };
    return { ...next, rules: { ...next.rules, ...base } };
  }

  const mustRun = (id: string) => {
    const run = db.getRun(id);
    if (!run) throw new NotFoundError("Run not found");
    return run;
  };
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /**
   * Everyone the run's director can staff: its team's current members. The director plans and delegates but never
   * takes a task, even after the team names a different Director.
   */
  const rosterOf = (run: Run) =>
    (run.teamId ? db.getTeam(run.teamId)?.memberIds ?? [] : [])
      .filter((id) => id !== run.directorAgentId)
      .flatMap((id) => db.getAgent(id) ?? [])
      .filter((agent) => !run.capacityLimits.some((limit) => limit.rerouted && limit.runtime === agent.runtime));
  const teamIds = (run: Run) => new Set(rosterOf(run).map((a) => a.id));
  const agentName = (id: string | null) => (id && db.getAgent(id)?.name) || "unknown";
  const brief = (t: Task): TaskBrief => ({
    key: t.key, title: t.title, agent: agentName(t.agentId), status: t.status, cycle: t.cycle, summary: t.summary ?? "", error: t.error ?? "", handoff: t.handoff, mergeCommit: t.mergeCommit,
  });

  function track(key: string, runId: string) {
    const controller = new AbortController();
    inflight.set(key, { runId, controller });
    return controller.signal;
  }

  function withMergeLock<T>(runId: string, fn: () => Promise<T>): Promise<T> {
    const result = (mergeChains.get(runId) ?? Promise.resolve()).then(fn);
    mergeChains.set(runId, result.catch(() => {}));
    return result;
  }

  /** Asks the director for the run's next plan; what it plans follows from the run's tasks (see `nextPlanning`). */
  async function planRun(runId: string, revision?: Revision) {
    let run = mustRun(runId);
    const log = logger(runId, null);
    const signal = track(runId, runId);
    let cwd = integrationPath(runId);
    try {
      proceed(runId);
      const director = db.getAgent(run.directorAgentId);
      if (!director) throw new PlanError("Director agent no longer exists");
      const roster = rosterOf(run);
      if (!roster.length) throw new PlanError("The run's team no longer has members for the Director to staff");
      // A completed run's integration worktree is gone; feedback on it continues the same branch.
      await cleanups.get(runId);
      if (!existsSync(cwd)) await openWorktree(run.workdir, cwd, run.branch);
      const tasks = db.listTasks(runId);
      const { purpose, stage, rules } = planning(run, tasks);
      run = setRun(runId, { purpose });
      if (purpose === "fix") {
        const accepted = await headCommit(cwd);
        cwd = join(worktreeRoot, runId, ".acceptance", "integration");
        await openDetachedWorktree(run.workdir, cwd, accepted);
        setRun(runId, { acceptedCommit: accepted });
      }
      const verify = run.plan?.verify ?? "";
      const finalRound = purpose === "fix" && run.fixRounds >= MAX_FIX_ROUNDS;

      let check: CheckReport = run.check;
      if (purpose === "fix" && verify && (run.planningPhase === "check" || run.check?.command !== verify || run.check?.commit !== await headCommit(cwd))) {
        proceed(runId);
        log("system", `Running the verify command on the merged build: ${verify}`);
        const started = now();
        const commit = await headCommit(cwd);
        let res = await runCheckFor(runId, cwd, verify, signal, run.timeouts.checkMs);
        if (signal.aborted) return;
        try { await assertWorktreeRevision(cwd, commit); } catch (e) { res = { ok: false, output: `${res.output}\n${errorText(e)}` }; }
        log(res.ok ? "system" : "error", `Verify command ${res.ok ? "passed" : "failed"}:\n${res.output.trim()}`);
        check = { command: verify, ...res, commit, producer: "orchestra:combined", durationMs: Math.max(0, now() - started) };
        recordEvidence(runId, null, "acceptance", commit, check, "orchestra:combined");
        setRun(runId, { check, planningPhase: "director" });
      }

      if (purpose === "fix") {
        const currentCommit = await headCommit(integrationPath(runId));
        const combined = db.listEvidence(runId).findLast((e) => e.scope === "acceptance" && e.producer === "orchestra:combined" && e.command === verify && e.commit === currentCommit);
        check = combined ? { command: combined.command, ok: combined.status === "passed", output: combined.output, commit: combined.commit } : verify ? check : null;
        const problems = await checkRequirements(runId, cwd, "acceptance", signal, null, !!revision, check);
        const commit = currentCommit;
        setRun(runId, { acceptedCommit: commit });
        if (problems.length) {
          check = { command: verify || "required acceptance checks", ok: false, output: [check?.ok === false ? check.output : "", ...problems].filter(Boolean).join("\n"), commit };
          setRun(runId, { check, planningPhase: "director" });
        } else setRun(runId, { check, planningPhase: "director" });
        if (run.delivery.profile === "quality" && !problems.length && check?.ok !== false) {
          const command = "independent quality review";
          const previous = db.listEvidence(runId).findLast((e) => e.scope === "acceptance" && e.command === command && e.commit === commit);
          if (previous?.status !== "passed" || !run.requirements.every((r) => previous.requirementVersions[r.id] === r.version) || revision) {
            const authors = authorsOf(tasks.filter((t) => t.stage !== "definition"));
            const reviewContext = `${tasks.some((task) => task.contract.ui) ? "Rendered UI visual fidelity. " : ""}${run.prompt}`;
            const selected = chooseReviewer(roster, authors, reviewContext) ?? chooseReviewer([director], authors, reviewContext)!;
            const reviewer = selected.agent;
            const started = now();
            const review = await invokeReview(metered(runId, null, undefined, "quality-review", selected.reason), { reviewer, task: { title: "Final quality review", description: run.prompt, acceptance: run.requirements.map((r) => r.description).join("\n") || run.prompt }, author: "the team", diff: await diffText(cwd, run.baseCommit), cwd, checks: reviewChecks(runId, commit, "acceptance"), onLog: log, signal });
            if (signal.aborted) throw new RunPaused();
            let result: CheckEvidence = { command, ok: review.verdict === "approve", output: review.findings, commit, durationMs: Math.max(0, now() - started) };
            try { await assertWorktreeRevision(cwd, commit); } catch (e) { result = { ...result, ok: false, output: `${result.output}\n${errorText(e)}` }; }
            recordEvidence(runId, null, "acceptance", commit, result, `reviewer:${reviewer.id}`, [], [], run.requirements.map((r) => r.id));
            if (!result.ok) { check = { ...result, command: verify || command }; setRun(runId, { check }); }
          }
        }
      }

      const what = { initial: "the plan", build: "the build plan", recover: "a recovery plan", fix: "the verification", improve: "the next improvement" }[purpose];
      log("system", revision ? `Director is revising ${what}…` : purpose === "fix" ? "Director is verifying the build…" : `Director is drafting ${what}…`);
      proceed(runId);
      const next = await invokeDirector(metered(runId, null, undefined, `director-${purpose}`), {
        director, roster, goal: run.prompt, cwd, rules, onLog: log, signal,
        context: { purpose, stage, tasks: tasks.filter((t) => t.status !== "superseded").map(brief), history: run.history, verify, checkCommand: run.checkCommand, check, finalRound, revision, delivery: run.delivery, requirements: run.requirements, acceptance: JSON.stringify(run.requirements.map((r) => ({ id: r.id, status: requirementStatus(r, db.listEvidence(runId), mustRun(runId).acceptedCommit) }))) },
      });
      if (signal.aborted) return;
      if (finalRound && next.tasks.length) {
        const open = next.tasks.map((t) => `- ${t.title}: ${t.description}`).join("\n");
        setRun(runId, { report: `Unresolved after ${MAX_FIX_ROUNDS} fix rounds.\n\n${next.summary}\n\nOpen items:\n${open}`, checkpoint: "approve", plan: next });
        pauseInternal(runId, "Fix round limit reached");
        return;
      }
      if (purpose === "fix" && next.tasks.length === 0 && check && !check.ok) throw new PlanError("Director accepted a build whose verify command failed");
      const paused = mustRun(runId).status === "pausing";
      const retained = next.tasks.length === 0 ? { ...next, verify } : next;
      const updated = setRun(runId, { ...(paused ? {} : { status: "awaiting_approval" as const }), checkpoint: "approve", plan: retained, error: null });
      // Nothing to approve in an empty fix plan: the director accepted the build.
      if (!paused && (updated.autonomous || (next.stage === "fix" && next.tasks.length === 0))) approve(runId);
    } catch (e) {
      if (signal.aborted || e instanceof RunPaused) return;
      log("error", errorText(e));
      setRun(runId, { ...(mustRun(runId).status === "pausing" ? {} : { status: "failed" as const }), error: errorText(e) });
    } finally {
      inflight.delete(runId);
      settlePause(runId);
    }
  }

  async function startRun(input: { teamId: string; prompt: string; workdir: string; delivery?: DeliveryPolicy; preview?: Run["preview"]; autonomous?: boolean; continuous?: boolean; autoContinueOnRateLimit?: boolean; rateLimitPolicy?: RateLimitPolicy | null; checkCommand?: string; limits?: Run["limits"]; timeouts?: Run["timeouts"] }): Promise<Run> {
    if (input.continuous && !input.autonomous) throw new ConflictError("Continuous improvement requires autonomous execution");
    const timeouts = validateTimeouts(input.timeouts ?? DEFAULT_RUN_TIMEOUTS);
    const delivery = input.delivery ?? db.getDeliveryPolicy(input.workdir);
    if (delivery.strategy === "native") throw new ConflictError("Native delegation cannot reserve descendant calls against this run's budget yet. Choose one worker or an Orchestra team.");
    const team = db.getTeam(input.teamId);
    if (!team) throw new ConflictError("Pick a team for the run: its Director plans and staffs the work.");
    const director = db.getAgent(team.directorId);
    if (!director) throw new ConflictError(`${team.name} has no Director.`);
    if (!team.memberIds.some((id) => id !== director.id)) throw new ConflictError(`Add at least one member to ${team.name} to work under the Director.`);
    const { baseCommit, warning } = await prepareWorkspace(input.workdir);
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `orchestra/${id}`;
    await addWorktree(input.workdir, integrationPath(id), branch, baseCommit);
    const configuration = await configurationFingerprint([director, ...team.memberIds.filter((member) => member !== director.id).flatMap((member) => db.getAgent(member) ?? [])], input.workdir);
    const run = db.createRun({
      id, prompt: input.prompt, workdir: input.workdir, delivery, preview: input.preview, teamId: team.id, directorAgentId: director.id, baseCommit, branch, warning, autonomous: input.autonomous, continuous: input.continuous, autoContinueOnRateLimit: input.autoContinueOnRateLimit, rateLimitPolicy: input.rateLimitPolicy === undefined ? db.getRateLimitPolicy(input.workdir) : input.rateLimitPolicy, checkCommand: input.checkCommand, limits: input.limits === undefined ? DEFAULT_RUN_LIMITS : input.limits, timeouts,
    });
    setRun(run.id, { status: "planning", configuration });
    void previews.refresh(run.id);
    void planRun(run.id);
    return mustRun(run.id);
  }

  /** Guidance accumulates for the whole run; every later agent call receives all of it (see `metered`). */
  function appendGuidance(run: Run, text: string | undefined) {
    const guidance = [run.guidance, text].filter(Boolean).join("\n\n");
    if (guidance.length > 20_000) throw new ConflictError("Accumulated guidance exceeds 20000 characters");
    return guidance;
  }

  function directorChat(runId: string) {
    mustRun(runId);
    return db.listDirectorChat(runId);
  }

  function sendDirectorChat(runId: string, text: string) {
    const run = mustRun(runId);
    if (!text.trim() || text.trim().length > 10_000) throw new ConflictError("Write a question of 1–10000 characters");
    if (chatControllers.has(runId)) throw new ConflictError("Wait for the Director's reply before sending another question");
    const director = db.getAgent(run.directorAgentId);
    if (!director) throw new ConflictError("Director agent no longer exists");
    const turn = db.addDirectorChat(runId, text.trim());
    publish(runId, { type: "director-chat", runId, turn });
    const reply = replyToChat(run, director, turn);
    chatReplies.add(reply);
    void reply.finally(() => chatReplies.delete(reply));
    return turn;
  }

  async function replyToChat(run: Run, director: Agent, turn: DirectorChatTurn) {
    const controller = new AbortController();
    chatControllers.set(run.id, controller);
    const signal = controller.signal;
    const cwd = join(worktreeRoot, run.id, ".chat", "integration");
    let reply = "";
    let error: string | null = null;
    try {
      // Chat never reads the user's checkout or shares a worktree with planning and merges.
      const commit = await localBranchCommit(run.workdir, run.branch);
      await openDetachedWorktree(run.workdir, cwd, commit);
      signal.throwIfAborted();
      const result = await metered(run.id, null, controller)({
        agent: director, mode: "readonly", cwd, signal,
        prompt: directorChatPrompt(director, mustRun(run.id), db.listTasks(run.id).map(brief), directorChat(run.id), db.listEvidence(run.id), commit),
        onLog: () => {},
      });
      signal.throwIfAborted();
      if (!result.ok) throw new Error(result.error || "The Director could not reply. Send your question again.");
      if (!result.text.trim()) throw new Error("The Director returned an empty reply. Send your question again.");
      reply = clip(result.text.trim(), 50_000);
    } catch (e) {
      error = signal.aborted ? (signal.reason instanceof Error && signal.reason.name !== "AbortError" ? signal.reason.message : "Reply stopped. You can send your question again.") : errorText(e);
    } finally {
      try { await removeWorktree(run.workdir, cwd); }
      catch (e) { logger(run.id, null)("error", `Chat worktree cleanup failed: ${errorText(e)}`); }
      chatControllers.delete(run.id);
      publish(run.id, { type: "director-chat", runId: run.id, turn: db.finishDirectorChat(turn.id, reply, error) });
      settlePause(run.id);
    }
  }

  /** Steers an active run without pausing it: the next agent call picks the note up. */
  function addGuidance(runId: string, text: string) {
    const run = mustRun(runId);
    if (!["planning", "running", "awaiting_approval"].includes(run.status)) {
      throw new ConflictError("Only an active run takes notes; use resume to add guidance to a paused run");
    }
    const updated = setRun(runId, { guidance: appendGuidance(run, text) });
    logger(runId, null)("system", `Guidance from you: ${text}`);
    for (const [invocationId, active] of controls) if (active.runId === runId) {
      void active.control.steer(text).then(() => {
        const event = db.recordAgentEvent({ id: crypto.randomUUID(), runId, taskId: active.taskId, agentId: active.agentId, invocationId, parentId: invocationId, kind: "steering", text: "The running agent received the new guidance.", ts: now() });
        publish(runId, { type: "agent-event", runId, event });
      }).catch(() => logger(runId, active.taskId)("system", "Live guidance could not be delivered; it is saved for the next invocation."));
    }
    return updated;
  }

  /**
   * Sends the user's feedback to the director from any point between plans: a plan awaiting approval is revised,
   * failed planning is retried, failed tasks are re-planned, and a completed run gets a round of fixes.
   */
  function revise(runId: string, feedback: string) {
    const run = mustRun(runId);
    if (!["awaiting_approval", "failed", "completed"].includes(run.status)) {
      throw new ConflictError("Only a run that is between plans can be re-planned");
    }
    const previous = run.status === "awaiting_approval" ? (run.plan ?? undefined) : undefined;
    const guidance = appendGuidance(run, feedback);
    const reopened: RunPatch = run.status === "completed" ? { fixRounds: 0, report: null, purpose: null, planningPhase: "check", check: null } : {};
    const updated = setRun(runId, { status: "planning", checkpoint: "plan", guidance, error: null, ...reopened });
    void planRun(runId, { feedback, previous });
    return updated;
  }

  /** Replaces the plan awaiting approval with the user's edited version, under the same rules as the director's. */
  function editPlan(runId: string, raw: unknown) {
    const run = mustRun(runId);
    if (run.status !== "awaiting_approval") throw new ConflictError("Only a plan awaiting approval can be edited");
    try {
      const plan = validatePlan(raw, teamIds(run), { ...planning(run, db.listTasks(runId)).rules, allowRequirementAmendment: true });
      const requirements = mergeRequirements(run.requirements, plan.requirements ?? [], now());
      logger(runId, null)("system", "The user edited the plan and its acceptance contract. Earlier evidence remains in history.");
      return setRun(runId, { plan, requirements });
    } catch (e) {
      throw new ConflictError(errorText(e));
    }
  }

  function approve(runId: string) {
    const run = mustRun(runId);
    if (run.status !== "awaiting_approval" || !run.plan) throw new ConflictError("Run is not awaiting approval");
    const tasks = db.listTasks(runId);
    const { purpose, rules } = planning(run, tasks);
    let plan: Plan;
    try {
      // Agents may have changed since planning.
      plan = validatePlan(run.plan, teamIds(run), rules);
      if (run.delivery.profile === "quality" && plan.stage !== "definition") {
        const roster = rosterOf(run);
        plan = { ...plan, tasks: plan.tasks.map((task) => ({ ...task, reviewerId: task.reviewerId || chooseReviewer(roster, new Set([task.agentId]), `${task.contract?.ui ? "Rendered UI visual fidelity. " : ""}${task.title} ${task.description} ${task.acceptanceCriteria}`)?.agent.id || "" })) };
        plan = validatePlan(plan, teamIds(run), rules);
      }
    } catch (e) {
      throw new ConflictError(`${errorText(e)}\nRevise the plan.`);
    }
    const requirements = mergeRequirements(run.requirements, plan.requirements ?? [], now());
    const history = [...run.history, { cycle: run.cycle, createdAt: now(), plan, report: null as string | null }];
    setRun(runId, { history, requirements });
    logger(runId, null)("system", `Cycle ${run.cycle}: ${plan.summary}`);
    if (plan.tasks.length === 0) {
      if (run.check && !run.check.ok && purpose !== "improve") throw new ConflictError("Cannot accept a build with failing verification");
      if (plan.verify && purpose !== "improve" && (run.check?.command !== plan.verify || run.check.commit !== run.acceptedCommit)) throw new ConflictError("Run the verification command on the current accepted revision before accepting this plan.");
      const unmet = requirements.filter((r) => r.required && requirementStatus(r, db.listEvidence(runId), run.acceptedCommit) !== "satisfied");
      if (unmet.length) throw new ConflictError(`Cannot accept unmet requirements: ${unmet.map((r) => r.id).join(", ")}. Run acceptance checks on the current revision first.`);
      history[history.length - 1]!.report = plan.summary;
      const at = now();
      setRun(runId, { history, ...(!run.firstAccepted ? { firstAccepted: { at, elapsedMs: run.activeElapsedMs + (run.activeSince === null ? 0 : at - run.activeSince), commit: run.acceptedCommit } } : {}) });
      if (plan.lessons.trim() && run.acceptedCommit) db.proposeLessons(runId, run.acceptedCommit, plan.lessons);
      if (!run.continuous || purpose === "improve") {
        const previous = run.history.findLast((entry) => entry.report)?.report;
        return complete(runId, purpose === "improve" && previous ? `${previous}\n\n${plan.summary}` : plan.summary);
      }
      const updated = setRun(runId, { status: "planning", checkpoint: "plan", purpose: "improve", planningPhase: "check", check: null, report: plan.summary, cycle: run.cycle + 1, fixRounds: 0 });
      queueMicrotask(() => { if (db.getRun(runId)?.status === "planning") void planRun(runId); });
      return updated;
    }

    if (purpose === "recover") supersede(run, tasks);
    db.insertTasks(runId, plan, run.cycle);
    for (const task of db.listTasks(runId)) publish(runId, { type: "task", task });
    const recommendation = recommendStrategy(run.delivery, plan, db.listRuns().filter((r) => r.id !== runId && r.workdir === run.workdir && r.configuration === run.configuration));
    const updated = setRun(runId, { status: "running", checkpoint: "execute", purpose: null, plan, recommendation, ...(purpose === "fix" && { fixRounds: run.fixRounds + 1 }) });
    tick(runId);
    return updated;
  }

  function complete(runId: string, report: string) {
    const run = setRun(runId, { status: "completed", report, error: null });
    cleanups.set(runId, Promise.all([removeWorktree(run.workdir, integrationPath(runId)), removeWorktree(run.workdir, join(worktreeRoot, runId, ".acceptance", "integration"))])
      .catch((e) => logger(runId, null)("error", `Worktree cleanup failed: ${errorText(e)}`))
      .finally(() => cleanups.delete(runId)));
    return run;
  }

  /** Retires work a recovery plan replaces, with the worktrees its failed attempts left behind. */
  function supersede(run: Run, tasks: Task[]) {
    for (const t of tasks) {
      if (!["failed", "blocked", "pending"].includes(t.status)) continue;
      setTask(t.id, { status: "superseded", feedback: null });
      const cleanup = removeWorktree(run.workdir, taskPath(t))
        .then(() => deleteBranch(run.workdir, taskBranch(run, t)))
        .catch((e) => logger(run.id, null)("error", `Worktree cleanup failed: ${errorText(e)}`))
        .finally(() => retired.delete(cleanup));
      retired.add(cleanup);
    }
  }

  /** Starts every task whose dependencies are done, up to the parallel cap; finishes the run when nothing is left. */
  function tick(runId: string) {
    const run = db.getRun(runId);
    if (run?.status !== "running") return;
    const tasks = db.listTasks(runId);
    const done = new Set(tasks.filter((t) => t.status === "done").map((t) => t.key));
    const running = tasks.filter((t) => t.status === "running").length;
    const activeRuns = db.listRuns().filter((r) => ["running", "pausing"].includes(r.status));
    const active = activeRuns.flatMap((r) => db.listTasks(r.id).filter((t) => t.status === "running").map((task) => ({ run: r, task })));
    const rank = (key: string, seen = new Set<string>()): number => {
      if (seen.has(key)) return 0;
      seen.add(key);
      return 1 + Math.max(0, ...tasks.filter((t) => t.status === "pending" && t.dependsOn.includes(key)).map((t) => rank(t.key, new Set(seen))));
    };
    const ready = tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => done.has(d))).sort((a, b) => rank(b.key) - rank(a.key));
    let launched = 0;
    for (const task of ready) {
      const ceiling = parallelism(run);
      const pipelineCeiling = ceiling === 1 ? 1 : ceiling * 2;
      if (running + launched >= pipelineCeiling || active.length >= MAX_GLOBAL_WORKERS * 2) break;
      const working = active.filter((a) => a.task.phase === "work");
      if (working.length >= MAX_GLOBAL_WORKERS || working.filter((a) => a.run.id === runId).length >= ceiling) break;
      const runtime = db.getAgent(task.agentId)?.runtime;
      if (working.filter((a) => db.getAgent(a.task.agentId)?.runtime === runtime).length >= MAX_PROVIDER_WORKERS) continue;
      if (active.some((a) => projectIdentity(a.run.workdir) === projectIdentity(run.workdir) && tasksOverlap(a.task, task))) continue;
      active.push({ run, task });
      launched++;
      void execute(run, task);
    }
    if (running === 0 && ready.length === 0) finish(run, tasks);
  }

  function tickAll() {
    const runs = db.listRuns().filter((r) => r.status === "running");
    if (!runs.length) return;
    schedulingCursor = (schedulingCursor + 1) % runs.length;
    for (let i = 0; i < runs.length; i++) tick(runs[(schedulingCursor + i) % runs.length]!.id);
  }

  /** The run went quiet: re-plan around failures, or plan what follows the finished stage (build or verification). */
  function finish(run: Run, tasks: Task[]) {
    const failed = tasks.filter((t) => t.status === "failed").length;
    if (failed || tasks.some((t) => t.status === "blocked")) {
      if (run.autonomous && run.recoveries < MAX_RECOVERIES) {
        setRun(run.id, { status: "planning", checkpoint: "plan", planningPhase: "check", check: null, recoveries: run.recoveries + 1, error: null });
        logger(run.id, null)("system", `${failed} task(s) failed; the Director re-plans the remaining work.`);
        void planRun(run.id);
      } else {
        if (run.autonomous) {
          setRun(run.id, { checkpoint: "execute", report: `${failed} task(s) need attention. Choose Continue remaining work to let the team use its saved work and review feedback. Completed work and consumed budgets are preserved.` });
          pauseInternal(run.id, "Recovery limit reached");
        } else setRun(run.id, { status: "failed", error: `${failed} task(s) failed. Retry them or ask the Director to re-plan.` });
      }
      return;
    }
    setRun(run.id, { status: "planning", checkpoint: "plan", planningPhase: "check", check: null, error: null });
    void planRun(run.id);
  }

  async function execute(run: Run, task: Task) {
    // Synchronous before the first await, so a concurrent tick() cannot start the same task twice.
    task = setTask(task.id, { status: "running", startedAt: task.startedAt ?? now(), finishedAt: null, error: null });
    const log = logger(run.id, task.id);
    const signal = track(task.id, run.id);
    const branch = taskBranch(run, task);
    const cwd = taskPath(task);
    try {
      if (task.key === "integration") throw new Error("Task id integration is reserved for the accepted worktree; re-plan this task with a different id.");
      proceed(run.id);
      const agent = db.getAgent(task.agentId);
      if (!agent) throw new Error("Assigned agent no longer exists");
      const missingSkills = task.contract.skillIds?.filter((id) => !agent.skills.some((skill) => skill.id === id)) ?? [];
      if (missingSkills.length) throw new Error(`Assigned agent no longer has the task's selected skills: ${missingSkills.join(", ")}. Restore them or revise the assignment.`);
      const reviewer = task.reviewerId ? db.getAgent(task.reviewerId) : null;
      if (task.reviewerId && !reviewer) throw new Error("Assigned reviewer no longer exists");
      if (reviewer && authorsOf([task]).has(reviewer.id)) throw new Error("The assigned reviewer previously authored this task; choose an independent reviewer");
      const verify = run.plan?.verify ?? "";
      if (!existsSync(cwd)) {
        await addWorktree(run.workdir, cwd, branch, await headCommit(integrationPath(run.id)));
        log("system", `${agent.name} started on branch ${branch}`);
      } else log("system", `${agent.name} continues at ${task.phase} on branch ${branch}`);
      const start = task.startCommit ?? await mergeBase(cwd, "HEAD", run.branch);
      task = setTask(task.id, { startCommit: start, ...(Object.keys(task.contextVersions).length || !task.contract.inputs.length ? {} : { contextVersions: await fingerprintInputs(cwd, "HEAD", task.contract.inputs) }) });
      const deps = db.listTasks(run.id).filter((t) => task.dependsOn.includes(t.key));
      if (deps.length) logger(run.id, null)("system", `Handoff to ${agent.name} for ${task.key} from ${deps.map((d) => d.key).join(", ")}; their work is merged.`);
      const evidence = () => task.handoff ?? { text: task.summary ?? "", files: [], check: null, review: null };
      const problems = (problem: string) => {
        if (task.iterations >= MAX_ITERATIONS) throw new Error(`Still failing after ${MAX_ITERATIONS} attempts:\n${problem}`);
        log("system", `Sending the problems back to ${agent.name} (attempt ${task.iterations + 1} of ${MAX_ITERATIONS})`);
        task = setTask(task.id, { phase: "work", feedback: problem });
      };
      while (task.phase !== "done") {
        // Completed worker calls may commit their result even when a pause was requested.
        if (task.phase !== "commit") proceed(run.id);
        if (signal.aborted) throw new RunPaused();
        switch (task.phase) {
          case "work": {
            const current = mustRun(run.id);
            const prompt = task.session && task.feedback ? (task.iterations ? fixPrompt(task.feedback) : retryPrompt(task.feedback)) + taskContractPrompt(current, task) : workerPrompt(current, task, agent, reviewer, deps, verify, task.feedback);
            const res = await metered(run.id, task.id, undefined, "work")({ agent, mode: "worker", prompt, cwd, schema: handoffJsonSchema, resume: task.session ?? undefined, onLog: log, signal });
            if (res.session) task = setTask(task.id, { session: res.session });
            if (signal.aborted) throw new RunPaused();
            if (!res.ok) {
              if (task.session && !res.usage?.tokens) setTask(task.id, { session: null });
              task = setTask(task.id, { feedback: res.error ?? "agent failed" });
              throw new Error(res.error ?? "agent failed");
            }
            const handoff = workerHandoff(res, agent.skills.filter((skill) => task.contract.skillIds === undefined || task.contract.skillIds.includes(skill.id)).map((skill) => skill.id));
            task = setTask(task.id, { iterations: task.iterations + 1, summary: handoff.text || task.summary || "(no summary)", phase: "commit", feedback: null, handoff: { ...handoff, files: [], check: null, review: null } });
            break;
          }
          case "commit": {
            const changed = await commitAll(cwd, `${task.key}: ${task.title} (attempt ${task.iterations})`);
            log("system", changed ? "Committed changes" : "No file changes");
            const files = (await diffFiles(cwd, start, "HEAD")).map((f) => f.path);
            const undeclared = task.contract.outputs.length ? files.filter((file) => !task.contract.outputs.some((path) => file === path || file.startsWith(`${path}/`))) : [];
            if (undeclared.length) log("system", `Observed changes beyond the declared outputs: ${undeclared.join(", ")}. Scheduling claims now include these paths.`);
            task = setTask(task.id, { phase: "check", contract: { ...task.contract, outputs: [...new Set([...task.contract.outputs, ...files])] }, handoff: { ...evidence(), files } });
            break;
          }
          case "check": {
            if (verify) {
              log("system", `Running the verify command: ${verify}`);
              const started = now();
              const commit = await headCommit(cwd);
              let result = await runCheckFor(run.id, cwd, verify, signal, mustRun(run.id).timeouts.checkMs);
              if (signal.aborted) throw new RunPaused();
              try { await assertWorktreeRevision(cwd, commit); } catch (e) { result = { ok: false, output: `${result.output}\n${errorText(e)}` }; }
              const check: CheckEvidence = { ...result, commit, durationMs: Math.max(0, now() - started), producer: "orchestra:task", command: verify };
              recordEvidence(run.id, task.id, "task", commit, check, "orchestra:task", task.contract.requirementIds);
              task = setTask(task.id, { handoff: { ...evidence(), check } });
              if (!check.ok) { problems(`The verify command \`${verify}\` failed:\n${check.output.trim()}`); break; }
              log("system", "Verify command passed");
            }
            task = setTask(task.id, { phase: "review" });
            break;
          }
          case "review": {
            if (reviewer) {
              log("system", `${reviewer.name} is reviewing the change`);
              const commit = await headCommit(cwd);
              let review = await invokeReview(metered(run.id, task.id, undefined, "task-review"), { reviewer, task, author: agent.name, diff: await diffText(cwd, start), cwd, checks: reviewChecks(run.id, commit, "task"), onLog: log, signal });
              try { await assertWorktreeRevision(cwd, commit); } catch (e) { review = { verdict: "changes", findings: `${review.findings}\n${errorText(e)}` }; }
              audit({ kind: "task-review", runId: run.id, taskId: task.id, agentId: task.agentId, reviewerId: reviewer.id, attempt: task.attempt, phase: "review", commit, verdict: review.verdict, findings: review.findings });
              recordEvidence(run.id, task.id, "task", commit, { command: "independent task review", ok: review.verdict === "approve", output: review.findings }, `reviewer:${reviewer.id}`, task.contract.requirementIds);
              if (signal.aborted) throw new RunPaused();
              task = setTask(task.id, { handoff: { ...evidence(), review } });
              if (review.verdict === "changes") { problems(`${reviewer.name} (${reviewer.role}) reviewed your change and requested changes:\n${review.findings}`); break; }
              log("system", `${reviewer.name} approved the change`);
            }
            task = setTask(task.id, { phase: "merge" });
            break;
          }
          case "merge": {
            let mergeCommit: string | null;
            try {
              mergeCommit = await withMergeLock(run.id, async () => {
                proceed(run.id);
                if (task.contract.inputs.length) {
                  const accepted = await headCommit(integrationPath(run.id));
                  const receipt = await taskMergeCommit(integrationPath(run.id), task.startCommit ?? run.baseCommit, `Merge ${task.key}: ${task.title}`);
                  if (receipt) return receipt;
                  const versions = await fingerprintInputs(cwd, accepted, task.contract.inputs);
                  const changed = task.contract.inputs.filter((path) => task.contextVersions[path] !== versions[path]);
                  if (changed.length) {
                    const inputs = await describeInputs(cwd, accepted, changed);
                    task = setTask(task.id, { contextVersions: versions });
                    throw new IntegrationProblem(`Your declared inputs changed while you worked. The accepted revision is ${accepted}. Your result has been withheld until you reconcile it with this context and rerun checks.\n\n${inputs}\nUpdate your private task branch as needed using these exact Git objects. The accepted integration worktree belongs to Orchestra.`);
                  }
                }
                return merge(run, task, agent, branch, signal, log, (integration) => {
                  task = setTask(task.id, { handoff: { ...evidence(), integration } });
                });
              });
            } catch (e) {
              if (!(e instanceof IntegrationProblem)) throw e;
              problems(e.message);
              break;
            }
            task = setTask(task.id, { phase: "done", mergeCommit, status: "done", finishedAt: now() });
            logger(run.id, null)("system", `${agent.name} finished ${task.key}; checked work and handoff are available to the team.`);
            await removeWorktree(run.workdir, cwd);
            await deleteBranch(run.workdir, branch);
            break;
          }
        }
      }
    } catch (e) {
      const status = mustRun(run.id).status;
      if (status === "pausing" || status === "paused" || e instanceof RunPaused && status !== "cancelled") {
        setTask(task.id, { status: "pending" });
      } else if (signal.aborted || status === "cancelled") {
        setTask(task.id, { status: "cancelled", finishedAt: now() });
      } else {
        log("error", errorText(e));
        setTask(task.id, { status: "failed", error: errorText(e), finishedAt: now() });
        blockDependents(run.id, task.key);
      }
    } finally {
      inflight.delete(task.id);
      settlePause(run.id);
      tickAll();
    }
  }

  /** Checks a detached candidate before the accepted run branch can advance. */
  async function merge(run: Run, task: Task, agent: Agent, branch: string, signal: AbortSignal, log: (k: LogKind, t: string) => void, save: (integration: NonNullable<Handoff["integration"]>) => void) {
    if (signal.aborted) throw new Error("cancelled");
    const accepted = integrationPath(run.id);
    const cwd = candidatePath(run.id);
    const before = await headCommit(accepted);
    const message = `Merge ${task.key}: ${task.title}`;
    const receipt = await taskMergeCommit(accepted, task.startCommit ?? run.baseCommit, message);
    if (receipt) return receipt;
    let state = task.handoff?.integration;
    let reusable = false;
    if (state?.baselineCommit === before && existsSync(cwd)) {
      try { await assertWorktreeRevision(cwd, state.candidateCommit); reusable = true; } catch { /* Rebuild an interrupted or altered candidate. */ }
    }
    if (!reusable) {
      await openDetachedWorktree(run.workdir, cwd, before);
      const { conflicts } = await mergeBranch(cwd, branch, message);
      if (conflicts.length) {
        log("system", `Merge conflict in ${conflicts.join(", ")}; ${agent.name} is resolving an isolated candidate`);
        try {
          const selectedSkills = agent.skills.filter((skill) => task.contract.skillIds === undefined || task.contract.skillIds.includes(skill.id));
          const prompt = conflictPrompt(task, conflicts) + skillsPrompt(selectedSkills) + taskContractPrompt(mustRun(run.id), task, false);
          const res = await metered(run.id, task.id, undefined, "conflict-resolution")({ agent, mode: "worker", prompt, cwd, onLog: log, signal });
          if (signal.aborted || !res.ok || !(await concludeMerge(cwd, conflicts))) {
            throw new Error(signal.aborted ? "cancelled" : `Could not resolve merge conflict in ${conflicts.join(", ")}`);
          }
        } catch (e) {
          await abortMerge(cwd);
          throw e;
        }
        log("system", "Merge conflict resolved; the candidate needs fresh checks and independent review");
      }
      state = { baselineCommit: before, candidateCommit: await headCommit(cwd), conflictResolved: conflicts.length > 0, check: null, review: null };
      save(state);
    }
    if (!state) throw new Error("Missing integration candidate checkpoint");
    const verify = run.plan?.verify ?? "";
    if (verify && (!state.check?.ok || state.check.command !== verify || state.check.commit !== state.candidateCommit)) {
      log("system", `Checking integration candidate ${state.candidateCommit}: ${verify}`);
      const started = now();
      let result = await runCheckFor(run.id, cwd, verify, signal, mustRun(run.id).timeouts.checkMs);
      if (signal.aborted) throw new RunPaused();
      try { await assertWorktreeRevision(cwd, state.candidateCommit); }
      catch (e) { result = { ok: false, output: `${result.output}\n${errorText(e)}` }; }
      state = { ...state, check: { command: verify, ...result, commit: state.candidateCommit, producer: "orchestra:integration", durationMs: Math.max(0, now() - started) } };
      save(state);
      recordEvidence(run.id, task.id, "integration", state.candidateCommit, state.check!, "orchestra:integration", task.contract.requirementIds);
      if (!result.ok) {
        const diagnosis = await diagnoseIntegration(run, task, before, await headCommit(taskPath(task)), verify, signal, log);
        throw new IntegrationProblem(`The integration verify command failed on candidate ${state.candidateCommit}. The accepted revision ${before} is unchanged.\nReproduce with \`${verify}\` using the candidate at ${cwd}.\n${result.output.trim()}\n\n${diagnosis}\nRepair your task branch to work with the accepted revision; do not modify the accepted integration worktree.`);
      }
    }
    if (state.conflictResolved && state.review?.verdict !== "approve") {
      const authors = authorsOf([task]);
      const reviewers = rosterOf(mustRun(run.id)).filter((member) => !authors.has(member.id));
      const reviewer = (task.reviewerId && !authors.has(task.reviewerId) && db.getAgent(task.reviewerId)) || chooseReviewer(reviewers, authors, `${task.contract.ui ? "Rendered UI visual fidelity. " : ""}${task.title} ${task.description}`)?.agent;
      if (!reviewer) throw new IntegrationProblem("The conflict resolution needs an independent reviewer. Add another team member or assign a reviewer before retrying.");
      log("system", `${reviewer.name} is independently reviewing the resolved integration candidate`);
      let review = await invokeReview(metered(run.id, task.id, undefined, "integration-review"), { reviewer, task, author: agent.name, diff: await diffText(cwd, before), cwd, checks: reviewChecks(run.id, state.candidateCommit, "integration"), onLog: log, signal });
      if (signal.aborted) throw new RunPaused();
      try { await assertWorktreeRevision(cwd, state.candidateCommit); }
      catch (e) { review = { verdict: "changes", findings: `${review.findings}\n${errorText(e)}` }; }
      state = { ...state, review };
      save(state);
      recordEvidence(run.id, task.id, "integration", state.candidateCommit, { command: "independent integration review", ok: review.verdict === "approve", output: review.findings }, `reviewer:${reviewer.id}`, task.contract.requirementIds);
      if (review.verdict === "changes") throw new IntegrationProblem(`${reviewer.name} requested changes to the integration candidate:\n${review.findings}\nThe accepted revision is unchanged. Repair your task branch to account for ${before}.`);
    }
    if (signal.aborted) throw new RunPaused();
    const acceptanceProblems = await checkRequirements(run.id, cwd, "integration", signal, task.id, false, state.check);
    if (acceptanceProblems.length) throw new IntegrationProblem(`The integration candidate did not satisfy its requirements:\n${acceptanceProblems.join("\n")}\nThe accepted revision ${before} is unchanged. Repair your task branch.`);
    try {
      await publishCandidate(accepted, cwd, before, state.candidateCommit);
    } catch (e) {
      throw new IntegrationProblem(errorText(e));
    }
    setRun(run.id, { acceptedCommit: state.candidateCommit });
    void previews.refresh(run.id);
    await removeWorktree(run.workdir, cwd);
    return state.candidateCommit === before ? null : state.candidateCommit;
  }

  async function diagnoseIntegration(run: Run, task: Task, baseline: string, isolated: string, command: string, signal: AbortSignal, log: (k: LogKind, t: string) => void) {
    const path = join(worktreeRoot, run.id, ".diagnosis", "integration");
    const probes: string[] = [];
    const revisions = [{ name: "accepted baseline", commit: baseline }, { name: "isolated task", commit: isolated }].slice(0, MAX_INTEGRATION_PROBES);
    try {
      for (const revision of revisions) {
        proceed(run.id);
        await openDetachedWorktree(run.workdir, path, revision.commit);
        const started = now();
        log("system", `Diagnosing integration: replaying ${revision.name} ${revision.commit}`);
        const latest = mustRun(run.id);
        const remaining = latest.limits ? latest.limits.maxDurationMs - elapsed(latest) : INTEGRATION_PROBE_TIMEOUT_MS;
        let result = await runCheckFor(run.id, path, command, signal, Math.max(1, Math.min(INTEGRATION_PROBE_TIMEOUT_MS, remaining, latest.timeouts.checkMs)));
        if (signal.aborted) throw new RunPaused();
        try { await assertWorktreeRevision(path, revision.commit); }
        catch (e) { result = { ok: false, output: `${result.output}\n${errorText(e)}` }; }
        const check: CheckEvidence = { command, ...result, commit: revision.commit, durationMs: Math.max(0, now() - started) };
        recordEvidence(run.id, task.id, "diagnosis", revision.commit, check, `orchestra:diagnosis:${revision.name}`);
        probes.push(`${revision.name} ${revision.commit}: ${result.ok ? "passed" : `failed\n${result.output.trim()}`}`);
      }
    } finally {
      await removeWorktree(run.workdir, path);
    }
    const acceptedTasks = db.listTasks(run.id).filter((entry) => entry.status === "done" && entry.mergeCommit).map((entry) => `${entry.key} (${entry.mergeCommit})`).join(", ");
    return `Bounded diagnosis (${probes.length}/${MAX_INTEGRATION_PROBES} probes):\n${probes.join("\n")}\nAccepted tasks: ${acceptedTasks || "none"}. Failing combination: accepted baseline + ${task.key} (${isolated}). This identifies the tested combination, not a minimal cause.`;
  }

  function dependentsOf(runId: string, key: string): Task[] {
    const tasks = db.listTasks(runId);
    const found = new Set<string>([key]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const t of tasks) {
        if (!found.has(t.key) && t.dependsOn.some((d) => found.has(d))) {
          found.add(t.key);
          grew = true;
        }
      }
    }
    return tasks.filter((t) => t.key !== key && found.has(t.key));
  }

  function blockDependents(runId: string, key: string) {
    for (const t of dependentsOf(runId, key)) {
      if (t.status === "pending") setTask(t.id, { status: "blocked", error: `Waiting on failed task "${key}"` });
    }
  }

  /**
   * Runs a failed task again. The agent resumes its conversation with the error and the user's instructions;
   * a reassigned task starts a new conversation with its earlier work intact.
   */
  function retry(taskId: string, opts: { instructions?: string; agentId?: string } = {}) {
    const task = db.getTask(taskId);
    if (!task) throw new NotFoundError("Task not found");
    const run = mustRun(task.runId);
    if (task.status !== "failed" || !["running", "failed"].includes(run.status)) throw new ConflictError("Only failed tasks can be retried");
    const agentId = opts.agentId ?? task.agentId;
    const reassigned = agentId !== task.agentId;
    if (reassigned && !teamIds(run).has(agentId)) throw new ConflictError("Assign the task to a member of the run's team other than the Director");
    if (agentId === task.reviewerId) throw new ConflictError("The task's reviewer can't also be its assignee");
    const missingSkills = task.contract.skillIds?.filter((id) => !db.getAgent(agentId)?.skills.some((skill) => skill.id === id)) ?? [];
    if (missingSkills.length) throw new ConflictError(`The replacement needs this task's selected skills: ${missingSkills.join(", ")}. Add them before retrying.`);

    const feedback = [
      task.error && `The previous attempt failed:\n${task.error}`,
      opts.instructions && `Instructions from the user:\n${opts.instructions}`,
    ].filter(Boolean).join("\n\n");
    setTask(task.id, {
      status: "pending", phase: "work", iterations: 0, handoff: null, agentId, error: null, feedback: feedback || null, session: reassigned ? null : task.session, startedAt: null, finishedAt: null,
      attempt: task.attempt + 1, previousAgentIds: [...authorsOf([task])].filter((id) => id !== agentId),
    });
    for (const t of dependentsOf(run.id, task.key)) {
      if (t.status === "blocked") setTask(t.id, { status: "pending", error: null });
    }
    if (run.status !== "running") setRun(run.id, { status: "running", checkpoint: "execute", purpose: null, error: null });
    tick(run.id);
    return db.getTask(task.id)!;
  }

  function cancel(runId: string) {
    const run = mustRun(runId);
    if (!["planning", "awaiting_approval", "running", "pausing", "paused"].includes(run.status)) throw new ConflictError("Run is already finished");
    const updated = setRun(runId, { status: "cancelled" });
    chatControllers.get(runId)?.abort();
    for (const t of db.listTasks(runId)) {
      if (t.status === "pending" || t.status === "blocked") setTask(t.id, { status: "cancelled" });
    }
    for (const { runId: owner, controller } of inflight.values()) {
      if (owner === runId) controller.abort();
    }
    return updated;
  }

  function pause(runId: string) {
    if (!["planning", "running", "awaiting_approval"].includes(mustRun(runId).status)) throw new ConflictError("Only an active run can be paused");
    return pauseInternal(runId, "Paused by user");
  }

  function rememberCapacityLimit(runId: string, agent: Agent, reason: string) {
    const run = mustRun(runId);
    setRun(runId, { capacityLimits: [...run.capacityLimits.filter((limit) => limit.runtime !== agent.runtime), { agentId: agent.id, runtime: agent.runtime, reason, rerouted: false }] });
  }

  function capacityLimitsOf(run: Run): CapacityLimit[] {
    if (run.capacityLimits.length) return run.capacityLimits;
    if (!run.quotaWait && !run.rateLimitResumeAt && rateLimitRetryAt(`${run.pauseReason ?? ""} ${run.error ?? ""}`, now()) === null) return [];
    // Older checkpoints retained the triggering agent in quota waits or invocation events.
    const events = db.listAgentEvents(run.id);
    const failed = events.findLast((event) => event.kind === "failed" && rateLimitRetryAt(event.text, now()) !== null) ?? events.findLast((event) => event.kind === "failed");
    const agent = db.getAgent(run.quotaWait?.agentId ?? failed?.agentId ?? "");
    return agent ? [{ agentId: agent.id, runtime: agent.runtime, reason: run.pauseReason ?? run.error ?? "Provider limit reached", rerouted: false }] : [];
  }

  function assertCapacityStopped(run: Run) {
    if (!["paused", "failed"].includes(run.status) || [...inflight.values()].some((entry) => entry.runId === run.id)) throw new ConflictError("Wait for the run to pause before moving tasks");
  }

  async function capacityProposal(runId: string): Promise<CapacityProposal> {
    const run = mustRun(runId);
    assertCapacityStopped(run);
    const limits = capacityLimitsOf(run);
    const blocked = new Set(limits.map((limit) => limit.runtime));
    const director = db.getAgent(run.directorAgentId);
    const directorBlocked = !!director && blocked.has(director.runtime);
    const candidates = rosterOf(run).filter((agent) => !blocked.has(agent.runtime));
    const agents: CapacityProposal["agents"] = [];
    if (limits.length) await Promise.all(candidates.map(async (agent) => {
      try {
        const windows = await quota(agent);
        const policy = run.rateLimitPolicy ?? agent.rateLimitPolicy ?? db.getGlobalRateLimitPolicy();
        const guarded = windows.filter((window) => !policy || policy.window === "both" || window.window === policy.window);
        if (!guarded.length || !windows.length || windows.some((window) => !Number.isFinite(window.usedPercent) || window.usedPercent < 0 || window.usedPercent >= 100 || !Number.isFinite(window.resetsAt) || window.resetsAt <= now()) || guarded.some((window) => window.usedPercent >= (policy?.maxUsedPercent ?? 100))) return;
        agents.push({ id: agent.id, name: agent.name, role: agent.role, runtime: agent.runtime, windows, ceiling: policy?.maxUsedPercent ?? 100 });
      } catch { /* Unknown quota is not evidence of available capacity. */ }
    }));
    const assignments: CapacityProposal["assignments"] = [];
    if (run.checkpoint === "execute") for (const task of db.listTasks(runId)) {
      if (!["pending", "failed", "blocked"].includes(task.status)) continue;
      for (const kind of ["worker", "reviewer"] as const) {
        const fromAgentId = kind === "worker" ? task.agentId : task.reviewerId;
        const from = fromAgentId ? db.getAgent(fromAgentId) : null;
        if (!from || !blocked.has(from.runtime)) continue;
        const authors = authorsOf([task]);
        const candidateIds = agents.filter((agent) => kind === "worker" ? agent.id !== task.reviewerId && (task.contract.skillIds ?? []).every((id) => db.getAgent(agent.id)?.skills.some((skill) => skill.id === id)) : !authors.has(agent.id))
          .sort((a, b) => Number(b.role === from.role) - Number(a.role === from.role) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id)).map((agent) => agent.id);
        assignments.push({ taskId: task.id, key: task.key, title: task.title, kind, fromAgentId: from.id, fromAgentName: from.name, candidateIds });
      }
    }
    return { limits, agents, assignments, directorBlocked };
  }

  async function transferCapacity(runId: string, transfers: CapacityTransfer[]) {
    const before = mustRun(runId);
    assertCapacityStopped(before);
    const snapshot = JSON.stringify({ run: before, tasks: db.listTasks(runId), team: db.getTeam(before.teamId ?? ""), agents: db.listAgents(), policy: db.getGlobalRateLimitPolicy() });
    // Recheck quota when applying; an earlier proposal never authorizes a stale transfer.
    const proposal = await capacityProposal(runId);
    const run = mustRun(runId);
    assertCapacityStopped(run);
    if (snapshot !== JSON.stringify({ run, tasks: db.listTasks(runId), team: db.getTeam(run.teamId ?? ""), agents: db.listAgents(), policy: db.getGlobalRateLimitPolicy() })) throw new ConflictError("The run or team changed. Refresh the transfer proposal");
    const key = (value: Pick<CapacityTransfer, "taskId" | "kind">) => `${value.taskId}:${value.kind}`;
    if (!transfers.length || transfers.length !== proposal.assignments.length || new Set(transfers.map(key)).size !== transfers.length) throw new ConflictError("Choose a replacement for every affected assignment");
    const patches = new Map<string, TaskPatch>();
    for (const transfer of transfers) {
      const assignment = proposal.assignments.find((entry) => key(entry) === key(transfer));
      if (!assignment || assignment.fromAgentId !== transfer.fromAgentId || !assignment.candidateIds.includes(transfer.agentId)) throw new ConflictError("A replacement is no longer available. Refresh the transfer proposal");
      const task = db.getTask(transfer.taskId)!;
      const patch = patches.get(task.id) ?? {};
      if (transfer.kind === "worker") {
        const handoff = `This task was transferred from ${agentName(task.agentId)} after an account limit. Continue from the existing files and saved checkpoint (${task.phase}); preserve earlier work.\nSaved handoff: ${clip(task.summary ?? task.handoff?.text ?? "No summary yet", 3000)}\n${task.feedback ?? ""}`;
        Object.assign(patch, { agentId: transfer.agentId, session: null, feedback: handoff, previousAgentIds: [...new Set([...task.previousAgentIds, task.agentId])] });
      } else Object.assign(patch, { reviewerId: transfer.agentId });
      patches.set(task.id, patch);
    }
    for (const [id, patch] of patches) {
      const task = { ...db.getTask(id)!, ...patch };
      if (task.reviewerId && authorsOf([task]).has(task.reviewerId)) throw new ConflictError("Choose an independent reviewer for each task");
    }
    const plan = run.plan && { ...run.plan, tasks: run.plan.tasks.map((task) => {
      const saved = db.listTasks(runId).find((entry) => entry.key === task.id);
      const patch = saved && patches.get(saved.id);
      return patch ? { ...task, agentId: patch.agentId ?? task.agentId, reviewerId: patch.reviewerId ?? task.reviewerId } : task;
    }) };
    const records: AuditRecord[] = [];
    const updated = db.transaction(() => {
      for (const [id, patch] of patches) {
        const previous = db.getTask(id)!;
        const task = db.updateTask(id, patch);
        if (patch.agentId && previous.agentId !== task.agentId) records.push(db.recordAudit({ kind: "task-assignment", runId, taskId: id, agentId: task.agentId, previousAgentId: previous.agentId, attempt: task.attempt, phase: task.phase, status: task.status, commit: null, reason: "User transferred work after checking account capacity; files and checkpoints preserved", ts: now() }));
      }
      const budgetReached = run.limits && (run.agentCalls >= run.limits.maxAgentCalls || elapsed(run) >= run.limits.maxDurationMs);
      return db.updateRun(runId, { status: "paused", plan, capacityLimits: proposal.limits.map((limit) => ({ ...limit, rerouted: true })), ...(!proposal.directorBlocked && { quotaWait: null, rateLimitResumeAt: null, error: null, pauseReason: budgetReached ? run.pauseReason : "Assignments updated; continue with available agents" }) });
    });
    for (const record of records) publish(runId, { type: "audit", runId, record });
    if (!proposal.directorBlocked) { clearTimeout(rateLimitTimers.get(runId)); rateLimitTimers.delete(runId); }
    for (const [id] of patches) publish(runId, { type: "task", task: db.getTask(id)! });
    publish(runId, { type: "run", run: updated });
    logger(runId, null)("system", `User transferred ${transfers.length} assignments after checking account capacity. Files, checkpoints, evidence and consumed budgets are preserved. ${proposal.directorBlocked ? "The Director still needs its account to recover." : "Continue the run to start the available agents."}`);
    return updated;
  }

  function resume(runId: string, input: { autoContinueOnRateLimit?: boolean; guidance?: string; limits?: NonNullable<Run["limits"]>; timeouts?: Run["timeouts"] } = {}) {
    const run = mustRun(runId);
    if (!["paused", "failed"].includes(run.status)) throw new ConflictError("Only a paused or interrupted run can be resumed");
    if ([...inflight.values()].some((v) => v.runId === runId)) throw new ConflictError("Run is still settling");
    const timeouts = validateTimeouts(input.timeouts ?? run.timeouts);
    const limits = input.limits ?? run.limits;
    if (run.limits && limits && (limits.maxDurationMs < run.limits.maxDurationMs || limits.maxAgentCalls < run.limits.maxAgentCalls)) throw new ConflictError("Resume limits may only increase");
    if (limits && (limits.maxDurationMs <= run.activeElapsedMs || limits.maxAgentCalls <= run.agentCalls)) throw new ConflictError("Increase the exhausted budget before resuming");
    const recovery = run.pauseReason === "Recovery limit reached";
    const continuing = recovery || run.pauseReason === "Fix round limit reached";
    // Clicking Continue is explicit authorization for another bounded attempt; instructions are optional.
    const instructions = input.guidance?.trim() || (continuing
      ? "The user chose to continue the remaining work. Use the saved task work, failures and review findings to address the unresolved problems. Preserve completed work, stay within the original brief and avoid repeating an approach that already failed."
      : undefined);
    const guidance = appendGuidance(run, instructions);
    const autoContinueOnRateLimit = input.autoContinueOnRateLimit ?? run.autoContinueOnRateLimit;
    if (run.quotaWait) {
      clearTimeout(rateLimitTimers.get(runId));
      rateLimitTimers.delete(runId);
      const saved = setRun(runId, { autoContinueOnRateLimit, limits, timeouts, guidance });
      void quotaRefilled(saved).then((ready) => { if (ready && db.getRun(runId)?.status === "paused") resume(runId); }).catch((e) => logger(runId, null)("error", errorText(e)));
      return saved;
    }
    const retryAt = run.error && autoContinueOnRateLimit ? rateLimitRetryAt(run.error, now()) : null;
    if (retryAt !== null && run.rateLimitRetries < MAX_RATE_LIMIT_RETRIES) {
      setRun(runId, { status: "pausing", autoContinueOnRateLimit, limits, timeouts, guidance, error: null, pauseReason: "Rate limit reached; waiting to continue automatically", rateLimitResumeAt: retryAt, rateLimitRetries: run.rateLimitRetries + 1 });
      logger(runId, null)("system", `Automatic continuation scheduled for ${new Date(retryAt).toISOString()}; checkpoints and budgets are preserved.`);
      settlePause(runId);
      return mustRun(runId);
    }
    if (!recovery && run.checkpoint === "execute") for (const task of db.listTasks(runId)) if (task.status === "failed" || task.status === "blocked") setTask(task.id, { status: "pending", error: null });
    const checkpoint = recovery ? "plan" : run.checkpoint;
    const updated = setRun(runId, { autoContinueOnRateLimit, limits, timeouts, guidance, pauseReason: null, error: null, checkpoint, ...(recovery ? { purpose: null, planningPhase: "check" as const, check: null } : {}), status: checkpoint === "execute" ? "running" : checkpoint === "approve" ? "awaiting_approval" : "planning" });
    logger(runId, null)("system", "Run resumed on the same branch with preserved checkpoints and budgets.");
    if (checkpoint === "execute") tick(runId);
    else if (checkpoint === "approve") { if (updated.autonomous) approve(runId); }
    else void planRun(runId);
    return mustRun(runId);
  }

  /**
   * Forgets a stopped run: its rows, logs, worktrees and task branches. The run branch is the deliverable, so it
   * is only deleted on request. Returns branches git refused to delete (for example one the user has checked out).
   */
  async function deleteRun(runId: string, opts: { deleteBranch: boolean }) {
    const run = mustRun(runId);
    if (chatControllers.has(runId)) throw new ConflictError("Wait for the Director's reply before deleting this run");
    if (["planning", "running", "pausing"].includes(run.status) || [...inflight.values()].some((v) => v.runId === runId)) {
      throw new ConflictError("Pause or cancel the run before deleting it");
    }
    await previews.remove(runId);
    await Promise.all([cleanups.get(runId), ...retired]);
    const branches = [...db.listTasks(runId).map((t) => taskBranch(run, t)), ...(opts.deleteBranch ? [run.branch] : [])];
    const remaining = await pruneRun(run.workdir, join(worktreeRoot, runId), branches);
    clearTimeout(deadlines.get(runId));
    deadlines.delete(runId);
    clearTimeout(rateLimitTimers.get(runId));
    rateLimitTimers.delete(runId);
    mergeChains.delete(runId);
    db.deleteRun(runId);
    publish(runId, { type: "deleted", runId });
    return { remaining };
  }

  /** Call after runs have stopped, before removing their repositories or closing the database. */
  const waitForCleanup = () => Promise.all([...cleanups.values(), ...retired, ...chatReplies]);
  const getPreview = (id: string) => { mustRun(id); return previews.get(id); };
  function recordPreviewSecrets(id: string, values: Record<string, string>, commit: string | null) {
    const run = mustRun(id);
    const existing = db.listSecrets(run.workdir, id);
    db.transaction(() => {
      for (const [name, value] of Object.entries(values)) {
        const saved = existing.find((secret) => secret.source === "preview" && secret.name === name);
        if (!saved || saved.commit !== commit || db.revealSecret(run.workdir, id, name) !== value) {
          db.saveSecret(run.workdir, { name, value, environment: false }, { runId: id, commit });
        }
      }
    });
  }
  function listSecrets(id: string) {
    const run = mustRun(id);
    const report = previews.secrets(id);
    // Earlier preview launchers kept login details in this private run-local file.
    const legacy = readSecretReport(join(worktreeRoot, id, ".preview-login.json"));
    if (report) recordPreviewSecrets(id, report.values, report.commit);
    else {
      const existing = db.listSecrets(run.workdir, id);
      recordPreviewSecrets(id, Object.fromEntries(Object.entries(legacy).filter(([name]) => !existing.some((secret) => secret.source === "preview" && secret.name === name))), null);
    }
    return db.listSecrets(run.workdir, id);
  }
  function revealSecret(id: string, key: { name: string; source: "saved" | "preview" }) {
    const run = mustRun(id);
    listSecrets(id);
    const value = db.revealSecret(run.workdir, key.source === "preview" ? id : "", key.name);
    if (value === null) throw new NotFoundError("Secret not found");
    return { value };
  }
  function saveSecret(id: string, secret: SecretInput) {
    const run = mustRun(id);
    db.saveSecret(run.workdir, secret);
    return listSecrets(id);
  }
  function deleteSecret(id: string, key: { name: string; source: "saved" | "preview" }) {
    const run = mustRun(id);
    if (key.source !== "saved") throw new ConflictError("Preview credentials are reported by the app; change them in the app's setup");
    if (!db.deleteSecret(run.workdir, "", key.name)) throw new NotFoundError("Secret not found");
    return listSecrets(id);
  }
  function evidenceArtifact(runId: string, evidenceId: string, index: number) {
    mustRun(runId);
    const evidence = db.listEvidence(runId).find((e) => e.id === evidenceId);
    const artifact = evidence?.artifacts[index];
    if (!artifact) throw new NotFoundError("Evidence artifact not found");
    const root = join(worktreeRoot, runId, ".artifacts");
    const path = join(root, artifact);
    if (!existsSync(path) || !realpathSync(path).startsWith(realpathSync(root) + sep)) throw new NotFoundError("Evidence artifact not found");
    return path;
  }
  async function configurePreview(id: string, preview: Run["preview"]) {
    mustRun(id);
    setRun(id, { preview });
    await previews.stop(id);
    if (preview.enabled) void previews.refresh(id, true);
    return previews.get(id);
  }

  async function checkMerge(runId: string, requested?: string): Promise<MergeCheck> {
    const run = mustRun(runId);
    if (run.status !== "completed" || !run.acceptedCommit) throw new ConflictError("Complete the run before checking its accepted build for merging");
    const sourceCommit = run.acceptedCommit;
    if (await localBranchCommit(run.workdir, run.branch) !== sourceCommit) throw new ConflictError("The run branch changed after acceptance. Review the revision before merging.");
    const targetBranch = requested ?? await currentBranch(run.workdir);
    if (!targetBranch) return { sourceCommit, targetBranch: null, targetCommit: null, status: "unsupported", conflicts: [], message: "The project has no branch checked out. Enter a local target branch." };
    if (targetBranch === run.branch) throw new ConflictError("Choose the project branch to merge into, rather than the run branch");
    const result = await previewMerge(run.workdir, sourceCommit, targetBranch);
    const latest = mustRun(runId);
    if (latest.status !== "completed" || latest.acceptedCommit !== sourceCommit || await localBranchCommit(run.workdir, run.branch) !== sourceCommit || await localBranchCommit(run.workdir, targetBranch) !== result.targetCommit) throw new ConflictError("A revision changed while checking the merge. Check again.");
    return result;
  }

  return { startRun, revise, addGuidance, directorChat, sendDirectorChat, deleteRun, editPlan, approve, retry, cancel, pause, resume, capacityProposal, transferCapacity, waitForCleanup, getPreview, configurePreview, listSecrets, revealSecret, saveSecret, deleteSecret, checkMerge, evidenceArtifact, shutdownPreviews: previews.shutdown };
}

function taskContractPrompt(run: Run, task: Task, structured = true) {
  return `
## Your task contract
${JSON.stringify({ ...task.contract, inputVersions: task.contextVersions })}
These paths and resources describe your ownership and dependencies. They coordinate teammates and do not grant filesystem permissions. Preserve interfaces other tasks consume; report any necessary change in your handoff.

## Requirements this task delivers
${JSON.stringify(run.requirements.filter((requirement) => task.contract.requirementIds.includes(requirement.id)))}
Meet these exact versions, checks and artifact requirements. A task check is progress evidence; Orchestra establishes final acceptance on the integrated revision.

${structured ? `## Structured handoff
Return JSON matching the supplied schema: summary, decisions, interfaces, blockers, verified, and skillIds. Keep the summary concise, list precise interfaces and decisions teammates need, and describe any blockers with reproduction steps. verified contains your own check claims, not Orchestra acceptance. skillIds lists only assigned skills you actually consulted; this is a self-report, not proof of application. Use empty arrays where nothing applies. Never claim checks or skill reads you did not perform.` : "Preserve the selected procedures and requirement context while resolving conflicts. Return the requested concise conflict summary; Orchestra reruns checks and independent review."}
`;
}

function workerPrompt(run: Run, task: Task, agent: Agent, reviewer: Agent | null, deps: Task[], verify: string, notes: string | null) {
  const checks = [verify && `runs \`${verify}\``, reviewer && `asks ${reviewer.name} (${reviewer.role}) to review it`].filter(Boolean);
  return `You are ${agent.name}, the ${agent.role} on a software team coordinated by Orchestra.
Your expertise: ${agent.expertise || "general software engineering"}
${agent.instructions ? `\nAdditional instructions:\n${agent.instructions}\n` : ""}${skillsPrompt(agent.skills.filter((skill) => task.contract.skillIds === undefined || task.contract.skillIds.includes(skill.id)))}
## Overall goal
${run.prompt}

## Team plan
${run.plan?.summary ?? ""}

## Your task: ${task.title}
${task.description}

### Acceptance criteria
${task.acceptance || "(none given)"}

${taskContractPrompt(run, task)}
${deps.length ? `\n## Work already done by teammates (present in this directory)\n${deps.map((d) => `- ${d.title}: ${clip(d.summary ?? "", 1_500)}\nMerged commit: ${d.mergeCommit ?? "no file changes"}\nHandoff evidence: ${JSON.stringify(d.handoff && compactHandoff(d.handoff))}`).join("\n")}\n` : ""}${notes ? `\n## Problems to fix from an earlier attempt\n${notes}\n` : ""}
## Rules
- Work only inside the current directory. Teammates work in parallel on other tasks of the plan, so stay within your task's scope.
- Follow the project's documents in docs/ (product spec, UX, engineering design) where they exist.
- Do not commit, create branches or switch branches. Orchestra commits and merges your work.${checks.length ? `\n- When you finish, Orchestra ${checks.join(" and ")}, and sends any problems back to you. Run focused checks for your changes; Orchestra owns the authoritative full verification, so do not repeat the full command just for the handoff.` : ""}
- When you are done, reply with a handoff covering changes, decisions, interfaces, remaining issues and guidance for teammates. Be explicit about what you verified; do not claim checks you did not run.`;
}

function fixPrompt(problems: string) {
  return `Orchestra checked your work on this task and found problems:

${problems}

Fix them with the smallest changes that address each one, staying within your task. Do not commit. Then reply with a short summary of everything you changed for the task, as before.`;
}

function retryPrompt(feedback: string) {
  return `Orchestra is running this task again.

${feedback}

The current directory still holds your earlier work on it. Finish the task, without committing, and reply with a short summary of everything you changed for it.`;
}

function conflictPrompt(task: Task, files: string[]) {
  return `You are resolving a git merge conflict. Your finished work for the task "${task.title}" is being merged with work your teammates already merged.

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

Edit each file so it keeps the intent of both sides and contains no conflict markers (<<<<<<<, =======, >>>>>>>). Task description for context:
${task.description}

Do not run git commands; Orchestra completes the merge. Reply with a one-line summary.`;
}
