import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, Plan, PlanTask, RequirementSpec } from "../src/shared/types.ts";
import type { AgentInvocation, AgentResult } from "../src/server/runtimes.ts";
import { childEventFilter, parseLine } from "../src/server/runtimes.ts";
import { chooseReviewer } from "../src/server/delivery.ts";
import { openDb } from "../src/server/db.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import { workerHandoff } from "../src/server/handoff.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-improvements-")));
const previousHome = process.env.ORCHESTRA_HOME;
process.env.ORCHESTRA_HOME = join(root, "home");
const fixtures: { db: ReturnType<typeof openDb>; scheduler: ReturnType<typeof createScheduler> }[] = [];
afterAll(async () => {
  for (const fixture of fixtures) { await fixture.scheduler.waitForCleanup(); await fixture.scheduler.shutdownPreviews(); fixture.db.close(); }
  rmSync(root, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.ORCHESTRA_HOME;
  else process.env.ORCHESTRA_HOME = previousHome;
});

async function wait(predicate: () => boolean) {
  for (let count = 0; count < 1000; count++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("Orchestration fixture did not settle");
}

function setup(options: {
  plan: (engineer: Agent, reviewer: Agent) => Plan;
  work?: (inv: AgentInvocation) => Promise<AgentResult>;
  review?: (inv: AgentInvocation) => Promise<AgentResult>;
  check?: NonNullable<Parameters<typeof createScheduler>[0]["runCheck"]>;
  skills?: Agent["skills"];
}) {
  const home = join(root, String(fixtures.length));
  const db = openDb(":memory:");
  const make = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = make("Director", "Director");
  const engineer = make("Engineer", "Full-stack Engineer");
  if (options.skills) db.updateAgent(engineer.id, { ...engineer, skills: options.skills });
  const reviewer = make("Reviewer", "QA");
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [engineer.id, reviewer.id] });
  const calls: AgentInvocation[] = [];
  const plan = options.plan(engineer, reviewer);
  const scheduler = createScheduler({ db, worktreeRoot: join(home, "worktrees"), runCheck: options.check, publish: () => {}, runAgent: async (inv) => {
    calls.push(inv);
    if (inv.mode === "worker") {
      if (options.work) return options.work(inv);
      await Bun.write(join(inv.cwd, `${basename(inv.cwd)}.txt`), "delivered");
      return { ok: true, text: "Delivered" };
    }
    if (inv.prompt.includes("reviewing a teammate")) return options.review ? options.review(inv) : { ok: true, text: "", structured: { verdict: "approve", findings: "Checked the fixture" } };
    return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { summary: "Accepted", stage: "fix", verify: plan.verify, lessons: "", tasks: [] } : plan };
  } });
  fixtures.push({ db, scheduler });
  const start = () => scheduler.startRun({ teamId: team.id, prompt: "Deliver the bounded fixture", workdir: join(home, "project"), autonomous: true, delivery: { profile: "speed", strategy: "team", maxParallel: 6 } });
  const finish = async (id: string) => {
    await wait(() => ["completed", "failed", "paused"].includes(db.getRun(id)!.status));
    expect(db.getRun(id)!.error).toBeNull();
    expect(db.getRun(id)!.status).toBe("completed");
  };
  return { db, scheduler, calls, start, finish };
}

const requirement = (id = "delivered", overrides: Partial<RequirementSpec> = {}): RequirementSpec => ({ id, title: id, description: "Deliver the fixture", kind: "command", check: "verify-fixture", required: true, inputs: [], artifacts: [], ...overrides });
const task = (agent: Agent, key = "implement"): PlanTask => ({ id: key, title: key, description: `Deliver ${key}.txt`, acceptanceCriteria: "The fixture works", agentId: agent.id, reviewerId: "", dependsOn: [], contract: { requirementIds: ["delivered"], inputs: [], outputs: [`${key}.txt`], resources: [] } });

test("generic and identical requirement checks share execution only within each checked snapshot and scope", async () => {
  const checks: string[] = [];
  const h = setup({
    plan: (agent) => ({ version: 2, summary: "Deliver", stage: "build", verify: "verify-fixture", lessons: "", requirements: [requirement(), requirement("second")], tasks: [{ ...task(agent), contract: { ...task(agent).contract!, requirementIds: ["delivered", "second"] } }] }),
    check: async (cwd) => { checks.push(cwd); return { ok: true, output: "Checked this exact snapshot" }; },
  });
  const run = await h.start();
  await h.finish(run.id);
  expect(checks).toHaveLength(3);
  expect(checks.map((cwd) => basename(join(cwd, "..")))).toEqual([run.id, ".candidate", ".acceptance"]);
  const receipts = h.db.listEvidence(run.id).filter((entry) => entry.producer === "orchestra:requirement");
  expect(receipts).toHaveLength(4);
  expect(receipts.every((entry) => entry.durationMs === 0 && entry.status === "passed")).toBe(true);
  expect(new Set(receipts.map((entry) => entry.scope))).toEqual(new Set(["integration", "acceptance"]));
  expect(receipts.every((entry) => entry.requirementVersions[entry.requirementIds[0]!] === 1)).toBe(true);
});

