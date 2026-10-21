import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, Plan, PlanTask } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { addWorktree, assertWorktreeRevision, commitAll, fingerprintInputs, headCommit, openDetachedWorktree, prepareWorkspace, pruneRun, publishCandidate } from "../src/server/git.ts";
import type { AgentInvocation, AgentResult, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler, MAX_INTEGRATION_PROBES, MAX_ITERATIONS } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-integration-")));
const schedulers: ReturnType<typeof createScheduler>[] = [];
afterAll(async () => {
  await Promise.all(schedulers.map((scheduler) => scheduler.waitForCleanup()));
  rmSync(root, { recursive: true, force: true });
});
let sequence = 0;
const git = (cwd: string, ...args: string[]) => {
  const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
};
const planTask = (id: string, agent: Agent, dependsOn: string[] = [], reviewer?: Agent): PlanTask => ({
  id, agentId: agent.id, title: id, description: `Implement ${id}`, acceptanceCriteria: "", reviewerId: reviewer?.id ?? "", dependsOn,
});

async function fixture(makePlan: (dev: Agent, qa: Agent) => Plan, worker: (inv: AgentInvocation, key: string) => Promise<AgentResult>, review?: (inv: AgentInvocation) => Promise<AgentResult>) {
  const db = openDb(":memory:");
  const agent = (name: string, role: string) => db.createAgent({ name, runtime: "codex", model: null, effort: null, role, expertise: "", skills: [], instructions: null });
  const boss = agent("Boss", DIRECTOR_ROLE);
  const dev = agent("Dev", "Engineer");
  const qa = agent("QA", "QA");
  const team = db.createTeam({ name: "Team", directorId: boss.id, memberIds: [dev.id, qa.id] });
  const plan = makePlan(dev, qa);
  const calls: AgentInvocation[] = [];
  const runAgent: RunAgent = async (inv) => {
    calls.push(inv);
    if (inv.mode === "worker") return worker(inv, basename(inv.cwd));
    if (inv.prompt.includes("reviewing a teammate")) return review ? review(inv) : { ok: true, text: "", structured: { verdict: "approve", findings: "" } };
    return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { summary: "Accepted", stage: "fix", verify: "", lessons: "", tasks: [] } : plan };
  };
  const dir = join(root, String(sequence++));
  const worktreeRoot = join(dir, "worktrees");
  const workdir = join(dir, "project");
  const scheduler = createScheduler({ db, runAgent, worktreeRoot, publish: () => {} });
  schedulers.push(scheduler);
  const run = await scheduler.startRun({ teamId: team.id, prompt: "Build a working result", workdir });
  const wait = async (done: () => boolean) => {
    for (let attempt = 0; attempt < 1000; attempt++) {
      if (done()) return;
      await Bun.sleep(10);
    }
    throw new Error(`Run stuck: ${JSON.stringify(db.getRun(run.id))}`);
  };
  await wait(() => db.getRun(run.id)?.status === "awaiting_approval");
  return { db, scheduler, run, calls, workdir, worktreeRoot, wait };
}

test("individually passing changes are withheld when their combination fails, with bounded reproduction evidence", async () => {
  let acceptedA!: () => boolean;
  let repairPrompt = "";
  const context = await fixture((dev, qa) => ({
    summary: "Independent changes", stage: "build", lessons: "", verify: "if [ -f a.txt ] && [ -f b.txt ]; then echo incompatible; exit 1; fi",
    tasks: [planTask("a", dev), planTask("b", qa), planTask("c", dev, ["b"])],
  }), async (inv, key) => {
    if (key === "b") {
      while (!acceptedA()) await Bun.sleep(5);
      if (inv.resume) repairPrompt = inv.prompt;
    }
    await Bun.write(join(inv.cwd, `${key}.txt`), key);
    return { ok: true, text: key, session: { id: "123e4567-e89b-42d3-a456-426614174000", costUsd: 0, tokens: 0 } };
  });
  const { db, scheduler, run, workdir, worktreeRoot, wait } = context;
  acceptedA = () => db.listTasks(run.id).find((task) => task.key === "a")?.status === "done";
  scheduler.approve(run.id);
  await wait(() => db.getRun(run.id)?.status === "failed");
  const tasks = Object.fromEntries(db.listTasks(run.id).map((task) => [task.key, task]));
  expect(tasks.a!.status).toBe("done");
  expect(tasks.b!).toMatchObject({ status: "failed", iterations: MAX_ITERATIONS, mergeCommit: null });
  expect(tasks.c!.status).toBe("blocked");
  expect(repairPrompt).toContain("accepted baseline");
  expect(repairPrompt).toContain("isolated task");
  expect(repairPrompt).toContain("incompatible");
  expect(git(workdir, "rev-parse", run.branch)).toBe(tasks.a!.mergeCommit!);
  expect(git(workdir, "rev-parse", "HEAD")).toBe(run.baseCommit);
  expect(existsSync(join(worktreeRoot, run.id, "b"))).toBe(true);
  const evidence = db.listEvidence(run.id);
  const failures = evidence.filter((entry) => entry.scope === "integration" && entry.status === "failed");
  expect(failures).toHaveLength(MAX_ITERATIONS);
  expect(evidence.filter((entry) => entry.scope === "diagnosis")).toHaveLength(MAX_ITERATIONS * MAX_INTEGRATION_PROBES);
  expect(evidence.filter((entry) => entry.scope === "diagnosis").every((entry) => entry.status === "passed")).toBe(true);
  expect(failures.every((entry) => entry.commit !== tasks.a!.mergeCommit)).toBe(true);
});

