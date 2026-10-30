import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import type { AgentInvocation, AgentResult } from "../src/server/runtimes.ts";
import type { Plan, Runtime } from "../src/shared/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-check-capacity-")));
const fixtures: { db: ReturnType<typeof openDb>; scheduler: ReturnType<typeof createScheduler> }[] = [];
afterAll(async () => {
  for (const fixture of fixtures) {
    await fixture.scheduler.waitForCleanup();
    await fixture.scheduler.shutdownPreviews();
    fixture.db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((release) => { resolve = release; });
  return { promise, resolve };
}
async function wait(check: () => boolean, message: string) {
  for (let attempt = 0; attempt < 1_000; attempt++) {
    if (check()) return;
    await Bun.sleep(10);
  }
  throw new Error(message);
}
function setup(options: {
  count: number;
  work: (inv: AgentInvocation) => Promise<AgentResult>;
  check?: NonNullable<Parameters<typeof createScheduler>[0]["runCheck"]>;
  quota?: NonNullable<Parameters<typeof createScheduler>[0]["getQuota"]>;
}) {
  const home = join(root, `fixture-${fixtures.length}`);
  const db = openDb(":memory:");
  const make = (name: string, runtime: Runtime, limited = false) => db.createAgent({ name, runtime, role: "Engineer", model: "fixture", effort: null, expertise: "", skills: [], instructions: null, rateLimitPolicy: limited ? { maxUsedPercent: 99, window: "5h" } : null });
  const director = make("Director", "codex");
  const workers = [make("Claude worker", "claude-code", !!options.quota), make("Codex worker", "codex", !!options.quota)];
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: workers.map((worker) => worker.id) });
  const plan: Plan = { summary: "Deliver independent fixtures", stage: "build", verify: "verify-fixture", lessons: "", tasks: Array.from({ length: options.count }, (_, index) => ({ id: `task-${index}`, title: `Task ${index}`, description: "Write an independent file", acceptanceCriteria: "The file works", agentId: workers[index % workers.length]!.id, reviewerId: "", dependsOn: [] })) };
  const calls: AgentInvocation[] = [];
  const scheduler = createScheduler({ db, worktreeRoot: join(home, "worktrees"), runCheck: options.check ?? (async () => ({ ok: true, output: "Fixture checked" })), getQuota: options.quota, publish() {}, runAgent: async (inv) => {
    calls.push(inv);
    if (inv.mode === "worker") return options.work(inv);
    return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { summary: "Accepted", stage: "fix", verify: plan.verify, lessons: "", tasks: [] } : plan };
  } });
  fixtures.push({ db, scheduler });
  const start = async () => {
    const run = await scheduler.startRun({ teamId: team.id, prompt: "Deliver bounded independent fixtures", workdir: join(home, "project"), autonomous: false, delivery: { profile: "speed", strategy: "team", maxParallel: 6 } });
    await wait(() => ["awaiting_approval", "failed"].includes(db.getRun(run.id)!.status), "Planning did not settle");
    expect(db.getRun(run.id)!.status).toBe("awaiting_approval");
    scheduler.approve(run.id);
    return run;
  };
  return { db, scheduler, calls, start };
}

for (const stop of ["pause", "cancel"] as const) {
  test(`${stop} during quota preparation does not spend an invocation or start its worker`, async () => {
    const preparation = gate();
    let reading = false;
    const fixture = setup({ count: 1, quota: async () => {
      reading = true;
      await preparation.promise;
      return [{ window: "5h", usedPercent: 0, resetsAt: Date.now() + 60_000 }];
    }, work: async (inv) => {
      await Bun.write(join(inv.cwd, "delivered.txt"), "delivered\n");
      return { ok: true, text: "Delivered" };
    } });
    const run = await fixture.start();
    try {
      await wait(() => reading, "Worker never reached quota preparation");
      expect(fixture.db.getRun(run.id)!.agentCalls).toBe(1);
      fixture.scheduler[stop](run.id);
      preparation.resolve();
      await wait(() => fixture.db.listTasks(run.id).every((task) => task.status !== "running"), "Preparation did not settle after stop");
      expect(fixture.db.getRun(run.id)!.agentCalls).toBe(1);
      expect(fixture.calls.filter((inv) => inv.mode === "worker")).toHaveLength(0);
      expect(fixture.db.listAudit(run.id).filter((record) => record.kind === "invocation-started")).toHaveLength(1);
      if (stop === "pause") {
        expect(fixture.db.getRun(run.id)!.status).toBe("paused");
        fixture.scheduler.resume(run.id);
        await wait(() => ["completed", "failed", "paused"].includes(fixture.db.getRun(run.id)!.status), "Resumed work did not finish");
        expect(fixture.db.getRun(run.id)!.status).toBe("completed");
        expect(fixture.db.getRun(run.id)!.agentCalls).toBe(3);
        expect(fixture.calls.filter((inv) => inv.mode === "worker")).toHaveLength(1);
      } else expect(fixture.db.getRun(run.id)!.status).toBe("cancelled");
    } finally { preparation.resolve(); }
  });
}

