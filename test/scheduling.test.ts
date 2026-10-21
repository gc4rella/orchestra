import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, DeliveryPolicy, Plan, PlanTask, Run, Runtime } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { MAX_GLOBAL_WORKERS, MAX_PROVIDER_WORKERS } from "../src/server/delivery.ts";
import type { AgentInvocation, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-scheduling-")));
const schedulers: ReturnType<typeof createScheduler>[] = [];
let sequence = 0;
afterAll(async () => {
  await Promise.all(schedulers.map((scheduler) => scheduler.waitForCleanup()));
  rmSync(root, { recursive: true, force: true });
});

async function harness() {
  const directory = join(root, String(sequence++));
  const db = openDb(":memory:");
  const agent = (name: string, runtime: Runtime, role: string) => db.createAgent({ name, runtime, role, model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = agent("Director", "claude-code", DIRECTOR_ROLE);
  const codex = agent("Codex engineer", "codex", "Engineer");
  const claude = agent("Claude engineer", "claude-code", "Engineer");
  const reviewer = agent("Reviewer", "codex", "QA");
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [codex.id, claude.id, reviewer.id] });
  const plans = new Map<string, Plan>();
  const starts: { runId: string; task: string; runtime: Runtime }[] = [];
  const calls: AgentInvocation[] = [];
  const releases = new Map<string, () => void>();
  let hold = true;
  let active = 0;
  let maxActive = 0;
  const activeProviders = new Map<Runtime, number>();
  const maxProviders = new Map<Runtime, number>();
  const workerKey = (runId: string, task: string) => `${runId}:${task}`;
  const runAgent: RunAgent = async (inv) => {
    calls.push(inv);
    const run = db.listRuns().find((candidate) => inv.cwd.includes(candidate.id))!;
    if (inv.mode !== "worker") {
      if (inv.prompt.includes("reviewing a teammate")) return { ok: true, text: "", structured: { verdict: "approve", findings: "" } };
      return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { version: 2, summary: "Accepted", stage: "fix", verify: "", requirements: [], lessons: "", tasks: [] } : plans.get(run.prompt)! };
    }
    const task = basename(inv.cwd);
    starts.push({ runId: run.id, task, runtime: inv.agent.runtime });
    maxActive = Math.max(maxActive, ++active);
    const providerActive = (activeProviders.get(inv.agent.runtime) ?? 0) + 1;
    activeProviders.set(inv.agent.runtime, providerActive);
    maxProviders.set(inv.agent.runtime, Math.max(maxProviders.get(inv.agent.runtime) ?? 0, providerActive));
    if (hold) await new Promise<void>((resolve) => {
      const release = () => { inv.signal?.removeEventListener("abort", release); releases.delete(workerKey(run.id, task)); resolve(); };
      releases.set(workerKey(run.id, task), release);
      inv.signal?.addEventListener("abort", release, { once: true });
      if (inv.signal?.aborted) release();
    });
    active--;
    activeProviders.set(inv.agent.runtime, (activeProviders.get(inv.agent.runtime) ?? 1) - 1);
    if (inv.signal?.aborted) return { ok: false, text: "", error: "cancelled" };
    await Bun.write(join(inv.cwd, `${task}.txt`), task);
    return { ok: true, text: task };
  };
  const scheduler = createScheduler({ db, runAgent, worktreeRoot: join(directory, "worktrees"), publish: () => {} });
  schedulers.push(scheduler);
  const wait = async (predicate: () => boolean) => {
    for (let count = 0; count < 1000; count++) {
      if (predicate()) return;
      await Bun.sleep(5);
    }
    throw new Error(`Scheduler did not settle: ${JSON.stringify(db.listRuns())}`);
  };
  const register = async (name: string, tasks: PlanTask[], options: { delivery?: Partial<DeliveryPolicy>; project?: string } = {}) => {
    const plan: Plan = {
      version: 2, summary: name, stage: "build", verify: "true", lessons: "",
      requirements: [{ id: "delivery", title: "Deliver work", description: "All assigned work is delivered", kind: "command", check: "true", required: true, inputs: [], artifacts: [] }], tasks,
    };
    plans.set(name, plan);
    const run = await scheduler.startRun({ teamId: team.id, prompt: name, workdir: options.project ?? join(directory, `project-${name}`), delivery: { profile: "balanced", strategy: "team", maxParallel: 6, ...options.delivery } });
    await wait(() => db.getRun(run.id)?.status === "awaiting_approval");
    return run;
  };
  const planTask = (id: string, author: Agent, resources: string[] = []): PlanTask => ({
    id, title: id, description: `Implement ${id}`, agentId: author.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "Task is delivered",
    contract: { requirementIds: ["delivery"], inputs: [], outputs: [`${id}.txt`], resources },
  });
  const release = (run: Run, task: string) => releases.get(workerKey(run.id, task))?.();
  const releaseAll = () => { hold = false; for (const release of [...releases.values()]) release(); };
  const finish = async (runs: Run[]) => {
    await wait(() => runs.every((run) => ["completed", "failed"].includes(db.getRun(run.id)!.status)));
    for (const run of runs) {
      const final = db.getRun(run.id)!;
      if (final.status !== "completed") throw new Error(JSON.stringify({ runId: run.id, status: final.status, error: final.error, tasks: db.listTasks(run.id).map((task) => ({ key: task.key, status: task.status, phase: task.phase, error: task.error })), activity: db.listActivity(run.id).slice(-12).map((entry) => entry.text) }));
      expect(final.status).toBe("completed");
    }
  };
  return { db, directory, scheduler, codex, claude, reviewer, starts, calls, maxProviders, get maxActive() { return maxActive; }, register, planTask, wait, release, releaseAll, finish };
}