test("interaction feedback repairs the same worker session before publishing a newly checked candidate", async () => {
  let acceptedA!: () => boolean;
  const context = await fixture((dev, qa) => ({
    summary: "Repair interaction", stage: "build", lessons: "", verify: "if [ -f a.txt ] && [ -f b.txt ]; then test -f compatible.txt; fi",
    tasks: [planTask("a", dev), planTask("b", qa)],
  }), async (inv, key) => {
    if (key === "b") {
      while (!acceptedA()) await Bun.sleep(5);
      if (inv.resume) await Bun.write(join(inv.cwd, "compatible.txt"), "resolved");
    }
    await Bun.write(join(inv.cwd, `${key}.txt`), key);
    return { ok: true, text: key, session: { id: "123e4567-e89b-42d3-a456-426614174000", costUsd: 0, tokens: 0 } };
  });
  const { db, scheduler, run, calls, workdir, wait } = context;
  acceptedA = () => db.listTasks(run.id).find((task) => task.key === "a")?.status === "done";
  scheduler.approve(run.id);
  await wait(() => db.getRun(run.id)?.status === "completed");
  const b = db.listTasks(run.id).find((task) => task.key === "b")!;
  expect(b).toMatchObject({ status: "done", iterations: 2 });
  expect(calls.filter((call) => call.mode === "worker" && basename(call.cwd) === "b").map((call) => call.resume?.id)).toEqual([undefined, "123e4567-e89b-42d3-a456-426614174000"]);
  expect(git(workdir, "rev-parse", run.branch)).toBe(b.mergeCommit!);
  expect(b.handoff!.integration!.check).toMatchObject({ ok: true, commit: b.mergeCommit });
});

test("conflict resolutions receive fresh verification and an independent review of the exact candidate", async () => {
  let acceptedA!: () => boolean;
  const context = await fixture((dev, qa) => ({
    summary: "Resolve conflict", stage: "build", lessons: "", verify: "test -s shared.txt", tasks: [planTask("a", dev), planTask("b", qa)],
  }), async (inv, key) => {
    if (key === "b") while (!acceptedA()) await Bun.sleep(5);
    await Bun.write(join(inv.cwd, "shared.txt"), key === "integration" ? "resolved\n" : `${key}\n`);
    return { ok: true, text: key };
  });
  const { db, scheduler, run, calls, workdir, wait } = context;
  acceptedA = () => db.listTasks(run.id).find((task) => task.key === "a")?.status === "done";
  scheduler.approve(run.id);
  await wait(() => db.getRun(run.id)?.status === "completed");
  const b = db.listTasks(run.id).find((task) => task.key === "b")!;
  const reviews = calls.filter((call) => call.prompt.includes("reviewing a teammate"));
  expect(reviews).toHaveLength(1);
  expect(reviews[0]!.agent.id).not.toBe(b.agentId);
  expect(reviews[0]!.cwd).toContain(".candidate/integration");
  expect(b.handoff!.integration).toMatchObject({ conflictResolved: true, check: { ok: true, commit: b.mergeCommit }, review: { verdict: "approve" } });
  expect(git(workdir, "show", `${run.branch}:shared.txt`)).toBe("resolved");
});

