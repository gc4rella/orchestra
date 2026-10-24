import { afterAll, afterEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb, type Db } from "../src/server/db.ts";
import { createScheduler, type Scheduler } from "../src/server/scheduler.ts";
import { startServer } from "../src/server/http.ts";
import type { AgentInvocation, AgentResult, RunAgent } from "../src/server/runtimes.ts";
import type { QuotaWindow, Run, ServerEvent } from "../src/shared/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-chat-")));
const fixtures: { db: Db; scheduler: Scheduler; run: Run }[] = [];
afterEach(async () => {
  for (const { db, scheduler, run } of fixtures.splice(0)) {
    if (["planning", "running", "awaiting_approval", "pausing", "paused"].includes(db.getRun(run.id)!.status)) scheduler.cancel(run.id);
    await waitFor(() => db.listTasks(run.id).every((task) => task.status !== "running"));
    await scheduler.waitForCleanup();
    db.close();
  }
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function waitFor(predicate: () => boolean) {
  for (let i = 0; i < 500; i++) { if (predicate()) return; await Bun.sleep(10); }
  throw new Error("Chat fixture did not settle");
}

async function setup(answer: RunAgent = async () => ({ ok: true, text: "We are building checkout.", usage: { tokens: 42, costUsd: 0.01 } }), options: { working?: boolean; getQuota?: () => Promise<QuotaWindow[]>; quotaPollMs?: number } = {}) {
  const db = openDb(":memory:");
  const input = { runtime: "claude-code" as const, model: null, effort: null, expertise: "", skills: [], instructions: null };
  const boss = db.createAgent({ ...input, name: "Boss", role: "Director" });
  const dev = db.createAgent({ ...input, name: "Dev", role: "Engineer" });
  const team = db.createTeam({ name: "Team", directorId: boss.id, memberIds: [dev.id] });
  const dir = join(root, crypto.randomUUID());
  const workdir = join(dir, "project");
  const worktreeRoot = join(dir, "worktrees");
  const calls: AgentInvocation[] = [];
  const events: ServerEvent[] = [];
  const scheduler = createScheduler({ db, worktreeRoot, getQuota: options.getQuota, quotaPollMs: options.quotaPollMs, publish: (_, event) => events.push(event), runAgent: async (inv) => {
    calls.push(inv);
    if (inv.mode === "worker") {
      await Bun.write(join(inv.cwd, "draft.txt"), "unmerged work");
      return new Promise((resolve) => {
        const stop = () => resolve({ ok: false, text: "", error: "Stopped" });
        if (inv.signal?.aborted) stop(); else inv.signal?.addEventListener("abort", stop, { once: true });
      });
    }
    if (inv.schema) return { ok: true, text: "", structured: { summary: "Build checkout", stage: "build", verify: "", lessons: "", tasks: [
      { id: "checkout", title: "Build checkout", description: "Build the checkout", acceptanceCriteria: "Works", agentId: dev.id, reviewerId: "", dependsOn: [] },
    ] } };
    return answer(inv);
  } });
  const run = await scheduler.startRun({ prompt: "Build a checkout", workdir, teamId: team.id, preview: { enabled: false, command: "" } });
  await waitFor(() => db.getRun(run.id)!.status === "awaiting_approval");
  if (options.working !== false) {
    scheduler.approve(run.id);
    await waitFor(() => calls.some((inv) => inv.mode === "worker"));
  }
  const fixture = { db, scheduler, run, calls, events, worktreeRoot };
  fixtures.push(fixture);
  return fixture;
}

test("side chat replies while a worker runs, retaining context and metering usage without steering the team", async () => {
  const { db, scheduler, run, calls, events, worktreeRoot } = await setup();
  db.setMemory(run.workdir, "Use SQLite");
  const before = db.getRun(run.id)!;
  const task = db.listTasks(run.id)[0]!;
  const turn = scheduler.sendDirectorChat(run.id, " What are we building? ");
  expect(turn).toMatchObject({ text: "What are we building?", status: "pending" });
  await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "completed");
  expect(scheduler.directorChat(run.id)[0]?.reply).toBe("We are building checkout.");
  const chat = calls.find((inv) => inv.mode === "readonly" && !inv.schema)!;
  expect(chat.cwd).toBe(join(worktreeRoot, run.id, ".chat", "integration"));
  expect(chat.prompt).toContain('"status":"running"');
  expect(chat.prompt).toContain("What are we building?");
  expect(chat.prompt).toContain("Use SQLite");
  expect(chat.nativeDelegation).toBe(false);
  expect(chat.resume).toBeUndefined();
  expect(existsSync(chat.cwd)).toBe(false);
  expect(db.getRun(run.id)).toMatchObject({ status: "running", guidance: before.guidance, plan: before.plan, agentCalls: before.agentCalls, chatCalls: 1, tokens: 42, costUsd: 0.01 });
  expect(db.getTask(task.id)).toEqual(task);
  expect(events.filter((event) => event.type === "director-chat")).toHaveLength(2);
  scheduler.sendDirectorChat(run.id, "Why that approach?");
  await waitFor(() => scheduler.directorChat(run.id)[1]?.status === "completed");
  expect(calls.at(-1)!.prompt).toContain('"director":"We are building checkout."');
  expect(Bun.spawnSync(["git", "rev-parse", "HEAD"], { cwd: run.workdir }).stdout.toString().trim()).toBe(run.baseCommit);
  expect(existsSync(join(run.workdir, "draft.txt"))).toBe(false);
});

test("one reply per run, read-only snapshot, and cancellation ignores a late answer", async () => {
  let finish!: (result: AgentResult) => void;
  let invocation!: AgentInvocation;
  const { db, scheduler, run, calls } = await setup((inv) => {
    invocation = inv;
    return new Promise((resolve) => { finish = resolve; });
  });
  scheduler.sendDirectorChat(run.id, "How far along are we?");
  expect(() => scheduler.sendDirectorChat(run.id, "Another question")).toThrow("Wait for the Director");
  await waitFor(() => !!finish);
  expect(existsSync(join(invocation.cwd, "draft.txt"))).toBe(false);
  expect(invocation.mode).toBe("readonly");
  expect(calls.filter((inv) => inv.mode === "worker")).toHaveLength(1);
  scheduler.cancel(run.id);
  expect(invocation.signal?.aborted).toBe(true);
  finish({ ok: true, text: "late answer", usage: { tokens: 9, costUsd: null } });
  await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "failed");
  expect(scheduler.directorChat(run.id)[0]?.reply).toBe("");
  expect(db.getRun(run.id)).toMatchObject({ status: "cancelled", tokens: 9 });
});

