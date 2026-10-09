import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Agent, LogKind, Plan, Run, ServerEvent, Task } from "../shared/types.ts";
import { isDirector } from "../shared/types.ts";
import { runCheck } from "./checks.ts";
import type { Db, RunPatch, TaskPatch } from "./db.ts";
import { invokeDirector, nextPlanning, PlanError, validatePlan, type CheckReport, type Revision, type TaskBrief } from "./director.ts";
import {
  abortMerge, addWorktree, commitAll, concludeMerge, deleteBranch, diffText, headCommit, mergeBase, mergeBranch, openWorktree,
  prepareWorkspace, removeWorktree,
} from "./git.ts";
import { invokeReview } from "./review.ts";
import type { RunAgent } from "./runtimes.ts";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

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
};

export type Scheduler = ReturnType<typeof createScheduler>;

export function createScheduler({ db, runAgent, publish, worktreeRoot }: Options) {
  /** Live agent processes, so cancel can stop them. Key: task id, or run id for the director. */
  const inflight = new Map<string, { runId: string; controller: AbortController }>();
  /** Per-run chain that serializes merges into the integration worktree. */
  const mergeChains = new Map<string, Promise<unknown>>();
  /** Removal of a completed run's integration worktree; planning on the run again waits for it. */
  const cleanups = new Map<string, Promise<unknown>>();
  const retired = new Set<Promise<unknown>>();

  const integrationPath = (runId: string) => join(worktreeRoot, runId, "integration");
  const taskPath = (task: Task) => join(worktreeRoot, task.runId, task.key);
  const taskBranch = (run: Run, task: Task) => `${run.branch}-${task.key}`;

  const setRun = (id: string, patch: RunPatch) => {
    const run = db.updateRun(id, patch);
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

  /** Every agent invocation goes through here, so its usage is counted against the run and the task. */
  const metered = (runId: string, taskId: string | null): RunAgent => async (inv) => {
    const res = await runAgent(inv);
    if (res.usage && (res.usage.tokens > 0 || (res.usage.costUsd ?? 0) > 0)) {
      db.addUsage(runId, taskId, res.usage);
      publish(runId, { type: "run", run: db.getRun(runId)! });
      if (taskId) publish(runId, { type: "task", task: db.getTask(taskId)! });
    }
    return res;
  };

  const mustRun = (id: string) => {
    const run = db.getRun(id);
    if (!run) throw new NotFoundError("Run not found");
    return run;
  };
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** Everyone the director can staff: the director plans and delegates but never takes a task. */
  const teamOf = (directorId: string) => db.listAgents().filter((a) => a.id !== directorId);
  const teamIds = (run: Run) => new Set(teamOf(run.directorAgentId).map((a) => a.id));
  const agentName = (id: string | null) => (id && db.getAgent(id)?.name) || "unknown";
  const brief = (t: Task): TaskBrief => ({
    key: t.key, title: t.title, agent: agentName(t.agentId), status: t.status, summary: t.summary ?? "", error: t.error ?? "",
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
  async function plan(runId: string, revision?: Revision) {
    const run = mustRun(runId);
    const log = logger(runId, null);
    const signal = track(runId, runId);
    const cwd = integrationPath(runId);
    try {
      const director = db.getAgent(run.directorAgentId);
      if (!director) throw new PlanError("Director agent no longer exists");
      // A completed run's integration worktree is gone; feedback on it continues the same branch.
      await cleanups.get(runId);
      if (!existsSync(cwd)) await openWorktree(run.workdir, cwd, run.branch);
      const tasks = db.listTasks(runId);
      const { purpose, stage, rules } = nextPlanning(tasks);
      const verify = run.plan?.verify ?? "";
      const finalRound = purpose === "fix" && run.fixRounds >= MAX_FIX_ROUNDS;

      let check: CheckReport = null;
      if (purpose === "fix" && verify) {
        log("system", `Running the verify command on the merged build: ${verify}`);
        const res = await runCheck(cwd, verify, signal);
        if (signal.aborted) return;
        log(res.ok ? "system" : "error", `Verify command ${res.ok ? "passed" : "failed"}:\n${res.output.trim()}`);
        check = { command: verify, ...res };
      }

      const what = { initial: "the plan", build: "the build plan", recover: "a recovery plan", fix: "the verification" }[purpose];
      log("system", revision ? `Director is revising ${what}…` : purpose === "fix" ? "Director is verifying the build…" : `Director is drafting ${what}…`);
      const next = await invokeDirector(metered(runId, null), {
        director, roster: teamOf(director.id), goal: run.prompt, cwd, rules, onLog: log, signal,
        context: { purpose, stage, tasks: tasks.filter((t) => t.status !== "superseded").map(brief), verify, check, finalRound, revision },
      });
      if (signal.aborted) return;
      if (finalRound && next.tasks.length) {
        const open = next.tasks.map((t) => `- ${t.title}: ${t.description}`).join("\n");
        complete(runId, `Unresolved after ${MAX_FIX_ROUNDS} fix rounds.\n\n${next.summary}\n\nOpen items:\n${open}`);
        return;
      }
      const updated = setRun(runId, { status: "awaiting_approval", plan: next, error: null });
      // Nothing to approve in an empty fix plan: the director accepted the build.
      if (updated.autonomous || (next.stage === "fix" && next.tasks.length === 0)) approve(runId);
    } catch (e) {
      if (signal.aborted) return;
      log("error", errorText(e));
      setRun(runId, { status: "failed", error: errorText(e) });
    } finally {
      inflight.delete(runId);
    }
  }

  async function startRun(input: { prompt: string; workdir: string; autonomous?: boolean }): Promise<Run> {
    const director = db.listAgents().find(isDirector);
    if (!director) throw new ConflictError("Hire a Director on the Agents page first: the Director plans and staffs every run.");
    if (teamOf(director.id).length === 0) throw new ConflictError("Hire at least one team member to work under the Director.");
    const { baseCommit, warning } = await prepareWorkspace(input.workdir);
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `orchestra/${id}`;
    await addWorktree(input.workdir, integrationPath(id), branch, baseCommit);
    const run = db.createRun({
      id, prompt: input.prompt, workdir: input.workdir, directorAgentId: director.id, baseCommit, branch, warning, autonomous: input.autonomous,
    });
    publish(run.id, { type: "run", run });
    void plan(run.id);
    return run;
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
    const reopened: RunPatch = run.status === "completed" ? { fixRounds: 0, report: null } : {};
    const updated = setRun(runId, { status: "planning", error: null, ...reopened });
    void plan(runId, { feedback, previous });
    return updated;
  }

  /** Replaces the plan awaiting approval with the user's edited version, under the same rules as the director's. */
  function editPlan(runId: string, raw: unknown) {
    const run = mustRun(runId);
    if (run.status !== "awaiting_approval") throw new ConflictError("Only a plan awaiting approval can be edited");
    try {
      return setRun(runId, { plan: validatePlan(raw, teamIds(run), nextPlanning(db.listTasks(runId)).rules) });
    } catch (e) {
      throw new ConflictError(errorText(e));
    }
  }

  function approve(runId: string) {
    const run = mustRun(runId);
    if (run.status !== "awaiting_approval" || !run.plan) throw new ConflictError("Run is not awaiting approval");
    const tasks = db.listTasks(runId);
    const { purpose, rules } = nextPlanning(tasks);
    let plan: Plan;
    try {
      // Agents may have changed since planning.
      plan = validatePlan(run.plan, teamIds(run), rules);
    } catch (e) {
      throw new ConflictError(`${errorText(e)}\nRevise the plan.`);
    }
    if (plan.tasks.length === 0) return complete(runId, plan.summary);

    if (purpose === "recover") supersede(run, tasks);
    db.insertTasks(runId, plan);
    for (const task of db.listTasks(runId)) publish(runId, { type: "task", task });
    const updated = setRun(runId, { status: "running", plan, ...(purpose === "fix" && { fixRounds: run.fixRounds + 1 }) });
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
        setRun(run.id, { status: "planning", recoveries: run.recoveries + 1, error: null });
        logger(run.id, null)("system", `${failed} task(s) failed; the Director re-plans the remaining work.`);
        void plan(run.id);
      } else {
        setRun(run.id, { status: "failed", error: `${failed} task(s) failed. Retry them or ask the Director to re-plan.` });
      }
      return;
    }
    setRun(run.id, { status: "planning", error: null });
    void plan(run.id);
  }

  async function execute(run: Run, task: Task) {
    // Synchronous before the first await, so a concurrent tick() cannot start the same task twice.
    setTask(task.id, { status: "running", startedAt: Date.now(), finishedAt: null, error: null, summary: null, feedback: null, iterations: 0 });
    const log = logger(run.id, task.id);
    const signal = track(task.id, run.id);
    const branch = taskBranch(run, task);
    const cwd = taskPath(task);
    const invoke = metered(run.id, task.id);
    try {
      const agent = db.getAgent(task.agentId);
      if (!agent) throw new Error("Assigned agent no longer exists");
      const reviewer = task.reviewerId ? db.getAgent(task.reviewerId) : null;
      if (task.reviewerId && !reviewer) throw new Error("Assigned reviewer no longer exists");
      const verify = run.plan?.verify ?? "";

      // A retry resumes the agent's conversation in its previous worktree, so the work it remembers is still there.
      const existing = existsSync(cwd);
      let session = existing ? task.session : null;
      if (existing) {
        log("system", `${agent.name} continues on branch ${branch}`);
      } else {
        await addWorktree(run.workdir, cwd, branch, await headCommit(integrationPath(run.id)));
        log("system", `${agent.name} started on branch ${branch}`);
      }
      const start = await mergeBase(cwd, "HEAD", run.branch);
      const deps = db.listTasks(run.id).filter((t) => task.dependsOn.includes(t.key));

      let prompt = session && task.feedback ? retryPrompt(task.feedback) : workerPrompt(run, task, agent, reviewer, deps, verify, task.feedback);
      let summary = "";
      for (let i = 1; ; i++) {
        setTask(task.id, { iterations: i });
        const res = await invoke({ agent, mode: "worker", prompt, cwd, resume: session ?? undefined, onLog: log, signal });
        if (res.session) session = setTask(task.id, { session: res.session }).session;
        if (signal.aborted) throw new Error("cancelled");
        if (!res.ok) {
          // A conversation that can't even be resumed (e.g. the CLI no longer has it) would fail every retry the same way.
          if (session && !res.usage?.tokens) setTask(task.id, { session: null });
          throw new Error(res.error ?? "agent failed");
        }
        summary = res.text.trim() || summary;
        const changed = await commitAll(cwd, i === 1 ? `${task.key}: ${task.title}` : `${task.key}: fixes (attempt ${i})`);
        log("system", changed ? "Committed changes" : "No file changes");

        const problem = await inspect({ run, task, agent, reviewer, verify, cwd, start, log, signal });
        if (!problem) break;
        if (i === MAX_ITERATIONS) throw new Error(`Still failing after ${MAX_ITERATIONS} attempts:\n${problem}`);
        log("system", `Sending the problems back to ${agent.name} (attempt ${i + 1} of ${MAX_ITERATIONS})`);
        prompt = session ? fixPrompt(problem) : workerPrompt(run, task, agent, reviewer, deps, verify, problem);
      }

      const mergeCommit = await withMergeLock(run.id, () => merge(run, task, agent, branch, signal, log));
      await removeWorktree(run.workdir, cwd);
      await deleteBranch(run.workdir, branch);
      setTask(task.id, { status: "done", summary: summary || "(no summary)", mergeCommit, finishedAt: Date.now() });
    } catch (e) {
      if (signal.aborted) {
        setTask(task.id, { status: "cancelled", finishedAt: Date.now() });
      } else {
        log("error", errorText(e));
        setTask(task.id, { status: "failed", error: errorText(e), finishedAt: Date.now() });
        blockDependents(run.id, task.key);
      }
    } finally {
      inflight.delete(task.id);
      tick(run.id);
    }
  }

  /** Runs the plan's verify command and the task's review on committed work. Returns the problems to fix, or null. */
  async function inspect(o: {
    run: Run; task: Task; agent: Agent; reviewer: Agent | null; verify: string; cwd: string; start: string;
    log: (k: LogKind, t: string) => void; signal: AbortSignal;
  }): Promise<string | null> {
    if (o.verify) {
      o.log("system", `Running the verify command: ${o.verify}`);
      const check = await runCheck(o.cwd, o.verify, o.signal);
      if (o.signal.aborted) throw new Error("cancelled");
      if (!check.ok) {
        o.log("error", `Verify command failed:\n${check.output.trim()}`);
        return `The verify command \`${o.verify}\` failed:\n\`\`\`\n${check.output.trim()}\n\`\`\``;
      }
      o.log("system", "Verify command passed");
    }
    if (o.reviewer) {
      o.log("system", `${o.reviewer.name} is reviewing the change`);
      const review = await invokeReview(metered(o.run.id, o.task.id), {
        reviewer: o.reviewer, task: o.task, author: o.agent.name, diff: await diffText(o.cwd, o.start), cwd: o.cwd, onLog: o.log, signal: o.signal,
      });
      if (o.signal.aborted) throw new Error("cancelled");
      if (review.verdict === "changes") {
        o.log("system", `${o.reviewer.name} requested changes:\n${review.findings}`);
        return `${o.reviewer.name} (${o.reviewer.role}) reviewed your change and requested changes:\n${review.findings}`;
      }
      o.log("system", `${o.reviewer.name} approved the change`);
    }
    return null;
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
    return after === before ? null : after;
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
    if (reassigned && !teamIds(run).has(agentId)) throw new ConflictError("Assign the task to a team member other than the Director");
    if (agentId === task.reviewerId) throw new ConflictError("The task's reviewer can't also be its assignee");

    const feedback = [
      task.error && `The previous attempt failed:\n${task.error}`,
      opts.instructions && `Instructions from the user:\n${opts.instructions}`,
    ].filter(Boolean).join("\n\n");
    setTask(task.id, {
      status: "pending", agentId, error: null, feedback: feedback || null, session: reassigned ? null : task.session, startedAt: null, finishedAt: null,
    });
    for (const t of dependentsOf(run.id, task.key)) {
      if (t.status === "blocked") setTask(t.id, { status: "pending", error: null });
    }
    if (run.status !== "running") setRun(run.id, { status: "running", error: null });
    tick(run.id);
    return db.getTask(task.id)!;
  }

  function cancel(runId: string) {
    const run = mustRun(runId);
    if (!["planning", "awaiting_approval", "running"].includes(run.status)) throw new ConflictError("Run is already finished");
    const updated = setRun(runId, { status: "cancelled" });
    for (const t of db.listTasks(runId)) {
      if (t.status === "pending" || t.status === "blocked") setTask(t.id, { status: "cancelled" });
    }
    for (const { runId: owner, controller } of inflight.values()) {
      if (owner === runId) controller.abort();
    }
    return updated;
  }

  /** Call after runs have stopped, before removing their repositories or closing the database. */
  const waitForCleanup = () => Promise.all([...cleanups.values(), ...retired]);
  return { startRun, revise, editPlan, approve, retry, cancel, waitForCleanup };
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
${deps.length ? `\n## Work already done by teammates (present in this directory)\n${deps.map((d) => `- ${d.title}: ${d.summary}`).join("\n")}\n` : ""}${notes ? `\n## Problems to fix from an earlier attempt\n${notes}\n` : ""}
## Rules
- Work only inside the current directory. Teammates work in parallel on other tasks of the plan, so stay within your task's scope.
- Follow the project's documents in docs/ (product spec, UX, engineering design) where they exist.
- Do not commit, create branches or switch branches. Orchestra commits and merges your work.${checks.length ? `\n- When you finish, Orchestra ${checks.join(" and ")}, and sends any problems back to you.${verify ? " Run the command yourself before you finish." : ""}` : ""}
- When you are done, reply with a short summary of what you changed and anything a teammate building on your work needs to know.`;
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
