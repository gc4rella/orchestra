import { afterAll, expect, spyOn, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan, Run } from "../src/shared/types.ts";
import { DEFAULT_RUN_TIMEOUTS } from "../src/shared/types.ts";
import * as checks from "../src/server/checks.ts";
import { openDb } from "../src/server/db.ts";
import { startServer } from "../src/server/http.ts";
import type { AgentInvocation } from "../src/server/runtimes.ts";
import { createScheduler, MAX_INTEGRATION_PROBES, MAX_ITERATIONS } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-timeouts-")));
const fixtures: { db: ReturnType<typeof openDb>; scheduler: ReturnType<typeof createScheduler>; server: ReturnType<typeof startServer> }[] = [];
let sequence = 0;
afterAll(async () => {
  for (const { db, scheduler, server } of fixtures) {
    for (const run of db.listRuns()) if (["planning", "awaiting_approval", "running", "pausing"].includes(run.status)) scheduler.cancel(run.id);
    await scheduler.waitForCleanup();
    await scheduler.shutdownPreviews();
    server.stop(true);
    db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function fixture(verify = "printf combined-check", options: Pick<Parameters<typeof createScheduler>[0], "getQuota" | "scheduleRateLimitRetry"> = {}) {
  const dir = join(root, `fixture-${sequence++}`);
  const workdir = join(dir, "project");
  const db = openDb(":memory:");
  const createAgent = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = createAgent("Director", "Director");
  const engineer = createAgent("Engineer", "Engineer");
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [engineer.id] });
  const plan: Plan = {
    version: 2, summary: "Deliver the checked feature", stage: "build", verify, lessons: "",
    requirements: [{ id: "feature", title: "Feature works", description: "The feature passes its independent command", kind: "command", check: "printf requirement-check", required: true, inputs: [], artifacts: [] }],
    tasks: [{ id: "implement", title: "Implement", description: "Write feature.txt", agentId: engineer.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "Feature works", contract: { requirementIds: ["feature"], inputs: [], outputs: ["feature.txt"], resources: [] } }],
  };
  const calls: AgentInvocation[] = [];
  const runAgent = async (invocation: AgentInvocation) => {
    calls.push(invocation);
    if (invocation.mode === "worker") { await Bun.write(join(invocation.cwd, "feature.txt"), "working"); return { ok: true, text: "Implemented" }; }
    return { ok: true, text: "", structured: invocation.prompt.includes("## Verification") ? { ...plan, summary: "Verified", stage: "fix", requirements: [], tasks: [] } : plan };
  };
  const scheduler = createScheduler({ db, runAgent, worktreeRoot: join(dir, "worktrees"), publish: () => {}, ...options });
  const server = startServer({ db, scheduler, runAgent, port: 0, ensureSkills: async () => [], searchSkills: async () => [] });
  const post = (path: string, body: unknown) => fetch(`http://127.0.0.1:${server.port}${path}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
  const wait = async (id: string, statuses: Run["status"][]) => {
    for (let attempt = 0; attempt < 600; attempt++) {
      const run = db.getRun(id)!;
      if (statuses.includes(run.status)) return run;
      await Bun.sleep(10);
    }
    throw new Error(`Run did not settle: ${JSON.stringify(db.getRun(id))}`);
  };
  const result = { db, scheduler, server, team, director, engineer, workdir, plan, calls, post, wait };
  fixtures.push(result);
  return result;
}

test("stored runs without timeout settings receive defaults and saved settings survive reopening", () => {
  const path = join(root, "stored.db");
  let db = openDb(path);
  const director = db.createAgent({ name: "Director", role: "Director", runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const timeouts = { agentMs: 7 * 60_000, checkMs: 3 * 60_000 };
  for (const id of ["older", "partial", "configured"]) db.createRun({ id, prompt: "Build", workdir: root, directorAgentId: director.id, baseCommit: "base", branch: `orchestra/${id}`, warning: null, timeouts });
  db.close();
  const raw = new Database(path);
  raw.query("UPDATE runs SET control_json = ? WHERE id = ?").run(JSON.stringify({ agentCalls: 9, activeElapsedMs: 1234, cycle: 4 }), "older");
  raw.query("UPDATE runs SET control_json = ? WHERE id = ?").run(JSON.stringify({ timeouts: { agentMs: timeouts.agentMs } }), "partial");
  raw.close();
  db = openDb(path);
  try {
    expect(db.getRun("older")).toMatchObject({ timeouts: DEFAULT_RUN_TIMEOUTS, agentCalls: 9, activeElapsedMs: 1234, cycle: 4 });
    expect(db.getRun("partial")!.timeouts).toEqual({ ...DEFAULT_RUN_TIMEOUTS, agentMs: timeouts.agentMs });
    expect(db.getRun("configured")!.timeouts).toEqual(timeouts);
  } finally { db.close(); }
});

test("invalid timeout values fail start and resume validation before files, calls or budgets change", async () => {
  const f = fixture();
  const seed = f.db.createRun({ id: "validation", prompt: "Build", workdir: f.workdir, directorAgentId: f.director.id, baseCommit: "base", branch: "orchestra/validation", warning: null });
  f.db.updateRun(seed.id, { status: "paused", checkpoint: "approve", agentCalls: 5, activeElapsedMs: 1234 });
  const valid = { agentMs: 5 * 60_000, checkMs: 60_000 };
  const invalid = [null, {}, { ...valid, agentMs: 299_999 }, { ...valid, agentMs: 240 * 60_000 + 1 }, { ...valid, checkMs: 59_999 }, { ...valid, checkMs: 120 * 60_000 + 1 }, { ...valid, agentMs: 300_000.5 }, { ...valid, checkMs: "60000" }, { ...valid, extra: true }];
  for (const timeouts of invalid) {
    expect((await f.post("/api/runs", { teamId: f.team.id, prompt: "Build", workdir: f.workdir, timeouts })).status).toBe(400);
    expect((await f.post(`/api/runs/${seed.id}/resume`, { timeouts })).status).toBe(400);
  }
  await expect(f.scheduler.startRun({ teamId: f.team.id, prompt: "Build", workdir: f.workdir, timeouts: { ...valid, agentMs: 0 } })).rejects.toThrow("timeout");
  expect(() => f.scheduler.resume(seed.id, { timeouts: { ...valid, checkMs: 0 } })).toThrow("timeout");
  expect(existsSync(f.workdir)).toBe(false);
  expect(f.calls).toHaveLength(0);
  expect(f.db.getRun(seed.id)).toMatchObject({ status: "paused", agentCalls: 5, activeElapsedMs: 1234, timeouts: DEFAULT_RUN_TIMEOUTS });
});

test("start and resume persist timeout changes, forward them to calls and preserve consumed budgets", async () => {
  const f = fixture();
  const initial = { agentMs: 7 * 60_000, checkMs: 3 * 60_000 };
  const response = await f.post("/api/runs", { teamId: f.team.id, prompt: "Build", workdir: f.workdir, timeouts: initial, limits: { maxDurationMs: 60_000, maxAgentCalls: 20 } });
  expect(response.status).toBe(200);
  const created = await response.json() as Run;
  expect(created.timeouts).toEqual(initial);
  await f.wait(created.id, ["awaiting_approval", "failed"]);
  expect(f.calls[0]!.timeoutMs).toBe(initial.agentMs);
  expect((await f.post(`/api/runs/${created.id}/pause`, {})).status).toBe(200);
  await f.wait(created.id, ["paused"]);
  f.db.updateRun(created.id, { agentCalls: 4, activeElapsedMs: 1234, recoveries: 1, fixRounds: 1 });
  const changed = { agentMs: 9 * 60_000, checkMs: 4 * 60_000 };
  const resumed = await f.post(`/api/runs/${created.id}/resume`, { timeouts: changed });
  expect(resumed.status).toBe(200);
  expect(f.db.getRun(created.id)).toMatchObject({ status: "awaiting_approval", timeouts: changed, agentCalls: 4, activeElapsedMs: 1234, recoveries: 1, fixRounds: 1, limits: created.limits });
  f.scheduler.approve(created.id);
  expect((await f.wait(created.id, ["completed", "failed"])).status).toBe("completed");
  expect(f.calls.slice(1).every((call) => call.timeoutMs === changed.agentMs)).toBe(true);
  expect(f.db.getRun(created.id)!.agentCalls).toBe(4 + f.calls.length - 1);
  expect(f.db.getRun(created.id)!.activeElapsedMs).toBeGreaterThanOrEqual(1234);
});

for (const continuation of ["timer", "manual"] as const) {
  test(`quota waits retain resume options and guidance once through a later ${continuation} continuation`, async () => {
    let usedPercent = 20;
    let reads = 0;
    const callbacks: (() => Promise<void>)[] = [];
    const f = fixture("printf combined-check", {
      getQuota: async () => { reads++; return [{ window: "weekly", usedPercent, resetsAt: Date.now() + 3600_000 }]; },
      scheduleRateLimitRetry: ((callback: () => Promise<void>) => { callbacks.push(callback); return setTimeout(() => {}, 2_000_000); }) as typeof setTimeout,
    });
    const run = f.db.createRun({ id: `quota-${continuation}`, prompt: "Build", workdir: f.workdir, directorAgentId: f.director.id, baseCommit: "base", branch: `orchestra/quota-${continuation}`, warning: null, limits: { maxDurationMs: 60_000, maxAgentCalls: 10 } });
    f.db.updateRun(run.id, { status: "paused", checkpoint: "approve", plan: f.plan, quotaWait: { agentId: f.director.id, window: "weekly", attempts: 1 }, pauseReason: "Usage safeguard: waiting for 100% available", agentCalls: 4, activeElapsedMs: 1234, recoveries: 1, fixRounds: 1, cycle: 3, guidance: "Earlier note" });
    const timeouts = { agentMs: 9 * 60_000, checkMs: 4 * 60_000 };
    const limits = { maxDurationMs: 120_000, maxAgentCalls: 20 };
    const saved = f.scheduler.resume(run.id, { timeouts, limits, guidance: "Keep changes focused.", autoContinueOnRateLimit: true });
    expect(saved).toMatchObject({ status: "paused", timeouts, limits, autoContinueOnRateLimit: true, agentCalls: 4, activeElapsedMs: 1234, recoveries: 1, fixRounds: 1, cycle: 3, checkpoint: "approve" });
    expect(saved.guidance).toBe("Earlier note\n\nKeep changes focused.");
    for (let attempt = 0; attempt < 100 && f.db.getRun(run.id)!.quotaWait?.attempts !== 2; attempt++) await Bun.sleep(5);
    const waiting = f.db.getRun(run.id)!;
    expect(waiting).toMatchObject({ status: "paused", timeouts, limits, quotaWait: { attempts: 2 }, agentCalls: 4, activeElapsedMs: 1234 });
    expect(callbacks.length).toBeGreaterThan(0);
    expect(reads).toBe(1);
    usedPercent = 0;
    if (continuation === "timer") await callbacks.pop()!();
    else f.scheduler.resume(run.id);
    const resumed = await f.wait(run.id, ["awaiting_approval"]);
    expect(resumed).toMatchObject({ timeouts, limits, autoContinueOnRateLimit: true, quotaWait: null, agentCalls: 4, activeElapsedMs: 1234, recoveries: 1, fixRounds: 1, cycle: 3, checkpoint: "approve" });
    expect(resumed.guidance).toBe("Earlier note\n\nKeep changes focused.");
    expect(reads).toBe(2);
    expect(f.calls).toHaveLength(0);
  });
}

test("configured check timeout reaches task, candidate, requirement and detached acceptance checks", async () => {
  const observed: { cwd: string; command: string; timeoutMs: number | undefined }[] = [];
  const realCheck = checks.runCheck;
  const spy = spyOn(checks, "runCheck").mockImplementation((cwd, command, signal, timeoutMs) => { observed.push({ cwd, command, timeoutMs }); return realCheck(cwd, command, signal, timeoutMs); });
  try {
    const f = fixture();
    const timeouts = { agentMs: 6 * 60_000, checkMs: 2 * 60_000 };
    const run = await f.scheduler.startRun({ teamId: f.team.id, prompt: "Build", workdir: f.workdir, timeouts, autonomous: true });
    expect((await f.wait(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(observed.every((check) => check.timeoutMs === timeouts.checkMs)).toBe(true);
    expect(observed.some((check) => check.cwd.endsWith("/implement") && check.command === "printf combined-check")).toBe(true);
    expect(observed.some((check) => check.cwd.includes("/.candidate/") && check.command === "printf combined-check")).toBe(true);
    expect(observed.some((check) => check.cwd.includes("/.candidate/") && check.command === "printf requirement-check")).toBe(true);
    expect(observed.some((check) => check.cwd.includes("/.acceptance/") && check.command === "printf combined-check")).toBe(true);
    expect(observed.some((check) => check.cwd.includes("/.acceptance/") && check.command === "printf requirement-check")).toBe(true);
  } finally { spy.mockRestore(); }
});

test("a saved short check timeout stops task verification without publishing unchecked work", async () => {
  const f = fixture("sleep 1");
  const run = await f.scheduler.startRun({ teamId: f.team.id, prompt: "Build", workdir: f.workdir });
  await f.wait(run.id, ["awaiting_approval", "failed"]);
  f.db.updateRun(run.id, { timeouts: { ...run.timeouts, checkMs: 30 } });
  f.scheduler.approve(run.id);
  expect((await f.wait(run.id, ["failed", "paused", "completed"])).status).toBe("failed");
  const task = f.db.listTasks(run.id)[0]!;
  expect(task).toMatchObject({ status: "failed", iterations: MAX_ITERATIONS, mergeCommit: null, handoff: { check: { ok: false } } });
  expect(task.handoff!.check!.output).toContain("Timed out");
  expect(f.db.getRun(run.id)!.acceptedCommit).toBe(run.baseCommit);
  expect(f.db.listEvidence(run.id).filter((evidence) => evidence.scope === "task").every((evidence) => evidence.status === "failed")).toBe(true);
});

test("integration diagnosis keeps its tighter timeout and bounded probe count", async () => {
  const probeTimeouts: (number | undefined)[] = [];
  const realCheck = checks.runCheck;
  const spy = spyOn(checks, "runCheck").mockImplementation((cwd, command, signal, timeoutMs) => {
    if (cwd.includes("/.candidate/")) return Promise.resolve({ ok: false, output: "Candidate needs rework" });
    if (cwd.includes("/.diagnosis/")) probeTimeouts.push(timeoutMs);
    return realCheck(cwd, command, signal, timeoutMs);
  });
  try {
    const f = fixture();
    const run = await f.scheduler.startRun({ teamId: f.team.id, prompt: "Build", workdir: f.workdir, timeouts: { agentMs: 5 * 60_000, checkMs: 2 * 60_000 } });
    await f.wait(run.id, ["awaiting_approval", "failed"]);
    f.scheduler.approve(run.id);
    expect((await f.wait(run.id, ["failed", "paused", "completed"])).status).toBe("failed");
    expect(probeTimeouts.length).toBeGreaterThan(0);
    expect(probeTimeouts.length).toBeLessThanOrEqual(MAX_ITERATIONS * MAX_INTEGRATION_PROBES);
    expect(probeTimeouts.every((timeout) => timeout === 30_000)).toBe(true);
    expect(f.db.getRun(run.id)!.acceptedCommit).toBe(run.baseCommit);
  } finally { spy.mockRestore(); }
});
