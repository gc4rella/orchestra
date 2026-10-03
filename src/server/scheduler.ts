import { join } from "node:path";
import type { Agent, LogKind, Plan, Run, ServerEvent, Task } from "../shared/types.ts";
import { isDirector } from "../shared/types.ts";
import type { Db } from "./db.ts";
import { invokeDirector, planRules, PlanError, validatePlan } from "./director.ts";
import {
  abortMerge, addWorktree, commitAll, concludeMerge, deleteBranch, headCommit, mergeBranch, prepareWorkspace, removeWorktree,
} from "./git.ts";
import type { RunAgent } from "./runtimes.ts";

export class ConflictError extends Error {}
export class NotFoundError extends Error {}

const MAX_PARALLEL = 3;

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

  const integrationPath = (runId: string) => join(worktreeRoot, runId, "integration");
  const taskPath = (task: Task) => join(worktreeRoot, task.runId, task.key);
  const taskBranch = (run: Run, task: Task) => `${run.branch}-${task.key}`;

  const setRun = (id: string, patch: Parameters<Db["updateRun"]>[1]) => {
    const run = db.updateRun(id, patch);
    publish(run.id, { type: "run", run });
    return run;
  };
  const setTask = (id: string, patch: Parameters<Db["updateTask"]>[1]) => {
    const task = db.updateTask(id, patch);
    publish(task.runId, { type: "task", task });
    return task;
  };
  const logger = (runId: string, taskId: string | null) => (kind: LogKind, text: string) =>
    publish(runId, { type: "log", log: db.addLog(runId, taskId, kind, text) });

  const mustRun = (id: string) => {
    const run = db.getRun(id);
    if (!run) throw new NotFoundError("Run not found");
    return run;
  };
  const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));
  /** Everyone the director can staff: the director plans and delegates but never takes a task. */
  const teamOf = (directorId: string) => db.listAgents().filter((a) => a.id !== directorId);

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

  async function plan(runId: string, feedback?: string) {
    const run = mustRun(runId);
    const log = logger(runId, null);
    const signal = track(runId, runId);
    try {
      const director = db.getAgent(run.directorAgentId);
      if (!director) throw new PlanError("Director agent no longer exists");
      // Finished tasks mean the definition stage is done and the director now plans the build.
      const finished = db.listTasks(runId).map((t) => ({
        key: t.key, title: t.title, agent: db.getAgent(t.agentId)?.name ?? "unknown", summary: t.summary ?? "",
      }));
      const what = finished.length ? "the build plan" : "the plan";
      log("system", feedback ? `Director is revising ${what}…` : `Director is drafting ${what}…`);
      // The stored plan is only "previous" if it belongs to the stage being planned now.
      const previous = run.plan && !(finished.length && run.plan.stage === "definition") ? run.plan : undefined;
      const revision = feedback ? { feedback, previous } : undefined;
      const plan = await invokeDirector(runAgent, {
        director, roster: teamOf(director.id), goal: run.prompt, cwd: integrationPath(runId), finished, revision, onLog: log, signal,
      });
      if (signal.aborted) return;
      setRun(runId, { status: "awaiting_approval", plan, error: null });
    } catch (e) {
      if (signal.aborted) return;
      log("error", errorText(e));
      setRun(runId, { status: "failed", error: errorText(e) });
    } finally {
      inflight.delete(runId);
    }
  }

  async function startRun(input: { prompt: string; workdir: string }): Promise<Run> {
    const director = db.listAgents().find(isDirector);
    if (!director) throw new ConflictError("Hire a Director on the Agents page first: the Director plans and staffs every run.");
    if (teamOf(director.id).length === 0) throw new ConflictError("Hire at least one team member to work under the Director.");
    const { baseCommit, warning } = await prepareWorkspace(input.workdir);
    const id = crypto.randomUUID().slice(0, 8);
    const branch = `orchestra/${id}`;
    await addWorktree(input.workdir, integrationPath(id), branch, baseCommit);
    const run = db.createRun({ id, prompt: input.prompt, workdir: input.workdir, directorAgentId: director.id, baseCommit, branch, warning });
    publish(run.id, { type: "run", run });
    void plan(run.id);
    return run;
  }

  /** Re-plans with user feedback; also retries planning after a failed attempt. */
  function revise(runId: string, feedback: string) {
    const run = mustRun(runId);
    // A failed run whose tasks are all done failed while planning (possibly the build stage).
    const replannable =
      run.status === "awaiting_approval" || (run.status === "failed" && db.listTasks(runId).every((t) => t.status === "done"));
    if (!replannable) throw new ConflictError("Only a run that is between plans can be re-planned");
    const updated = setRun(runId, { status: "planning", error: null });
    void plan(runId, feedback);
    return updated;
  }

  function approve(runId: string) {
    const run = mustRun(runId);
    if (run.status !== "awaiting_approval" || !run.plan) throw new ConflictError("Run is not awaiting approval");
    let plan: Plan;
    try {
      // Agents may have changed since planning.
      const rules = planRules(db.listTasks(runId).map((t) => t.key));
      plan = validatePlan(run.plan, new Set(teamOf(run.directorAgentId).map((a) => a.id)), rules);
    } catch (e) {
      throw new ConflictError(`${errorText(e)}\nRevise the plan.`);
    }
    db.insertTasks(runId, plan);
    for (const task of db.listTasks(runId)) publish(runId, { type: "task", task });
    const updated = setRun(runId, { status: "running" });
    tick(runId);
    return updated;
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
    if (running === 0 && ready.length === 0) void finish(run, tasks);
  }

  async function finish(run: Run, tasks: Task[]) {
    if (tasks.every((t) => t.status === "done")) {
      if (run.plan?.stage === "definition") {
        setRun(run.id, { status: "planning", error: null });
        void plan(run.id);
        return;
      }
      await removeWorktree(run.workdir, integrationPath(run.id));
      setRun(run.id, { status: "completed", error: null });
    } else {
      const failed = tasks.filter((t) => t.status === "failed").length;
      setRun(run.id, { status: "failed", error: `${failed} task(s) failed. Retry them to continue.` });
    }
  }

  async function execute(run: Run, task: Task) {
    // Synchronous before the first await, so a concurrent tick() cannot start the same task twice.
    setTask(task.id, { status: "running", startedAt: Date.now(), finishedAt: null, error: null, summary: null });
    const log = logger(run.id, task.id);
    const signal = track(task.id, run.id);
    const branch = taskBranch(run, task);
    const cwd = taskPath(task);
    try {
      const agent = db.getAgent(task.agentId);
      if (!agent) throw new Error("Assigned agent no longer exists");
      await addWorktree(run.workdir, cwd, branch, await headCommit(integrationPath(run.id)));
      log("system", `${agent.name} started on branch ${branch}`);

      const deps = db.listTasks(run.id).filter((t) => task.dependsOn.includes(t.key));
      const prompt = workerPrompt(run, task, agent, deps);
      const res = await runAgent({ agent, mode: "worker", prompt, cwd, onLog: log, signal });
      if (signal.aborted) throw new Error("cancelled");
      if (!res.ok) throw new Error(res.error ?? "agent failed");

      const changed = await commitAll(cwd, `${task.key}: ${task.title}`);
      log("system", changed ? "Committed changes; merging" : "No file changes to merge");
      await withMergeLock(run.id, () => merge(run, task, agent, branch, signal, log));
      await removeWorktree(run.workdir, cwd);
      await deleteBranch(run.workdir, branch);
      setTask(task.id, { status: "done", summary: res.text.trim() || "(no summary)", finishedAt: Date.now() });
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

  async function merge(run: Run, task: Task, agent: Agent, branch: string, signal: AbortSignal, log: (k: LogKind, t: string) => void) {
    const cwd = integrationPath(run.id);
    const { conflicts } = await mergeBranch(cwd, branch, `Merge ${task.key}: ${task.title}`);
    if (conflicts.length === 0) return;
    log("system", `Merge conflict in ${conflicts.join(", ")}; ${agent.name} is resolving it`);
    const res = await runAgent({ agent, mode: "worker", prompt: conflictPrompt(task, conflicts), cwd, onLog: log, signal });
    if (signal.aborted || !res.ok || !(await concludeMerge(cwd, conflicts))) {
      await abortMerge(cwd);
      throw new Error(signal.aborted ? "cancelled" : `Could not resolve merge conflict in ${conflicts.join(", ")}`);
    }
    log("system", "Merge conflict resolved");
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

  function retry(taskId: string) {
    const task = db.getTask(taskId);
    if (!task) throw new NotFoundError("Task not found");
    const run = mustRun(task.runId);
    if (task.status !== "failed" || !["running", "failed"].includes(run.status)) throw new ConflictError("Only failed tasks can be retried");
    setTask(task.id, { status: "pending", error: null, startedAt: null, finishedAt: null });
    for (const t of dependentsOf(run.id, task.key)) {
      if (t.status === "blocked") setTask(t.id, { status: "pending", error: null });
    }
    if (run.status !== "running") setRun(run.id, { status: "running", error: null });
    tick(run.id);
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

  return { startRun, revise, approve, retry, cancel };
}

function workerPrompt(run: Run, task: Task, agent: Agent, deps: Task[]) {
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
${deps.length ? `\n## Work already done by teammates (present in this directory)\n${deps.map((d) => `- ${d.title}: ${d.summary}`).join("\n")}\n` : ""}
## Rules
- Work only inside the current directory. Teammates work in parallel on other tasks of the plan, so stay within your task's scope.
- Follow the project's documents in docs/ (product spec, UX, engineering design) where they exist.
- Do not commit, create branches or switch branches. Orchestra commits and merges your work.
- When you are done, reply with a short summary of what you changed and anything a teammate building on your work needs to know.`;
}

function conflictPrompt(task: Task, files: string[]) {
  return `You are resolving a git merge conflict. Your finished work for the task "${task.title}" is being merged with work your teammates already merged.

Conflicted files:
${files.map((f) => `- ${f}`).join("\n")}

Edit each file so it keeps the intent of both sides and contains no conflict markers (<<<<<<<, =======, >>>>>>>). Task description for context:
${task.description}

Do not run git commands; Orchestra completes the merge. Reply with a one-line summary.`;
}