test("publishing refuses revision drift and run deletion unregisters nested candidates", async () => {
  const dir = join(root, String(sequence++));
  const repo = join(dir, "project");
  const { baseCommit } = await prepareWorkspace(repo);
  const worktreeDir = join(dir, "worktrees", "run");
  const integration = join(worktreeDir, "integration");
  const candidate = join(worktreeDir, ".candidate", "integration");
  await addWorktree(repo, integration, "orchestra/run", baseCommit);
  await openDetachedWorktree(repo, candidate, baseCommit);
  await Bun.write(join(candidate, "contract.ts"), "export const value = 1;\n");
  await commitAll(candidate, "candidate");
  const commit = await headCommit(candidate);
  const inputs = await fingerprintInputs(candidate, commit, ["contract.ts", "missing.ts"]);
  expect(inputs["contract.ts"]).toBe(git(candidate, "rev-parse", `${commit}:contract.ts`));
  expect(inputs["missing.ts"]).toBe("missing");
  await expect(fingerprintInputs(candidate, commit, ["../outside"])).rejects.toThrow("explicit paths");
  await expect(fingerprintInputs(candidate, commit, ["*.ts"])).rejects.toThrow("explicit paths");
  await Bun.write(join(candidate, "contract.ts"), "changed after verification");
  await expect(assertWorktreeRevision(candidate, commit)).rejects.toThrow("checked revision");
  await expect(publishCandidate(integration, candidate, baseCommit, commit)).rejects.toThrow("checked revision");
  expect(await headCommit(integration)).toBe(baseCommit);
  expect(await pruneRun(repo, worktreeDir, ["orchestra/run"])).toEqual([]);
  expect(git(repo, "worktree", "list", "--porcelain")).not.toContain(worktreeDir);
  expect(await headCommit(repo)).toBe(baseCommit);
});

test("a successful command that edits committed candidate files cannot publish passing evidence", async () => {
  const { db, scheduler, run, workdir, wait } = await fixture((dev) => ({
    summary: "Verification cannot change its subject", stage: "build", lessons: "",
    verify: 'case "$PWD" in */.candidate/integration) echo changed > a.txt;; esac', tasks: [planTask("a", dev)],
  }), async (inv) => {
    await Bun.write(join(inv.cwd, "a.txt"), "original");
    return { ok: true, text: "implemented" };
  });
  scheduler.approve(run.id);
  await wait(() => db.getRun(run.id)?.status === "failed");
  expect(git(workdir, "rev-parse", run.branch)).toBe(run.baseCommit);
  expect(db.listTasks(run.id)[0]!.error).toContain("Verification changed committed files");
  const candidateChecks = db.listEvidence(run.id).filter((entry) => entry.scope === "integration");
  expect(candidateChecks).toHaveLength(MAX_ITERATIONS);
  expect(candidateChecks.every((entry) => entry.status === "failed")).toBe(true);
});

test("changed file and directory inputs force a bounded worker pass with current Git context", async () => {
  let acceptedA!: () => boolean;
  let refreshedPrompt = "";
  const context = await fixture((dev, qa) => ({
    version: 2, summary: "Adapt to changed context", stage: "build", lessons: "", verify: "true",
    requirements: [{ id: "behavior", title: "Working consumer", description: "Consumer matches the current contract", kind: "command", check: "test -f consumer.txt", required: true, inputs: [], artifacts: [] }],
    tasks: [
      { ...planTask("a", dev), acceptanceCriteria: "Publish the interface", contract: { requirementIds: ["behavior"], inputs: [], outputs: [], resources: [] } },
      { ...planTask("b", qa), acceptanceCriteria: "Adapt the consumer", contract: { requirementIds: ["behavior"], inputs: ["contract.txt", "contracts"], outputs: ["consumer.txt"], resources: [] } },
    ],
  }), async (inv, key) => {
    if (key === "a") {
      await Bun.write(join(inv.cwd, "contract.txt"), "cursor: string\n");
      mkdirSync(join(inv.cwd, "contracts"));
      await Bun.write(join(inv.cwd, "contracts", "schema.txt"), "version two\n");
    } else {
      while (!acceptedA()) await Bun.sleep(5);
      if (inv.resume) refreshedPrompt = inv.prompt;
      await Bun.write(join(inv.cwd, "consumer.txt"), inv.resume ? "uses cursor" : "uses page");
    }
    return { ok: true, text: key, session: { id: "123e4567-e89b-42d3-a456-426614174000", costUsd: 0, tokens: 0 } };
  });
  const { db, scheduler, run, wait } = context;
  acceptedA = () => db.listTasks(run.id).find((entry) => entry.key === "a")?.status === "done";
  scheduler.approve(run.id);
  await wait(() => ["completed", "failed"].includes(db.getRun(run.id)!.status));
  expect(db.getRun(run.id)!.status).toBe("completed");
  expect(db.listTasks(run.id).find((entry) => entry.key === "b")).toMatchObject({ status: "done", iterations: 2 });
  expect(refreshedPrompt).toContain("Your declared inputs changed");
  expect(refreshedPrompt).toContain("cursor: string");
  expect(refreshedPrompt).toContain("schema.txt");
  expect(refreshedPrompt).toContain("git ls-tree");
});