test("chat errors stay in the conversation and a later question can succeed", async () => {
  let attempt = 0;
  const { db, scheduler, run } = await setup(async () => {
    if (++attempt === 1) throw new Error("CLI unavailable");
    return { ok: true, text: attempt === 2 ? "" : "Back now." };
  });
  for (let i = 0; i < 3; i++) {
    scheduler.sendDirectorChat(run.id, "What is next?");
    await waitFor(() => scheduler.directorChat(run.id)[i]?.status !== "pending");
  }
  expect(scheduler.directorChat(run.id)).toMatchObject([
    { status: "failed", error: "CLI unavailable" },
    { status: "failed", error: expect.stringContaining("empty reply") },
    { status: "completed", reply: "Back now." },
  ]);
  expect(db.getRun(run.id)).toMatchObject({ status: "running", error: null, guidance: "" });
});

test("chat validates questions before creating history or reserving another call", async () => {
  const { db, scheduler, run, calls } = await setup();
  const before = calls.length;
  expect(() => scheduler.sendDirectorChat(run.id, " ")).toThrow("characters");
  expect(() => scheduler.sendDirectorChat(run.id, "x".repeat(10001))).toThrow("characters");
  expect(scheduler.directorChat(run.id)).toEqual([]);
  expect(calls).toHaveLength(before);
  expect(() => scheduler.directorChat("missing")).toThrow("Run not found");
});

test("chat works between plans and after work stops, even with exhausted work budgets, without resuming or changing checkpoints", async () => {
  const { db, scheduler, run, calls } = await setup(undefined, { working: false });
  const tasks = db.listTasks(run.id);
  for (const status of ["awaiting_approval", "paused", "completed", "failed", "cancelled"] as const) {
    db.updateRun(run.id, { status, agentCalls: 40, activeElapsedMs: 600_001, limits: { maxAgentCalls: 40, maxDurationMs: 600_000 }, pauseReason: "Time budget reached", guidance: "Keep the interface" });
    const before = db.getRun(run.id)!;
    const turn = scheduler.sendDirectorChat(run.id, `Why is this run ${status}?`);
    await waitFor(() => scheduler.directorChat(run.id).find((t) => t.id === turn.id)?.status !== "pending");
    expect(scheduler.directorChat(run.id).at(-1)?.status).toBe("completed");
    const after = db.getRun(run.id)!;
    expect(after.chatCalls).toBe(before.chatCalls + 1);
    expect(after.tokens).toBe(before.tokens + 42);
    expect({ ...after, chatCalls: before.chatCalls, tokens: before.tokens, costUsd: before.costUsd }).toEqual(before);
    expect(db.listTasks(run.id)).toEqual(tasks);
    expect(calls.at(-1)!.timeoutMs).toBe(run.timeouts.agentMs);
  }
  expect(calls.filter((inv) => inv.mode === "worker")).toEqual([]);
});