test("a missing required artifact still fails when its command shares generic verification", async () => {
  const h = setup({
    plan: (agent) => ({ version: 2, summary: "Deliver with proof", stage: "build", verify: "verify-fixture", lessons: "", requirements: [requirement("delivered", { artifacts: ["missing.png"] })], tasks: [task(agent)] }),
    check: async () => ({ ok: true, output: "Command passed" }),
  });
  const run = await h.start();
  await wait(() => ["paused", "failed"].includes(h.db.getRun(run.id)!.status));
  expect(h.db.getRun(run.id)!.status).not.toBe("completed");
  expect(h.db.listEvidence(run.id).some((entry) => entry.producer === "orchestra:requirement" && entry.status === "failed" && entry.output.includes("missing.png"))).toBe(true);
});

test("compatible acceptance reviews share one independent call with separate exact-revision verdicts", async () => {
  let reviewCalls = 0;
  const h = setup({
    plan: (agent) => ({ version: 2, summary: "Deliver with independent criteria", stage: "build", verify: "verify-fixture", lessons: "", requirements: [
      requirement("review-one", { kind: "review", check: "", description: "First complete inspection criterion" }),
      requirement(),
      requirement("review-two", { kind: "review", check: "", description: "Second complete inspection criterion" }),
    ], tasks: [{ ...task(agent), contract: { ...task(agent).contract!, requirementIds: ["review-one", "delivered", "review-two"] } }] }),
    check: async () => ({ ok: true, output: "COMMAND-EVIDENCE-BEFORE-REVIEW" }),
    review: async (inv) => {
      reviewCalls++;
      expect(inv.prompt).toContain("COMMAND-EVIDENCE-BEFORE-REVIEW");
      expect(inv.prompt).toContain("First complete inspection criterion");
      expect(inv.prompt).toContain("Second complete inspection criterion");
      return { ok: true, text: "", structured: { requirements: [{ id: "review-two", verdict: "approve", findings: "Second criterion checked" }, { id: "review-one", verdict: "approve", findings: "First criterion checked" }] } };
    },
  });
  const run = await h.start();
  await h.finish(run.id);
  expect(reviewCalls).toBe(1);
  const evidence = h.db.listEvidence(run.id).filter((entry) => entry.producer.startsWith("reviewer:"));
  expect(evidence.map((entry) => entry.requirementIds)).toEqual([["review-one"], ["review-two"]]);
  expect(evidence.map((entry) => entry.output)).toEqual(["First criterion checked", "Second criterion checked"]);
  expect(evidence.every((entry) => entry.scope === "acceptance" && entry.commit === h.db.getRun(run.id)!.acceptedCommit)).toBe(true);
});

test("available provider capacity starts a fourth independent worker while earlier workers wait in checks", async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let activeWorkers = 0, checksStarted = 0;
  const h = setup({
    plan: (agent) => ({ version: 2, summary: "Four independent tasks", stage: "build", verify: "verify-fixture", lessons: "", requirements: [requirement()], tasks: Array.from({ length: 4 }, (_, index) => task(agent, `task-${index}`)) }),
    work: async (inv) => {
      activeWorkers++;
      try { await Bun.write(join(inv.cwd, `${basename(inv.cwd)}.txt`), "delivered"); return { ok: true, text: "Delivered" }; }
      finally { activeWorkers--; }
    },
    check: async (cwd, _command, signal) => {
      if (!cwd.includes(".candidate") && !cwd.includes(".acceptance")) {
        checksStarted++;
        await Promise.race([gate, new Promise<void>((resolve) => signal?.addEventListener("abort", () => resolve(), { once: true }))]);
      }
      return { ok: true, output: "Checked" };
    },
  });
  const run = await h.start();
  try {
    await wait(() => checksStarted === 4);
    expect(activeWorkers).toBe(0);
    expect(h.db.listTasks(run.id).filter((entry) => entry.phase === "check")).toHaveLength(4);
  } finally { release(); }
  await h.finish(run.id);
});

