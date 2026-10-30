import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import type { AgentInvocation, AgentResult } from "../src/server/runtimes.ts";
import type { AuditRecord, Plan, RequirementSpec, RunStatus, ServerEvent } from "../src/shared/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-audit-scheduler-")));
const fixtures: { db: ReturnType<typeof openDb>; scheduler: ReturnType<typeof createScheduler> }[] = [];
afterAll(async () => {
  for (const fixture of fixtures) {
    await fixture.scheduler.waitForCleanup();
    await fixture.scheduler.shutdownPreviews();
    fixture.db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function setup(options: {
  worker: (inv: AgentInvocation, call: number) => Promise<AgentResult>;
  review?: (inv: AgentInvocation, call: number) => Promise<AgentResult>;
  requirements?: RequirementSpec[];
  reviewer?: boolean;
  disk?: boolean;
  reportUsage?: boolean;
}) {
  const home = join(root, `fixture-${fixtures.length}`);
  const path = options.disk ? join(home, "history.db") : ":memory:";
  const db = openDb(path);
  const make = (name: string, role = "Engineer") => db.createAgent({ name, role, runtime: "claude-code", model: "fixture-model", effort: null, expertise: "Synthetic test", skills: [], instructions: null });
  const director = make("Director", "Director (product & engineering)");
  const first = make("First author"), replacement = make("Replacement");
  const reviewer = options.reviewer ? make("Independent reviewer", "QA") : null;
  const team = db.createTeam({ name: "Synthetic team", directorId: director.id, memberIds: [first.id, replacement.id, ...(reviewer ? [reviewer.id] : [])] });
  const plan: Plan = {
    ...(options.requirements ? { version: 2 as const, requirements: options.requirements } : {}),
    summary: "Implement a scratch fixture", stage: "build", verify: "true", lessons: "",
    tasks: [{ id: "work", title: "Implement fixture", description: "Keep previous authors' files", acceptanceCriteria: "The fixture works", agentId: first.id, reviewerId: reviewer?.id ?? "", dependsOn: [], ...(options.requirements ? { contract: { requirementIds: options.requirements.map((requirement) => requirement.id), inputs: [], outputs: [], resources: [] } } : {}) }],
  };
  const events: ServerEvent[] = [];
  const invocations: AgentInvocation[] = [];
  let workerCalls = 0, reviewCalls = 0;
  const scheduler = createScheduler({ db, worktreeRoot: join(home, "worktrees"), publish: (_, event) => events.push(event), runAgent: async (inv) => {
    invocations.push(inv);
    if (inv.mode === "worker") return options.worker(inv, ++workerCalls);
    if (inv.prompt.includes("reviewing a teammate's work")) {
      reviewCalls++;
      return options.review ? options.review(inv, reviewCalls) : { ok: true, text: "", structured: { verdict: "approve", findings: "Synthetic independent approval" }, ...(options.reportUsage ? { usage: { tokens: 5, costUsd: 0.005 } } : {}) };
    }
    return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { summary: "The scratch fixture passes", stage: "fix", verify: "true", lessons: "", tasks: [] } : plan, ...(options.reportUsage ? { usage: { tokens: 3, costUsd: 0.003 } } : {}) };
  } });
  const wait = async (id: string, statuses: RunStatus[]) => {
    for (let tick = 0; tick < 600; tick++) {
      const run = db.getRun(id)!;
      if (statuses.includes(run.status)) return run;
      await Bun.sleep(20);
    }
    throw new Error(`Audit fixture stuck at ${db.getRun(id)?.status}: ${db.getRun(id)?.error ?? ""}`);
  };
  const start = async () => {
    const run = await scheduler.startRun({ teamId: team.id, prompt: "Build the synthetic fixture", workdir: join(home, "project"), autonomous: false });
    const planned = await wait(run.id, ["awaiting_approval", "failed"]);
    expect(planned.status).toBe("awaiting_approval");
    scheduler.approve(run.id);
    return run;
  };
  const fixture = { db, path, director, first, replacement, reviewer, scheduler, events, invocations, start, wait };
  fixtures.push(fixture);
  return fixture;
}

test("manual reassignment retains earlier authors, excludes them from acceptance and attributes caller usage", async () => {
  const fixture = setup({
    requirements: [{ id: "independence", title: "Independent acceptance", description: "A person who did not author the result reviews it", kind: "review", required: true, check: "", inputs: [], artifacts: [] }],
    reportUsage: true,
    worker: async (inv, call) => {
      if (call === 1) {
        await Bun.write(join(inv.cwd, "first-author.txt"), "Preserve this earlier contribution\n");
        return { ok: false, text: "", error: "Synthetic failure after writing files", usage: { tokens: 100, costUsd: 0.1 } };
      }
      expect(await Bun.file(join(inv.cwd, "first-author.txt")).text()).toContain("earlier contribution");
      await Bun.write(join(inv.cwd, "replacement.txt"), "Replacement contribution\n");
      return { ok: true, text: "Preserved earlier work", usage: { tokens: 20, costUsd: 0.02 } };
    },
  });
  const run = await fixture.start();
  await fixture.wait(run.id, ["failed"]);
  const task = fixture.db.listTasks(run.id)[0]!;
  fixture.scheduler.retry(task.id, { agentId: fixture.replacement.id });
  expect((await fixture.wait(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  await fixture.scheduler.waitForCleanup();
  const completed = fixture.db.getTask(task.id)!;
  expect(completed.previousAgentIds).toEqual([fixture.first.id]);
  expect(completed.attempt).toBe(2);
  const acceptance = fixture.db.listEvidence(run.id).find((record) => record.scope === "acceptance" && record.requirementIds.includes("independence"));
  expect(acceptance).toMatchObject({ producer: `reviewer:${fixture.director.id}`, status: "passed" });
  const audit = fixture.db.listTaskAudit(task.id);
  expect(audit.some((record) => record.kind === "task-assignment" && record.previousAgentId === fixture.first.id && record.agentId === fixture.replacement.id)).toBe(true);
  expect(audit.filter((record) => record.kind === "task-attempt").map((record) => record.attempt)).toEqual([1, 2]);
  const stats = fixture.db.agentStats();
  expect(stats[fixture.first.id]).toMatchObject({ failed: 1, tokens: 100, costUsd: 0.1 });
  expect(stats[fixture.replacement.id]).toMatchObject({ done: 1, firstTry: 0, avgAttempts: 2, tokens: 20, costUsd: 0.02 });
  expect(stats[fixture.director.id]!.tokens).toBeGreaterThan(0);
  const published = fixture.events.filter((event) => event.type === "audit").map((event) => event.record.id);
  expect(new Set(published)).toEqual(new Set(fixture.db.listAudit(run.id).map((record) => record.id)));
});

test("task review records retain rejected revisions after repair and preserve actor configuration snapshots", async () => {
  const fixture = setup({
    reviewer: true,
    worker: async (inv, call) => {
      await Bun.write(join(inv.cwd, "fixture.txt"), call === 1 ? "broken\n" : "repaired\n");
      return { ok: true, text: `Worker pass ${call}`, usage: { tokens: 20, costUsd: 0.02 } };
    },
    review: async (inv, call) => {
      expect(await Bun.file(join(inv.cwd, "fixture.txt")).text()).toBe(call === 1 ? "broken\n" : "repaired\n");
      return { ok: true, text: "", structured: { verdict: call === 1 ? "changes" : "approve", findings: call === 1 ? "Repair the fixture" : "The repair passes" }, usage: { tokens: 5, costUsd: 0.005 } };
    },
  });
  const run = await fixture.start();
  expect((await fixture.wait(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  const task = fixture.db.listTasks(run.id)[0]!;
  const reviews = fixture.db.listTaskAudit(task.id).filter((record) => record.kind === "task-review");
  expect(reviews.map((record) => record.verdict)).toEqual(["changes", "approve"]);
  expect(reviews[0]!.commit).not.toBe(reviews[1]!.commit);
  expect(reviews[0]).toMatchObject({ reviewerId: fixture.reviewer!.id, findings: "Repair the fixture" });
  expect(task.handoff?.review?.verdict).toBe("approve");
  const start = fixture.db.listAudit(run.id).find((record) => record.kind === "invocation-started" && record.agent.id === fixture.first.id)!;
  const snapshot = structuredClone(start);
  fixture.db.updateAgent(fixture.first.id, { ...fixture.first, name: "Edited after delivery", instructions: "Different instructions", model: "other-model" });
  expect(fixture.db.listAudit(run.id).find((record) => record.id === start.id)).toEqual(snapshot);
  expect(start).toMatchObject({ promptDigest: expect.any(String), guidanceDigest: expect.any(String), inputCommit: expect.any(String), agent: { name: "First author", model: "fixture-model" } });
  expect(JSON.stringify(start)).not.toContain("Build the synthetic fixture");
  expect(fixture.db.agentStats()[fixture.first.id]).toMatchObject({ done: 1, firstTry: 0, avgAttempts: 2, tokens: 40, costUsd: 0.04 });
  expect(fixture.db.agentStats()[fixture.reviewer!.id]).toMatchObject({ reviews: 2, tokens: 10, costUsd: 0.01 });
});

test("missing provider usage remains explicitly unknown in retained invocation records", async () => {
  const fixture = setup({ worker: async (inv) => {
    await Bun.write(join(inv.cwd, "fixture.txt"), "done\n");
    return { ok: true, text: "Done without a usage report" };
  } });
  const run = await fixture.start();
  expect((await fixture.wait(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  const audit = fixture.db.listAudit(run.id);
  const starts = audit.filter((record) => record.kind === "invocation-started");
  const finishes = audit.filter((record) => record.kind === "invocation-finished");
  expect(finishes).toHaveLength(starts.length);
  expect(finishes.every((record) => record.usage === null)).toBe(true);
  expect(fixture.db.agentStats()[fixture.first.id]).toMatchObject({ tokens: 0, costUsd: 0, usageIncomplete: true });
});

test("restart preserves audit history and appends one interruption for an orphaned invocation", async () => {
  const fixture = setup({ disk: true, worker: async (inv) => {
    await Bun.write(join(inv.cwd, "fixture.txt"), "done\n");
    return { ok: true, text: "Synthetic delivery" };
  } });
  const run = await fixture.start();
  expect((await fixture.wait(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  await fixture.scheduler.waitForCleanup();
  const before = fixture.db.listAudit(run.id);
  const callsBeforeRestart = fixture.db.getRun(run.id)!.agentCalls;
  const started = before.find((record): record is Extract<AuditRecord, { kind: "invocation-started" }> => record.kind === "invocation-started" && record.taskId !== null)!;
  const { id: _, ts: __, ...input } = started;
  fixture.db.recordAudit({ ...input, invocationId: "synthetic-orphan" });
  fixture.db.updateRun(run.id, { status: "running" });
  const task = fixture.db.listTasks(run.id)[0]!;
  fixture.db.updateTask(task.id, { status: "running", phase: "review" });
  fixture.db.close();
  fixture.db = openDb(fixture.path);
  fixture.db.failInterrupted();
  expect(fixture.db.listAudit(run.id).slice(0, before.length)).toEqual(before);
  expect(fixture.db.listAudit(run.id).filter((record) => record.kind === "invocation-finished" && record.invocationId === "synthetic-orphan")).toMatchObject([{ status: "interrupted", usage: null }]);
  const count = fixture.db.listAudit(run.id).length;
  fixture.db.failInterrupted();
  expect(fixture.db.listAudit(run.id)).toHaveLength(count);
  expect(fixture.db.getRun(run.id)).toMatchObject({ status: "failed", agentCalls: callsBeforeRestart });
  expect(fixture.db.listTaskAudit(task.id).at(-1)).toMatchObject({ kind: "task-phase", phase: "review", status: "failed" });
});
