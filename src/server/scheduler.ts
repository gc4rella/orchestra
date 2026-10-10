import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, LogKind, Plan, Run, ServerEvent, Task } from "../shared/types.ts";
import { DEFAULT_RUN_LIMITS } from "../shared/types.ts";
import { runCheck } from "./checks.ts";
import type { Db, RunPatch, TaskPatch } from "./db.ts";
import { invokeDirector, nextPlanning, PlanError, validatePlan, type CheckReport, type Revision, type TaskBrief } from "./director.ts";
import {
  abortMerge, addWorktree, commitAll, concludeMerge, deleteBranch, diffText, headCommit, mergeBase, mergeBranch, openWorktree,
  prepareWorkspace, pruneRun, removeWorktree, diffFiles, taskMergeCommit,
} from "./git.ts";
import { invokeReview } from "./review.ts";
import type { RunAgent } from "./runtimes.ts";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}
class RunPaused extends Error {}

const MAX_PARALLEL = 3;
/** Work → verify → review passes per task attempt; the task fails when the last one still has problems. */
export const MAX_ITERATIONS = 3;
/** Automatic re-plans after failed tasks in an autonomous run. */
export const MAX_RECOVERIES = 2;
/** Verification rounds whose fix tasks run; after that the director only reports what is still open. */
export const MAX_FIX_ROUNDS = 2;

type Options = {
  db: Db;
  runAgent: RunAgent;
  publish: (runId: string, ev: ServerEvent) => void;
  worktreeRoot: string;
  now?: () => number;
};

export type Scheduler = ReturnType<typeof createScheduler>;