test("workers receive exact contracts, relevant skill instructions and structured handoffs retain explicit claims", async () => {
  const selected = "anthropics/skills/frontend-design", unrelated = "owner/repo/backend-tuning";
  let prompt = "";
  const h = setup({
    skills: [{ id: selected, name: "frontend-design", description: "Make a designed UI" }, { id: unrelated, name: "backend-tuning", description: "Tune a database" }],
    plan: (agent) => ({ version: 2, summary: "Deliver", stage: "build", verify: "verify-fixture", lessons: "", requirements: [requirement("delivered", { description: "UNIQUE-REQUIREMENT-CONTEXT" })], tasks: [{ ...task(agent), contract: { ...task(agent).contract!, skillIds: [selected], inputs: ["input-contract.txt"], resources: ["design-assets"] } }] }),
    work: async (inv) => {
      prompt = inv.prompt;
      expect(inv.schema).toBeDefined();
      await Bun.write(join(inv.cwd, "implement.txt"), "delivered");
      return { ok: true, text: "", structured: { summary: "Delivered the fixture", decisions: ["Reuse the existing layout"], interfaces: ["implement.txt"], blockers: [], verified: ["Focused fixture check"], skillIds: [selected] } };
    },
    check: async () => ({ ok: true, output: "Checked" }),
  });
  const run = await h.start();
  await h.finish(run.id);
  expect(prompt).toContain("UNIQUE-REQUIREMENT-CONTEXT");
  expect(prompt).toContain("input-contract.txt");
  expect(prompt).toContain("design-assets");
  expect(prompt).toContain("inputVersions");
  expect(prompt).toContain(selected);
  expect(prompt).not.toContain(unrelated);
  const saved = h.db.listTasks(run.id)[0]!;
  expect(saved.handoff?.details).toMatchObject({ interfaces: ["implement.txt"], skillIds: [selected] });
  const audit = h.db.listTaskAudit(saved.id);
  expect(audit.find((entry) => entry.kind === "invocation-started" && entry.purpose === "work")).toMatchObject({ selectedSkills: [{ id: selected, revision: null }], registeredSkills: [{ id: selected, revision: null }, { id: unrelated, revision: null }] });
  expect(audit.find((entry) => entry.kind === "invocation-finished")).toMatchObject({ skillClaims: [selected] });
});

test("fresh conflict-resolution workers retain selected skill and requirement context", async () => {
  const selected = "anthropics/skills/frontend-design";
  let started = 0, conflicts = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  const h = setup({
    skills: [{ id: selected, name: "frontend-design", description: "Visual implementation" }],
    plan: (agent) => ({ version: 2, summary: "Combine parallel changes", stage: "build", verify: "verify-fixture", lessons: "", requirements: [requirement("delivered", { description: "PRESERVE-BOTH-INTERFACES" })], tasks: ["one", "two"].map((id) => ({ ...task(agent, id), contract: { ...task(agent, id).contract!, skillIds: [selected] } })) }),
    check: async () => ({ ok: true, output: "Checked" }),
    work: async (inv) => {
      if (inv.cwd.includes(".candidate")) {
        conflicts++;
        expect(inv.prompt).toContain(selected);
        expect(inv.prompt).toContain("PRESERVE-BOTH-INTERFACES");
        expect(inv.prompt).toContain("inputVersions");
        expect(inv.prompt).not.toContain("## Structured handoff");
        await Bun.write(join(inv.cwd, "shared.txt"), "one and two\n");
        return { ok: true, text: "Preserved both contributions" };
      }
      if (++started === 2) release();
      await gate;
      await Bun.write(join(inv.cwd, "shared.txt"), `${basename(inv.cwd)}\n`);
      return { ok: true, text: "Implemented shared file" };
    },
  });
  const run = await h.start();
  await h.finish(run.id);
  expect(conflicts).toBe(1);
  expect(h.db.listAudit(run.id).find((record) => record.kind === "invocation-started" && record.purpose === "conflict-resolution")).toMatchObject({ selectedSkills: [{ id: selected, revision: null }] });
});

test("reviewer ranking preserves independence while preferring registered domain capability", () => {
  const make = (id: string, role: string): Agent => ({ id, role, name: id, runtime: "codex", expertise: "", model: null, effort: null, skills: [], instructions: null, createdAt: 0 });
  const author = make("author", "Product Designer"), general = make("qa", "QA"), specialist = make("designer", "Product Designer");
  general.expertise = "Frontend browser functionality and regression checks";
  const principal = { ...make("principal", "Principal Engineer"), expertise: "System design and codebase design" };
  const selected = chooseReviewer([general, author, principal, specialist], new Set([author.id]), "UI visual design and responsive screenshot fidelity");
  expect(selected?.agent.id).toBe(specialist.id);
  expect(selected?.reason).toContain("visual design");
  expect(chooseReviewer([author], new Set([author.id]), "UI")).toBeNull();
});

test("unmatched background completions cannot become child-agent events", () => {
  const filter = childEventFilter();
  const background = parseLine("claude-code", JSON.stringify({ type: "system", subtype: "task_notification", task_id: "bash", tool_use_id: "tool", status: "completed" })).events![0]!;
  expect(filter(background)).toBe(false);
  const start = parseLine("claude-code", JSON.stringify({ type: "system", subtype: "task_started", task_id: "agent", task_type: "local_agent" })).events![0]!;
  const finish = parseLine("claude-code", JSON.stringify({ type: "system", subtype: "task_notification", task_id: "agent", tool_use_id: "tool", status: "completed" })).events![0]!;
  expect(filter(start)).toBe(true);
  expect(filter(finish)).toBe(true);
  expect(filter(finish)).toBe(false);
});

test("worker claims cannot add unassigned procedures or replace authoritative evidence", () => {
  expect(() => workerHandoff({ text: "", structured: { summary: "Done", decisions: [], interfaces: [], blockers: [], verified: ["I claim acceptance"], skillIds: ["unknown/repo/skill"] } }, [])).toThrow("outside its assigned skill pack");
  expect(workerHandoff({ text: "Legacy handoff" }, [])).toEqual({ text: "Legacy handoff" });
});