test("global worker limit applies across runs using both providers and queued work resumes", async () => {
  const h = await harness();
  const first = await h.register("first", Array.from({ length: 4 }, (_, index) => h.planTask(`a${index}`, h.codex)));
  const second = await h.register("second", Array.from({ length: 4 }, (_, index) => h.planTask(`b${index}`, h.claude)));
  try {
    h.scheduler.approve(first.id);
    h.scheduler.approve(second.id);
    await h.wait(() => h.starts.length === MAX_GLOBAL_WORKERS);
    expect(h.db.listTasks(first.id).filter((task) => task.status === "running").length + h.db.listTasks(second.id).filter((task) => task.status === "running").length).toBe(MAX_GLOBAL_WORKERS);
    expect(h.starts.filter((start) => start.runtime === "codex")).toHaveLength(MAX_PROVIDER_WORKERS);
    expect(h.starts.filter((start) => start.runtime === "claude-code")).toHaveLength(MAX_PROVIDER_WORKERS);
    h.releaseAll();
    await h.finish([first, second]);
    expect(h.starts).toHaveLength(8);
    expect(h.maxActive).toBeLessThanOrEqual(MAX_GLOBAL_WORKERS);
  } finally { h.releaseAll(); }
});

test("provider limit is shared by runs and freeing a slot wakes queued work", async () => {
  const h = await harness();
  const first = await h.register("provider-first", Array.from({ length: 4 }, (_, index) => h.planTask(`a${index}`, h.codex)));
  const second = await h.register("provider-second", Array.from({ length: 2 }, (_, index) => h.planTask(`b${index}`, h.codex)));
  try {
    h.scheduler.approve(first.id);
    h.scheduler.approve(second.id);
    await h.wait(() => h.starts.length === MAX_PROVIDER_WORKERS);
    expect(h.db.listTasks(second.id).every((task) => task.status === "pending")).toBe(true);
    h.release(first, h.starts[0]!.task);
    await h.wait(() => h.starts.length === MAX_PROVIDER_WORKERS + 1);
    expect(h.maxProviders.get("codex")).toBeLessThanOrEqual(MAX_PROVIDER_WORKERS);
    h.releaseAll();
    await h.finish([first, second]);
    expect(h.starts).toHaveLength(6);
  } finally { h.releaseAll(); }
});

test("resource claims serialize runs of the same project and release without deadlocking", async () => {
  const h = await harness();
  const project = join(h.directory, "shared-project");
  const first = await h.register("resource-first", [h.planTask("schema-a", h.codex, ["database-schema"])], { project });
  const second = await h.register("resource-second", [h.planTask("schema-b", h.claude, ["database-schema"])], { project });
  try {
    h.scheduler.approve(first.id);
    h.scheduler.approve(second.id);
    await h.wait(() => h.starts.length === 1);
    expect(h.starts[0]!.runId).toBe(first.id);
    expect(h.db.listTasks(second.id)[0]!.status).toBe("pending");
    h.release(first, "schema-a");
    await h.wait(() => h.starts.length === 2);
    expect(h.starts[1]!.runId).toBe(second.id);
    h.releaseAll();
    await h.finish([first, second]);
    expect(h.maxActive).toBe(1);
  } finally { h.releaseAll(); }
});