// Nine real worktrees and their serialized integration checks can exceed Bun's default five seconds.
test("pipelined tasks retain six global/three provider agent caps, six checks, and safely pause queued checks", async () => {
  const workersGate = gate(), checksGate = gate();
  let holdWorkers = true;
  let activeWorkers = 0, maxWorkers = 0, activeChecks = 0, maxChecks = 0, checksStarted = 0;
  const activeByProvider: Record<Runtime, number> = { "claude-code": 0, codex: 0 };
  const maxByProvider: Record<Runtime, number> = { "claude-code": 0, codex: 0 };
  const workerCounts = new Map<string, number>();
  const runningCheckSignals: AbortSignal[] = [];
  const fixture = setup({ count: 9, work: async (inv) => {
    const key = basename(inv.cwd), runtime = inv.agent.runtime;
    workerCounts.set(key, (workerCounts.get(key) ?? 0) + 1);
    activeWorkers++;
    activeByProvider[runtime]++;
    maxWorkers = Math.max(maxWorkers, activeWorkers);
    maxByProvider[runtime] = Math.max(maxByProvider[runtime], activeByProvider[runtime]);
    try {
      if (holdWorkers) await workersGate.promise;
      await Bun.write(join(inv.cwd, `${key}.txt`), "delivered\n");
      return { ok: true, text: "Delivered" };
    } finally { activeWorkers--; activeByProvider[runtime]--; }
  }, check: async (_cwd, _command, signal) => {
    checksStarted++;
    activeChecks++;
    maxChecks = Math.max(maxChecks, activeChecks);
    if (signal) runningCheckSignals.push(signal);
    try {
      await checksGate.promise;
      return { ok: true, output: "Checked" };
    } finally { activeChecks--; }
  } });
  const run = await fixture.start();
  try {
    await wait(() => activeWorkers === 6, "Agent slots never reached the global cap");
    expect(activeByProvider).toEqual({ "claude-code": 3, codex: 3 });
    expect(workerCounts.size).toBe(6);
    holdWorkers = false;
    workersGate.resolve();
    await wait(() => workerCounts.size === 9 && checksStarted === 6 && fixture.db.listTasks(run.id).every((task) => task.phase === "check"), "Pipeline did not queue the remaining task checks");
    await Bun.sleep(30);
    fixture.scheduler.pause(run.id);
    await wait(() => fixture.db.listTasks(run.id).filter((task) => task.status === "pending" && task.phase === "check").length === 3, "Queued checks did not settle on soft pause");
    expect(fixture.db.getRun(run.id)!.status).toBe("pausing");
    expect(activeChecks).toBe(6);
    expect(checksStarted).toBe(6);
    expect(runningCheckSignals.every((signal) => !signal.aborted)).toBe(true);
    checksGate.resolve();
    await wait(() => fixture.db.getRun(run.id)!.status === "paused", "Running checks did not finish the pause");
    expect(checksStarted).toBe(6);
    expect(fixture.db.listTasks(run.id).filter((task) => task.phase === "review")).toHaveLength(6);
    fixture.scheduler.resume(run.id);
    await wait(() => ["completed", "failed", "paused"].includes(fixture.db.getRun(run.id)!.status), "Resumed checks did not finish");
    expect(fixture.db.getRun(run.id)!.status).toBe("completed");
    expect(fixture.db.listTasks(run.id).every((task) => task.status === "done")).toBe(true);
    expect([...workerCounts.values()]).toEqual(Array(9).fill(1));
    expect(maxWorkers).toBe(6);
    expect(maxByProvider).toEqual({ "claude-code": 3, codex: 3 });
    expect(maxChecks).toBe(6);
  } finally {
    workersGate.resolve();
    checksGate.resolve();
    if (["planning", "running"].includes(fixture.db.getRun(run.id)!.status)) fixture.scheduler.pause(run.id);
    await wait(() => !["planning", "running", "pausing"].includes(fixture.db.getRun(run.id)!.status), "Fixture did not stop before cleanup");
    await fixture.scheduler.waitForCleanup();
  }
}, 20_000);
