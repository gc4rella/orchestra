import { afterAll, expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Plan, PlanTask, RequirementSpec } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { requirementStatus } from "../src/server/delivery.ts";
import type { AgentInvocation, AgentResult, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import { requirementResult } from "../src/web/model.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-delivery-")));
const schedulers: ReturnType<typeof createScheduler>[] = [];
let sequence = 0;
afterAll(async () => {
  await Promise.all(schedulers.map((scheduler) => scheduler.waitForCleanup()));
  rmSync(root, { recursive: true, force: true });
});

const requirement = (id: string, check = "test -f ok.txt", overrides: Partial<RequirementSpec> = {}): RequirementSpec => ({
  id, title: `Requirement ${id}`, description: `Deliver ${id}`, kind: "command", check, required: true, inputs: [], artifacts: [], ...overrides,
});
const task = (agent: Agent, ids: string[]): PlanTask => ({
  id: "implement", title: "Implement the feature", description: "Write the feature", agentId: agent.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "All declared requirements pass", contract: { requirementIds: ids, inputs: [], outputs: ["ok.txt"], resources: [] },
});

async function fixture(requirements: RequirementSpec[], options: { taskRequirementIds?: string[]; review?: (inv: AgentInvocation) => Promise<AgentResult>; verify?: string } = {}) {
  const db = openDb(":memory:");
  const createAgent = (name: string, role: string) => db.createAgent({ name, runtime: "codex", model: null, effort: null, role, expertise: "", skills: [], instructions: null });
  const director = createAgent("Director", DIRECTOR_ROLE);
  const engineer = createAgent("Engineer", "Engineer");
  const reviewer = createAgent("Reviewer", "QA");
  const team = db.createTeam({ name: "Delivery", directorId: director.id, memberIds: [engineer.id, reviewer.id] });
  const plan: Plan = { version: 2, summary: "Build and prove the feature", stage: "build", verify: options.verify ?? "true", lessons: "", requirements, tasks: [task(engineer, options.taskRequirementIds ?? requirements.map((r) => r.id))] };
  const calls: AgentInvocation[] = [];
  const runAgent: RunAgent = async (inv) => {
    calls.push(inv);
    if (inv.mode === "worker") {
      await Bun.write(join(inv.cwd, "ok.txt"), "working");
      return { ok: true, text: "Feature implemented" };
    }
    if (inv.prompt.includes("reviewing a teammate")) return options.review ? options.review(inv) : { ok: true, text: "", structured: { verdict: "approve", findings: "Reviewed delivered behavior" } };
    const verification = inv.prompt.includes("## Verification");
    return { ok: true, text: "", structured: verification ? { version: 2, summary: "All done", stage: "fix", verify: "", requirements: [], lessons: "", tasks: [] } : plan };
  };
  const dir = join(root, String(sequence++));
  const worktreeRoot = join(dir, "worktrees");
  const workdir = join(dir, "project");
  const scheduler = createScheduler({ db, runAgent, worktreeRoot, publish: () => {} });
  schedulers.push(scheduler);
  const run = await scheduler.startRun({ teamId: team.id, prompt: "Deliver the feature with proof", workdir });
  const wait = async (predicate: () => boolean) => {
    for (let count = 0; count < 600; count++) {
      if (predicate()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Run did not settle: ${JSON.stringify(db.getRun(run.id))}`);
  };
  await wait(() => db.getRun(run.id)?.status === "awaiting_approval");
  return { db, scheduler, run, calls, worktreeRoot, workdir, engineer, reviewer, wait };
}

test("required commands run independently of generic verification on candidate and accepted revision", async () => {
  const required = requirement("behavior", "echo requirement-ran; test -f ok.txt");
  const { db, scheduler, run, wait } = await fixture([required]);
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  const evidence = db.listEvidence(run.id).filter((entry) => entry.command === required.check && entry.producer === "orchestra:requirement");
  expect(evidence.some((entry) => entry.scope === "integration")).toBe(true);
  expect(evidence.some((entry) => entry.scope === "acceptance")).toBe(true);
  expect(evidence.every((entry) => entry.output.includes("requirement-ran") && entry.status === "passed")).toBe(true);
  expect(requirementStatus(db.getRun(run.id)!.requirements[0]!, db.listEvidence(run.id), db.getRun(run.id)!.acceptedCommit)).toBe("satisfied");
});

test("identical requirement commands execute once per scope, retaining separate artifacts and revision evidence", async () => {
  const count = join(root, `command-count-${sequence}`);
  const check = `echo checked >> '${count}'; mkdir -p evidence; echo proof > evidence/proof.txt; test -f ok.txt`;
  const requirements = [requirement("one", check), requirement("two", check, { artifacts: ["evidence/proof.txt"] })];
  const { db, scheduler, run, worktreeRoot, wait } = await fixture(requirements);
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  expect((await Bun.file(count).text()).trim().split("\n")).toHaveLength(2);
  const receipts = db.listEvidence(run.id).filter((entry) => entry.command === check);
  expect(receipts).toHaveLength(4);
  for (const scope of ["integration", "acceptance"]) {
    const scoped = receipts.filter((entry) => entry.scope === scope);
    expect(scoped.map((entry) => entry.requirementIds)).toEqual([["one"], ["two"]]);
    expect(scoped.every((entry) => entry.status === "passed" && entry.requirementVersions[entry.requirementIds[0]!] === 1)).toBe(true);
    expect(scoped[1]!.durationMs).toBe(0);
    expect(scoped[0]!.artifacts).toHaveLength(0);
    expect(await Bun.file(join(worktreeRoot, run.id, ".artifacts", scoped[1]!.artifacts[0]!)).text()).toBe("proof\n");
  }
  const accepted = db.getRun(run.id)!;
  for (const required of accepted.requirements) {
    expect(requirementStatus(required, receipts, accepted.acceptedCommit)).toBe("satisfied");
    expect(requirementStatus(required, receipts, "another-revision")).toBe("stale");
  }
  await scheduler.waitForCleanup();
  scheduler.revise(run.id, "Recheck the result");
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  expect((await Bun.file(count).text()).trim().split("\n")).toHaveLength(3);
});

test("a shared command cannot hide missing artifacts or failed requirements", async () => {
  for (const fails of [false, true]) {
    const count = join(root, `failed-command-count-${sequence}`);
    const check = `echo checked >> '${count}'; ${fails ? "echo broken; exit 1" : "test -f ok.txt"}`;
    const requirements = [requirement("task", "true"), requirement("one", check), requirement("two", check, { artifacts: ["missing.txt"] })];
    const { db, scheduler, run, wait } = await fixture(requirements, { taskRequirementIds: ["task"] });
    scheduler.approve(run.id);
    await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
    expect(db.getRun(run.id)!.status).toBe("failed");
    expect((await Bun.file(count).text()).trim().split("\n")).toHaveLength(1);
    const receipts = db.listEvidence(run.id).filter((entry) => entry.command === check);
    expect(receipts.map((entry) => entry.status)).toEqual([fails ? "failed" : "passed", "failed"]);
    expect(receipts[1]!.output).toContain("Missing or unsupported evidence artifacts: missing.txt");
  }
});

test("an empty Director fix plan cannot accept a failing required command", async () => {
  const requirements = [requirement("task", "true"), requirement("delivery", "echo acceptance-failed; exit 1")];
  const { db, scheduler, run, calls, wait } = await fixture(requirements, { taskRequirementIds: ["task"] });
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed", "paused"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("failed");
  expect(db.listTasks(run.id)[0]!.status).toBe("done");
  expect(db.listEvidence(run.id).some((entry) => entry.scope === "acceptance" && entry.requirementIds.includes("delivery") && entry.status === "failed")).toBe(true);
  expect(calls.some((call) => call.mode === "readonly" && call.prompt.includes("## Verification"))).toBe(true);
});

test("required reviews use an independent teammate and record evidence on the delivered commit", async () => {
  const { db, scheduler, run, calls, engineer, reviewer, wait } = await fixture([requirement("journey", "", { kind: "review" })]);
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  const reviewCalls = calls.filter((call) => call.prompt.includes("reviewing a teammate"));
  expect(reviewCalls).toHaveLength(1);
  expect(reviewCalls[0]!.agent.id).toBe(reviewer.id);
  expect(reviewCalls[0]!.agent.id).not.toBe(engineer.id);
  expect(reviewCalls[0]!.prompt).toContain('"producer":"orchestra:combined"');
  expect(reviewCalls[0]!.prompt).toContain(`"commit":"${db.getRun(run.id)!.acceptedCommit}"`);
  expect(db.listEvidence(run.id).find((entry) => entry.scope === "acceptance" && entry.producer === `reviewer:${reviewer.id}`)).toMatchObject({ commit: db.getRun(run.id)!.acceptedCommit, status: "passed" });
});

test("declared evidence artifacts survive disposable worktree cleanup", async () => {
  const { db, scheduler, run, worktreeRoot, wait } = await fixture([requirement("journey", "mkdir -p evidence; printf '<html>accepted</html>' > evidence/journey.html; test -f ok.txt", { artifacts: ["evidence/journey.html"] })]);
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  await scheduler.waitForCleanup();
  expect(existsSync(join(worktreeRoot, run.id, "integration"))).toBe(false);
  const receipt = db.listEvidence(run.id).findLast((entry) => entry.scope === "acceptance" && entry.requirementIds.includes("journey"))!;
  expect(receipt.artifacts).toHaveLength(1);
  expect(await Bun.file(join(worktreeRoot, run.id, ".artifacts", receipt.artifacts[0]!)).text()).toBe("<html>accepted</html>");
});

test("same-timestamp evidence uses durable append order and an older pass cannot override a newer failure", async () => {
  const clock = spyOn(Date, "now").mockReturnValue(1_700_000_000_000);
  try {
    const gate = join(root, `gate-${sequence}`);
    await Bun.write(gate, "ready");
    const required = requirement("fresh", `test -f '${gate}'`);
    const { db, scheduler, run, wait } = await fixture([required]);
    scheduler.approve(run.id);
    await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
    expect(db.getRun(run.id)!.status).toBe("completed");
    await scheduler.waitForCleanup();
    const current = db.getRun(run.id)!;
    const passed = db.listEvidence(run.id).findLast((entry) => entry.scope === "acceptance" && entry.requirementIds.includes("fresh"))!;
    const failed = db.recordEvidence({ runId: run.id, taskId: null, scope: "acceptance", commit: current.acceptedCommit!, producer: "orchestra:requirement", command: required.check, status: "failed", output: "newer failure", durationMs: 0, artifacts: [], requirementIds: ["fresh"], requirementVersions: { fresh: current.requirements[0]!.version } });
    expect(failed.createdAt).toBe(passed.createdAt);
    expect(requirementStatus(current.requirements[0]!, db.listEvidence(run.id), current.acceptedCommit)).toBe("failed");
    expect(requirementResult(current.requirements[0]!, current.acceptedCommit, db.listEvidence(run.id)).status).toBe("failed");
    unlinkSync(gate);
    scheduler.revise(run.id, "Verify the unresolved requirement again");
    await wait(() => ["completed", "failed", "paused"].includes(db.getRun(run.id)!.status));
    expect(db.getRun(run.id)!.status).toBe("failed");
    expect(db.listEvidence(run.id).findLast((entry) => entry.scope === "acceptance" && entry.requirementIds.includes("fresh"))!.status).toBe("failed");
  } finally {
    clock.mockRestore();
  }
});

test("a final check that edits tracked files fails without dirtying the accepted integration workspace", async () => {
  const { db, scheduler, run, worktreeRoot, wait } = await fixture([requirement("behavior")], {
    verify: 'case "$PWD" in */.candidate/integration|*/implement) ;; *) echo changed > ok.txt;; esac',
  });
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("failed");
  const status = Bun.spawnSync(["git", "status", "--porcelain", "--untracked-files=no"], { cwd: join(worktreeRoot, run.id, "integration") });
  expect(status.exitCode).toBe(0);
  expect(status.stdout.toString()).toBe("");
  expect(db.listEvidence(run.id).some((entry) => entry.scope === "acceptance" && entry.status === "failed" && entry.output.includes("Verification changed committed files"))).toBe(true);
});