test("Economy serializes independent work even when the requested team parallelism is larger", async () => {
  const h = await harness();
  const run = await h.register("economy", [h.planTask("one", h.codex), h.planTask("two", h.claude), h.planTask("three", h.codex)], { delivery: { profile: "economy", strategy: "team", maxParallel: 6 } });
  try {
    h.scheduler.approve(run.id);
    await h.wait(() => h.starts.length === 1);
    expect(h.db.listTasks(run.id).filter((task) => task.status === "running")).toHaveLength(1);
    h.releaseAll();
    await h.finish([run]);
    expect(h.starts).toHaveLength(3);
    expect(h.maxActive).toBe(1);
  } finally { h.releaseAll(); }
});

test("project aliases share exclusive resource claims", async () => {
  const h = await harness();
  const project = join(h.directory, "real-project");
  const alias = join(h.directory, "project-alias");
  const first = await h.register("alias-first", [h.planTask("schema-a", h.codex, ["database-schema"])], { project });
  symlinkSync(project, alias, "dir");
  const second = await h.register("alias-second", [h.planTask("schema-b", h.claude, ["database-schema"])], { project: alias });
  try {
    h.scheduler.approve(first.id);
    h.scheduler.approve(second.id);
    await h.wait(() => h.starts.length === 1);
    expect(h.db.listTasks(second.id)[0]!.status).toBe("pending");
    h.releaseAll();
    await h.finish([first, second]);
    expect(h.maxActive).toBe(1);
  } finally { h.releaseAll(); }
});

test("Quality assigns independent task reviewers when the Director omitted reviewers", async () => {
  const h = await harness();
  const run = await h.register("quality", [h.planTask("one", h.codex), h.planTask("two", h.claude)], { delivery: { profile: "quality", maxParallel: 2 } });
  try {
    h.releaseAll();
    h.scheduler.approve(run.id);
    await h.finish([run]);
    const tasks = h.db.listTasks(run.id);
    expect(tasks.every((task) => task.reviewerId && task.reviewerId !== task.agentId)).toBe(true);
    const reviews = h.calls.filter((call) => call.prompt.includes("reviewing a teammate"));
    expect(reviews.filter((call) => !call.prompt.includes("Final quality review"))).toHaveLength(tasks.length);
    expect(reviews.filter((call) => call.prompt.includes("Final quality review"))).toHaveLength(1);
    expect(tasks.every((task) => task.handoff?.review?.verdict === "approve")).toBe(true);
  } finally { h.releaseAll(); }
});

test("Quality retains independent final review for a team with one worker", async () => {
  const h = await harness();
  const run = await h.register("quality-single", [h.planTask("one", h.codex)], { delivery: { profile: "quality", strategy: "single", maxParallel: 1 } });
  const team = h.db.listTeams()[0]!;
  h.db.updateTeam(team.id, { name: team.name, directorId: team.directorId, memberIds: [h.codex.id] });
  try {
    h.releaseAll();
    h.scheduler.approve(run.id);
    await h.finish([run]);
    const review = h.calls.find((call) => call.prompt.includes("reviewing a teammate") && call.prompt.includes("Final quality review"));
    expect(review?.agent.id).toBe(team.directorId);
    expect(review?.agent.id).not.toBe(h.codex.id);
    expect(h.db.listEvidence(run.id).find((entry) => entry.command === "independent quality review")).toMatchObject({ scope: "acceptance", commit: h.db.getRun(run.id)!.acceptedCommit, status: "passed" });
  } finally { h.releaseAll(); }
});

test("soft pause settles a queued reviewer without waiting for another run's provider slots", async () => {
  const h = await harness();
  const busy = await h.register("provider-busy", Array.from({ length: 3 }, (_, index) => h.planTask(`busy${index}`, h.codex)));
  const paused = await h.register("queued-review", [{ ...h.planTask("change", h.claude), reviewerId: h.reviewer.id }]);
  try {
    h.scheduler.approve(busy.id);
    h.scheduler.approve(paused.id);
    await h.wait(() => h.starts.length === 4);
    h.release(paused, "change");
    await h.wait(() => h.db.listTasks(paused.id)[0]!.phase === "review");
    h.scheduler.pause(paused.id);
    for (let count = 0; count < 100 && h.db.getRun(paused.id)!.status !== "paused"; count++) await Bun.sleep(5);
    expect(h.db.getRun(paused.id)!.status).toBe("paused");
    expect(h.db.getRun(busy.id)!.status).toBe("running");
    expect(h.calls.filter((call) => call.prompt.includes("reviewing a teammate"))).toHaveLength(0);
  } finally {
    if (["running", "planning", "pausing", "paused"].includes(h.db.getRun(paused.id)!.status)) h.scheduler.cancel(paused.id);
    h.releaseAll();
    await h.finish([busy]);
  }
});