test("a pending chat does not hold up pausing or plan approval, and run deletion waits for its reply", async () => {
  let finish!: (result: AgentResult) => void;
  let signal!: AbortSignal;
  const { db, scheduler, run } = await setup((inv) => {
    signal = inv.signal!;
    return new Promise((resolve) => { finish = resolve; });
  }, { working: false });
  scheduler.sendDirectorChat(run.id, "Explain the plan");
  await waitFor(() => !!finish);
  scheduler.pause(run.id);
  expect(db.getRun(run.id)?.status).toBe("paused");
  expect(signal.aborted).toBe(false);
  await expect(scheduler.deleteRun(run.id, { deleteBranch: false })).rejects.toThrow("Wait for the Director");
  scheduler.resume(run.id);
  expect(db.getRun(run.id)?.status).toBe("awaiting_approval");
  finish({ ok: true, text: "Here is the plan." });
  await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "completed");
  expect(db.getRun(run.id)?.status).toBe("awaiting_approval");
});

test("chat still enforces provider safeguards before reserving a call, without changing the team's pause", async () => {
  const { db, scheduler, run, calls } = await setup(undefined, { working: false, getQuota: async () => [{ window: "weekly", usedPercent: 90, resetsAt: Date.now() + 60_000 }] });
  db.updateRun(run.id, { status: "paused", rateLimitPolicy: { maxUsedPercent: 50, window: "weekly" }, pauseReason: "Paused by user" });
  const before = db.getRun(run.id);
  const count = calls.length;
  scheduler.sendDirectorChat(run.id, "What is next?");
  await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "failed");
  expect(scheduler.directorChat(run.id)[0]?.error).toContain("90%");
  expect(db.getRun(run.id)).toEqual(before);
  expect(calls).toHaveLength(count);
});

test("quota polling stops only the chat when its provider ceiling is reached", async () => {
  let reads = 0;
  const { db, scheduler, run } = await setup(async (inv) => new Promise((resolve) => {
    inv.signal?.addEventListener("abort", () => resolve({ ok: false, text: "", error: "Stopped", usage: { tokens: 3, costUsd: null } }), { once: true });
  }), { working: false, quotaPollMs: 25, getQuota: async () => [{ window: "weekly", usedPercent: ++reads === 1 ? 10 : 80, resetsAt: Date.now() + 60_000 }] });
  db.updateRun(run.id, { status: "paused", rateLimitPolicy: { maxUsedPercent: 50, window: "weekly" }, pauseReason: "Paused by user" });
  scheduler.sendDirectorChat(run.id, "Explain the approach");
  await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "failed");
  expect(scheduler.directorChat(run.id)[0]?.error).toContain("80%");
  expect(db.getRun(run.id)).toMatchObject({ status: "paused", pauseReason: "Paused by user", chatCalls: 1, agentCalls: 1, tokens: 3, quotaWait: null, rateLimitResumeAt: null });
});

test("chat API validates requests, returns a pending turn and serves the saved reply", async () => {
  const { db, scheduler, run } = await setup();
  const server = startServer({ db, scheduler, runAgent: async () => { throw new Error("Unexpected probe"); }, port: 0 });
  const url = `http://127.0.0.1:${server.port}/api/runs/${run.id}/chat`;
  const post = (body: unknown, headers = {}) => fetch(url, { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
  try {
    expect(await (await fetch(url)).json()).toEqual([]);
    for (const body of [{}, { text: " " }, { text: "x".repeat(10001) }, { text: "Question", extra: true }]) expect((await post(body)).status).toBe(400);
    expect((await post({ text: "Question" }, { origin: "https://elsewhere.example" })).status).toBe(403);
    expect((await post({ text: "Question" }, { "content-type": "text/plain" })).status).toBe(403);
    const sent = await post({ text: "What is happening?" });
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ text: "What is happening?", status: "pending" });
    await waitFor(() => scheduler.directorChat(run.id)[0]?.status === "completed");
    expect(await (await fetch(url)).json()).toMatchObject([{ text: "What is happening?", reply: "We are building checkout.", status: "completed" }]);
    expect((await fetch(url.replace(run.id, "missing"))).status).toBe(404);
    scheduler.cancel(run.id);
    expect((await post({ text: "More?" })).status).toBe(200);
    await waitFor(() => scheduler.directorChat(run.id)[1]?.status === "completed");
    expect(db.getRun(run.id)?.status).toBe("cancelled");
  } finally { server.stop(true); }
});