export function createScheduler({ db, runAgent, publish, worktreeRoot, now = Date.now }: Options) {
  /** Live agent processes, so cancel can stop them. Key: task id, or run id for the director. */
  const inflight = new Map<string, { runId: string; controller: AbortController }>();
  /** Per-run chain that serializes merges into the integration worktree. */
  const mergeChains = new Map<string, Promise<unknown>>();
  /** Removal of a completed run's integration worktree; planning on the run again waits for it. */
  const cleanups = new Map<string, Promise<unknown>>();
  const retired = new Set<Promise<unknown>>();
  const deadlines = new Map<string, ReturnType<typeof setTimeout>>();

  const integrationPath = (runId: string) => join(worktreeRoot, runId, "integration");
  const taskPath = (task: Task) => join(worktreeRoot, task.runId, task.key);
  const taskBranch = (run: Run, task: Task) => `${run.branch}-${task.key}`;

  const setRun = (id: string, patch: RunPatch) => {
    const before = db.getRun(id)!;
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
    const task = db.updateTask(id, patch);
    publish(task.runId, { type: "task", task });
    return task;
  };
  const logger = (runId: string, taskId: string | null) => (kind: LogKind, text: string) =>
    publish(runId, { type: "log", log: db.addLog(runId, taskId, kind, text) });

  const elapsed = (run: Run) => run.activeElapsedMs + (run.activeSince === null ? 0 : now() - run.activeSince);

  function settlePause(runId: string) {
    if (db.getRun(runId)?.status !== "pausing" || [...inflight.values()].some((v) => v.runId === runId)) return;
    const run = mustRun(runId);
    const tasks = db.listTasks(runId).filter((task) => task.status !== "superseded");
    const previous = run.pauseReason === "Fix round limit reached" || run.pauseReason === "Recovery limit reached" ? run.report : run.history.findLast((entry) => entry.report)?.report;
    const checkpoints = tasks.map((task) => `- ${task.key}: ${task.status} at ${task.phase}; checks ${task.handoff?.check ? task.handoff.check.ok ? "passed" : "failed" : "not recorded"}; review ${task.handoff?.review?.verdict ?? "not recorded"}`).join("\n");
    const report = `${previous ? `${previous}\n\n` : ""}Paused: ${run.pauseReason}. ${run.agentCalls} agent calls used. Work is preserved on ${run.branch}.\n\n${checkpoints || "Director planning checkpoint saved."}`;
    setRun(runId, { status: "paused", report });
  }

  function pauseInternal(runId: string, reason: string, hard = false) {
    const run = mustRun(runId);
    if (["completed", "cancelled", "failed", "paused"].includes(run.status)) return run;
    const updated = setRun(runId, { status: "pausing", pauseReason: reason });
    logger(runId, null)("system", `Pausing: ${reason}. Work and checkpoints are preserved.`);
    if (hard) for (const v of inflight.values()) if (v.runId === runId) v.controller.abort();
    settlePause(runId);
    return db.getRun(runId) ?? updated;
  }

  function proceed(runId: string) {
    const run = mustRun(runId);
    if (run.limits && elapsed(run) >= run.limits.maxDurationMs && ["running", "planning"].includes(run.status)) pauseInternal(runId, "Time budget reached", true);
    if (!["running", "planning"].includes(mustRun(runId).status)) throw new RunPaused();
  }

  /** Reserve synchronously, before awaiting: simultaneous workers share one hard call cap. */
  const metered = (runId: string, taskId: string | null): RunAgent => async (inv) => {
    proceed(runId);
    const run = mustRun(runId);
    if (run.limits && run.agentCalls >= run.limits.maxAgentCalls) {
      pauseInternal(runId, "Agent call budget reached");
      throw new RunPaused();
    }
    setRun(runId, { agentCalls: run.agentCalls + 1 });
    const currentGuidance = run.guidance ? `\n\n## Current guidance from the user\n${run.guidance}` : "";
    const res = await runAgent({ ...inv, prompt: inv.prompt + currentGuidance });
    if (res.usage && (res.usage.tokens > 0 || (res.usage.costUsd ?? 0) > 0)) {
      db.addUsage(runId, taskId, res.usage);
      publish(runId, { type: "run", run: db.getRun(runId)! });
      if (taskId) publish(runId, { type: "task", task: db.getTask(taskId)! });
    }
    const latest = mustRun(runId);
    if (latest.limits && latest.agentCalls >= latest.limits.maxAgentCalls && ["planning", "running"].includes(latest.status)) pauseInternal(runId, "Agent call budget reached");
    return res;
  };

  function planning(run: Run, tasks: Task[]) {
    const current = tasks.filter((t) => t.cycle === run.cycle);
    const next = nextPlanning(current);
    const base = { doneKeys: new Set(tasks.filter((t) => t.status === "done").map((t) => t.key)), takenKeys: new Set(tasks.map((t) => t.key)) };
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
      .flatMap((id) => db.getAgent(id) ?? []);
  const teamIds = (run: Run) => new Set(rosterOf(run).map((a) => a.id));
  const agentName = (id: string | null) => (id && db.getAgent(id)?.name) || "unknown";
  const brief = (t: Task): TaskBrief => ({
    key: t.key, title: t.title, agent: agentName(t.agentId), status: t.status, summary: t.summary ?? "", error: t.error ?? "", handoff: t.handoff, mergeCommit: t.mergeCommit,
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
    const cwd = integrationPath(runId);
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
      const verify = run.plan?.verify ?? "";
      const finalRound = purpose === "fix" && run.fixRounds >= MAX_FIX_ROUNDS;

      let check: CheckReport = run.check;
      if (purpose === "fix" && verify && run.planningPhase === "check") {
        proceed(runId);
        log("system", `Running the verify command on the merged build: ${verify}`);
        const res = await runCheck(cwd, verify, signal);
        if (signal.aborted) return;
        log(res.ok ? "system" : "error", `Verify command ${res.ok ? "passed" : "failed"}:\n${res.output.trim()}`);
        check = { command: verify, ...res };
        setRun(runId, { check, planningPhase: "director" });
      }

      const what = { initial: "the plan", build: "the build plan", recover: "a recovery plan", fix: "the verification", improve: "the next improvement" }[purpose];
      log("system", revision ? `Director is revising ${what}…` : purpose === "fix" ? "Director is verifying the build…" : `Director is drafting ${what}…`);
      proceed(runId);
      const next = await invokeDirector(metered(runId, null), {
        director, roster, goal: run.prompt, cwd, rules, onLog: log, signal,
        context: { purpose, stage, tasks: tasks.filter((t) => t.status !== "superseded").map(brief), verify, checkCommand: run.checkCommand, check, finalRound, revision },
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

  async function startRun(input: { teamId: string; prompt: string; workdir: string; autonomous?: boolean; continuous?: boolean; checkCommand?: string; limits?: Run["limits"] }): Promise<Run> {
    if (input.continuous && !input.autonomous) throw new ConflictError("Continuous improvement requires autonomous execution");
    const team = db.getTeam(input.teamId);
    if (!team) throw new ConflictError("Pick a team for the run: its Director plans and staffs the work.");
    const director = db.getAgent(team.directorId);
    if (!director) throw new ConflictError(`${team.name} has no Director.`);
    if (!team.memberIds.some((id) => id !== director.id)) throw new ConflictError(`Add at least one member to ${team.name} to work under the Director.`);
    const { baseCommit, warning } = await prepareWorkspace(input.workdir);
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `orchestra/${id}`;
    await addWorktree(input.workdir, integrationPath(id), branch, baseCommit);
    const run = db.createRun({
      id, prompt: input.prompt, workdir: input.workdir, teamId: team.id, directorAgentId: director.id, baseCommit, branch, warning, autonomous: input.autonomous, continuous: input.continuous, checkCommand: input.checkCommand, limits: input.limits === undefined ? DEFAULT_RUN_LIMITS : input.limits,
    });
    setRun(run.id, { status: "planning" });
    void planRun(run.id);
    return mustRun(run.id);
  }

  /** Guidance accumulates for the whole run; every later agent call receives all of it (see `metered`). */
  function appendGuidance(run: Run, text: string | undefined) {
    const guidance = [run.guidance, text].filter(Boolean).join("\n\n");
    if (guidance.length > 20_000) throw new ConflictError("Accumulated guidance exceeds 20000 characters");
    return guidance;
  }

  /** Steers an active run without pausing it: the next agent call picks the note up. */
  function addGuidance(runId: string, text: string) {
    const run = mustRun(runId);
    if (!["planning", "running", "awaiting_approval"].includes(run.status)) {
      throw new ConflictError("Only an active run takes notes; use resume to add guidance to a paused run");
    }
    const updated = setRun(runId, { guidance: appendGuidance(run, text) });
    logger(runId, null)("system", `Guidance from you: ${text}`);
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
      return setRun(runId, { plan: validatePlan(raw, teamIds(run), planning(run, db.listTasks(runId)).rules) });
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
    } catch (e) {
      throw new ConflictError(`${errorText(e)}\nRevise the plan.`);
    }
    const history = [...run.history, { cycle: run.cycle, createdAt: now(), plan, report: plan.tasks.length ? null : plan.summary }];
    setRun(runId, { history });
    logger(runId, null)("system", `Cycle ${run.cycle}: ${plan.summary}`);
    if (plan.tasks.length === 0) {
      if (run.check && !run.check.ok && purpose !== "improve") throw new ConflictError("Cannot accept a build with failing verification");
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
    const updated = setRun(runId, { status: "running", checkpoint: "execute", purpose: null, plan, ...(purpose === "fix" && { fixRounds: run.fixRounds + 1 }) });
    tick(runId);
    return updated;
  }

  function complete(runId: string, report: string) {
    const run = setRun(runId, { status: "completed", report, error: null });
    cleanups.set(runId, removeWorktree(run.workdir, integrationPath(runId))
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
    const ready = tasks.filter((t) => t.status === "pending" && t.dependsOn.every((d) => done.has(d)));
    for (const task of ready.slice(0, Math.max(0, MAX_PARALLEL - running))) void execute(run, task);
    if (running === 0 && ready.length === 0) finish(run, tasks);
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
          setRun(run.id, { checkpoint: "execute", report: `${failed} task(s) failed. Retry them or ask the Director to re-plan.` });
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
      proceed(run.id);
      const agent = db.getAgent(task.agentId);
      if (!agent) throw new Error("Assigned agent no longer exists");
      const reviewer = task.reviewerId ? db.getAgent(task.reviewerId) : null;
      if (task.reviewerId && !reviewer) throw new Error("Assigned reviewer no longer exists");
      const verify = run.plan?.verify ?? "";
      if (!existsSync(cwd)) {
        await addWorktree(run.workdir, cwd, branch, await headCommit(integrationPath(run.id)));
        log("system", `${agent.name} started on branch ${branch}`);
      } else log("system", `${agent.name} continues at ${task.phase} on branch ${branch}`);
      const start = task.startCommit ?? await mergeBase(cwd, "HEAD", run.branch);
      task = setTask(task.id, { startCommit: start });
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
            const prompt = task.session && task.feedback ? (task.iterations ? fixPrompt(task.feedback) : retryPrompt(task.feedback)) : workerPrompt(mustRun(run.id), task, agent, reviewer, deps, verify, task.feedback);
            const res = await metered(run.id, task.id)({ agent, mode: "worker", prompt, cwd, resume: task.session ?? undefined, onLog: log, signal });
            if (res.session) task = setTask(task.id, { session: res.session });
            if (signal.aborted) throw new RunPaused();
            if (!res.ok) {
              if (task.session && !res.usage?.tokens) setTask(task.id, { session: null });
              task = setTask(task.id, { feedback: res.error ?? "agent failed" });
              throw new Error(res.error ?? "agent failed");
            }
            task = setTask(task.id, { iterations: task.iterations + 1, summary: res.text.trim() || task.summary || "(no summary)", phase: "commit", feedback: null, handoff: { text: res.text.trim(), files: [], check: null, review: null } });
            break;
          }
          case "commit": {
            const changed = await commitAll(cwd, `${task.key}: ${task.title} (attempt ${task.iterations})`);
            log("system", changed ? "Committed changes" : "No file changes");
            task = setTask(task.id, { phase: "check", handoff: { ...evidence(), files: (await diffFiles(cwd, start, "HEAD")).map((f) => f.path) } });
            break;
          }
          case "check": {
            if (verify) {
              log("system", `Running the verify command: ${verify}`);
              const check = await runCheck(cwd, verify, signal);
              if (signal.aborted) throw new RunPaused();
              task = setTask(task.id, { handoff: { ...evidence(), check: { command: verify, ...check } } });
              if (!check.ok) { problems(`The verify command \`${verify}\` failed:\n${check.output.trim()}`); break; }
              log("system", "Verify command passed");
            }
            task = setTask(task.id, { phase: "review" });
            break;
          }
          case "review": {
            if (reviewer) {
              log("system", `${reviewer.name} is reviewing the change`);
              const review = await invokeReview(metered(run.id, task.id), { reviewer, task, author: agent.name, diff: await diffText(cwd, start), cwd, onLog: log, signal });
              if (signal.aborted) throw new RunPaused();
              task = setTask(task.id, { handoff: { ...evidence(), review } });
              if (review.verdict === "changes") { problems(`${reviewer.name} (${reviewer.role}) reviewed your change and requested changes:\n${review.findings}`); break; }
              log("system", `${reviewer.name} approved the change`);
            }
            task = setTask(task.id, { phase: "merge" });
            break;
          }
          case "merge": {
            const mergeCommit = await withMergeLock(run.id, () => { proceed(run.id); return merge(run, task, agent, branch, signal, log); });
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
      tick(run.id);
    }
  }

  /** Merges the task branch into the run branch. Returns the merge commit, or null when there was nothing to merge. */
  async function merge(run: Run, task: Task, agent: Agent, branch: string, signal: AbortSignal, log: (k: LogKind, t: string) => void) {
    if (signal.aborted) throw new Error("cancelled");
    const cwd = integrationPath(run.id);
    const before = await headCommit(cwd);
    const { conflicts } = await mergeBranch(cwd, branch, `Merge ${task.key}: ${task.title}`);
    if (conflicts.length) {
      log("system", `Merge conflict in ${conflicts.join(", ")}; ${agent.name} is resolving it`);
      try {
        const res = await metered(run.id, task.id)({ agent, mode: "worker", prompt: conflictPrompt(task, conflicts), cwd, onLog: log, signal });
        if (signal.aborted || !res.ok || !(await concludeMerge(cwd, conflicts))) {
          throw new Error(signal.aborted ? "cancelled" : `Could not resolve merge conflict in ${conflicts.join(", ")}`);
        }
      } catch (e) {
        await abortMerge(cwd);
        throw e;
      }
      log("system", "Merge conflict resolved");
    }
    const after = await headCommit(cwd);
    return after === before ? taskMergeCommit(cwd, task.startCommit ?? run.baseCommit, `Merge ${task.key}: ${task.title}`) : after;
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

    const feedback = [
      task.error && `The previous attempt failed:\n${task.error}`,
      opts.instructions && `Instructions from the user:\n${opts.instructions}`,
    ].filter(Boolean).join("\n\n");
    setTask(task.id, {
      status: "pending", phase: "work", iterations: 0, handoff: null, agentId, error: null, feedback: feedback || null, session: reassigned ? null : task.session, startedAt: null, finishedAt: null,
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

  function resume(runId: string, input: { guidance?: string; limits?: NonNullable<Run["limits"]> } = {}) {
    const run = mustRun(runId);
    if (!["paused", "failed"].includes(run.status)) throw new ConflictError("Only a paused or interrupted run can be resumed");
    if ([...inflight.values()].some((v) => v.runId === runId)) throw new ConflictError("Run is still settling");
    const limits = input.limits ?? run.limits;
    if (run.limits && limits && (limits.maxDurationMs < run.limits.maxDurationMs || limits.maxAgentCalls < run.limits.maxAgentCalls)) throw new ConflictError("Resume limits may only increase");
    if (limits && (limits.maxDurationMs <= run.activeElapsedMs || limits.maxAgentCalls <= run.agentCalls)) throw new ConflictError("Increase the exhausted budget before resuming");
    if (run.pauseReason === "Fix round limit reached" && !input.guidance?.trim()) throw new ConflictError("Add guidance before revisiting unresolved work");
    const guidance = appendGuidance(run, input.guidance?.trim());
    const recovery = run.pauseReason === "Recovery limit reached";
    if (recovery && !input.guidance?.trim()) throw new ConflictError("Add guidance before re-planning failed work");
    if (!recovery) for (const task of db.listTasks(runId)) if (task.status === "failed" || task.status === "blocked") setTask(task.id, { status: "pending", error: null });
    const checkpoint = recovery ? "plan" : run.checkpoint;
    const updated = setRun(runId, { limits, guidance, pauseReason: null, error: null, checkpoint, ...(recovery ? { purpose: null, planningPhase: "check" as const, check: null } : {}), status: checkpoint === "execute" ? "running" : checkpoint === "approve" ? "awaiting_approval" : "planning" });
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
    if (["planning", "running", "pausing"].includes(run.status) || [...inflight.values()].some((v) => v.runId === runId)) {
      throw new ConflictError("Pause or cancel the run before deleting it");
    }
    await Promise.all([cleanups.get(runId), ...retired]);
    const branches = [...db.listTasks(runId).map((t) => taskBranch(run, t)), ...(opts.deleteBranch ? [run.branch] : [])];
    const remaining = await pruneRun(run.workdir, join(worktreeRoot, runId), branches);
    clearTimeout(deadlines.get(runId));
    deadlines.delete(runId);
    mergeChains.delete(runId);
    db.deleteRun(runId);
    publish(runId, { type: "deleted", runId });
    return { remaining };
  }

  /** Call after runs have stopped, before removing their repositories or closing the database. */
  const waitForCleanup = () => Promise.all([...cleanups.values(), ...retired]);
  return { startRun, revise, addGuidance, deleteRun, editPlan, approve, retry, cancel, pause, resume, waitForCleanup };
}

function workerPrompt(run: Run, task: Task, agent: Agent, reviewer: Agent | null, deps: Task[], verify: string, notes: string | null) {
  const checks = [verify && `runs \`${verify}\``, reviewer && `asks ${reviewer.name} (${reviewer.role}) to review it`].filter(Boolean);
  return `You are ${agent.name}, the ${agent.role} on a software team coordinated by Orchestra.
Your skills: ${agent.skills || "general software engineering"}
${agent.instructions ? `\nAdditional instructions:\n${agent.instructions}\n` : ""}
## Overall goal
${run.prompt}

## Team plan
${run.plan?.summary ?? ""}

## Your task: ${task.title}
${task.description}

### Acceptance criteria
${task.acceptance || "(none given)"}
${deps.length ? `\n## Work already done by teammates (present in this directory)\n${deps.map((d) => `- ${d.title}: ${d.summary}\nMerged commit: ${d.mergeCommit ?? "no file changes"}\nHandoff evidence: ${JSON.stringify(d.handoff)}`).join("\n")}\n` : ""}${notes ? `\n## Problems to fix from an earlier attempt\n${notes}\n` : ""}
## Rules
- Work only inside the current directory. Teammates work in parallel on other tasks of the plan, so stay within your task's scope.
- Follow the project's documents in docs/ (product spec, UX, engineering design) where they exist.
- Do not commit, create branches or switch branches. Orchestra commits and merges your work.${checks.length ? `\n- When you finish, Orchestra ${checks.join(" and ")}, and sends any problems back to you.${verify ? " Run the command yourself before you finish." : ""}` : ""}
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
