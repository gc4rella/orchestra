import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-db-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

/** The schema and data of a database written before migrations existed (user_version 0). */
function writeV0(path: string) {
  const db = new Database(path);
  db.exec(`
    CREATE TABLE agents (id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT, role TEXT NOT NULL,
      skills TEXT NOT NULL, instructions TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE runs (id TEXT PRIMARY KEY, prompt TEXT NOT NULL, workdir TEXT NOT NULL,
      director_agent_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, plan_json TEXT,
      base_commit TEXT NOT NULL, branch TEXT NOT NULL, error TEXT, warning TEXT, created_at INTEGER NOT NULL);
    CREATE TABLE tasks (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, title TEXT NOT NULL,
      description TEXT NOT NULL, acceptance TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
      depends_on TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, error TEXT,
      started_at INTEGER, finished_at INTEGER, UNIQUE (run_id, key));
    CREATE TABLE logs (id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT,
      ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL);
    INSERT INTO agents VALUES ('ag', 'Dev', 'codex', NULL, 'Engineer', '', NULL, 1);
  `);
  const oldTask = { id: "t", title: "T", description: "D", agentId: "ag", dependsOn: [], acceptanceCriteria: "" };
  const run = (id: string, status: string, stage: string, taskStatus: string) => {
    db.query("INSERT INTO runs VALUES (?, 'p', '/w', 'ag', ?, ?, 'base', ?, NULL, NULL, 1)")
      .run(id, status, JSON.stringify({ summary: "s", stage, tasks: [oldTask] }), `orchestra/${id}`);
    db.query("INSERT INTO tasks VALUES (?, ?, 'spec', 'Spec', 'd', '', 'ag', '[]', ?, 'sum', NULL, NULL, NULL)").run(`${id}-t`, id, taskStatus);
  };
  run("defining", "running", "definition", "running");
  run("awaiting-build", "awaiting_approval", "build", "done");
  run("build-planning-failed", "failed", "build", "done");
  run("building", "running", "build", "done");
  db.close();
}

test("a v0 database is migrated in place, keeping its data", () => {
  const path = join(dir, "orchestra.db");
  writeV0(path);
  const db = openDb(path);

  const run = db.getRun("awaiting-build")!;
  expect(run).toMatchObject({ continuous: false, limits: null, history: [], agentCalls: 0, prompt: "p", status: "awaiting_approval", autonomous: false, costUsd: 0, tokens: 0, recoveries: 0, report: null });
  // Old plans gain the fields the strict schema now requires.
  expect(run.plan!.verify).toBe("");
  expect(run.plan!.tasks[0]!.reviewerId).toBe("");

  // Tasks inserted before a build plan was approved are definition work.
  const stage = (runId: string) => db.listTasks(runId)[0]!.stage;
  expect(stage("defining")).toBe("definition");
  expect(stage("awaiting-build")).toBe("definition");
  expect(stage("build-planning-failed")).toBe("definition");
  expect(stage("building")).toBe("build");
  expect(db.listTasks("building")[0]).toMatchObject({ summary: "sum", session: null, iterations: 0, mergeCommit: null, reviewerId: null });
  db.close();

  // Reopening is a no-op.
  const again = openDb(path);
  expect(again.listRuns()).toHaveLength(4);
  again.close();
  const raw = new Database(path);
  expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(8);
  raw.close();
});

test("migration 3 forms the first team from the Director and everyone else, and assigns past runs to it", () => {
  const path = join(dir, "teams.db");
  writeV0(path);
  const raw = new Database(path);
  raw.exec(`
    INSERT INTO agents VALUES ('boss', 'Boss', 'codex', NULL, ' DIRECTOR (product & engineering) ', '', NULL, 2);
    INSERT INTO agents VALUES ('qa', 'QA', 'codex', NULL, 'QA', '', NULL, 3);
  `);
  raw.close();
  const db = openDb(path);
  expect(db.listTeams()).toMatchObject([{ id: "default", name: "My team", directorId: "boss", memberIds: ["ag", "qa"] }]);
  expect(db.listRuns().every((r) => r.teamId === "default")).toBe(true);
  db.close();
});

test("migration 3 falls back to the latest run's director, and forms no team without agents", () => {
  const path = join(dir, "fallback.db");
  writeV0(path); // its only agent is an Engineer who directed the old runs
  const db = openDb(path);
  expect(db.listTeams()).toMatchObject([{ directorId: "ag", memberIds: [] }]);
  db.close();

  const empty = openDb(":memory:");
  expect(empty.listTeams()).toEqual([]);
});

test("migration 4 keeps the old free-text skills as expertise and starts with no marketplace skills", () => {
  const path = join(dir, "skills.db");
  writeV0(path);
  const raw = new Database(path);
  raw.exec("UPDATE agents SET skills = 'React, CSS' WHERE id = 'ag'");
  raw.close();
  const db = openDb(path);
  expect(db.getAgent("ag")).toMatchObject({ expertise: "React, CSS", skills: [] });
  const skills = [{ id: "o/r/tdd", name: "tdd", description: "Test first" }];
  db.updateAgent("ag", { ...db.getAgent("ag")!, skills });
  expect(db.getAgent("ag")!.skills).toEqual(skills);
  db.close();
});

test("migration 5 leaves existing agents on their CLI's default effort", () => {
  const path = join(dir, "effort.db");
  writeV0(path);
  const db = openDb(path);
  expect(db.getAgent("ag")!.effort).toBeNull();
  db.updateAgent("ag", { ...db.getAgent("ag")!, effort: "high" });
  expect(db.getAgent("ag")!.effort).toBe("high");
  db.close();
});

test("migration 6 starts every project with empty memory, and old plans gain empty lessons", () => {
  const path = join(dir, "memory.db");
  writeV0(path);
  const db = openDb(path);
  expect(db.getMemory("/w")).toBe("");
  expect(db.getRun("building")!.plan!.lessons).toBe("");
  // Plans in a run's history are normalized too: they were stored as written.
  db.updateRun("building", { history: [{ cycle: 1, createdAt: 1, plan: { summary: "s", stage: "fix", verify: "", tasks: [] } as never, report: "ok" }] });
  expect(db.getRun("building")!.history[0]!.plan!.lessons).toBe("");
  db.setMemory("/w", "Run bun test");
  db.setMemory("/w", "Run bun test\nDon't touch vendor/");
  expect(db.getMemory("/w")).toBe("Run bun test\nDon't touch vendor/");
  expect(db.getMemory("/other")).toBe("");
  db.close();
});

test("removing an agent drops it from its teams", () => {
  const db = openDb(":memory:");
  const hire = (name: string) => db.createAgent({ name, runtime: "codex", model: null, effort: null, role: "r", expertise: "", skills: [], instructions: null });
  const [boss, dev, qa] = [hire("Boss"), hire("Dev"), hire("QA")];
  const team = db.createTeam({ name: "T", directorId: boss.id, memberIds: [qa.id, dev.id] });
  expect(db.getTeam(team.id)!.memberIds).toEqual([qa.id, dev.id]);
  db.deleteAgent(qa.id);
  expect(db.getTeam(team.id)!.memberIds).toEqual([dev.id]);
  expect(db.teamsDirectedBy(boss.id).map((t) => t.id)).toEqual([team.id]);
  expect(db.updateTeam("nope", { name: "x", directorId: boss.id, memberIds: [] })).toBe(false);
});

test("a new database starts at the latest version", () => {
  const db = openDb(":memory:");
  const agent = db.createAgent({ name: "D", runtime: "claude-code", model: null, effort: null, role: "r", expertise: "", skills: [], instructions: null });
  const run = db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: agent.id, baseCommit: "b", branch: "orchestra/r", warning: null, autonomous: true });
  expect(run.autonomous).toBe(true);
  db.addUsage("r", null, { costUsd: 0.5, tokens: 10 });
  db.addUsage("r", null, { costUsd: null, tokens: 5 });
  expect(db.getRun("r")).toMatchObject({ costUsd: 0.5, tokens: 15 });
});

test("reviewers remain in use even when they have no assigned tasks", () => {
  const db = openDb(":memory:");
  const agent = (name: string) => db.createAgent({ name, runtime: "claude-code", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null });
  const director = agent("Director");
  const worker = agent("Worker");
  const reviewer = agent("Reviewer");
  const spare = agent("Spare");
  db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: director.id, baseCommit: "b", branch: "orchestra/r", warning: null });
  db.insertTasks("r", { summary: "s", stage: "build", verify: "", lessons: "", tasks: [{
    id: "t", title: "T", description: "D", acceptanceCriteria: "", agentId: worker.id, reviewerId: reviewer.id, dependsOn: [],
  }] });
  expect(db.agentInUse(reviewer.id)).toBe(true);
  expect(db.agentInUse(spare.id)).toBe(false);
  db.close();
});


test("v1 migration preserves state, durable handoffs, and restart checkpoints", () => {
  const path = join(dir, "checkpoint.db");
  writeV0(path);
  const raw = new Database(path);
  // Let migration 1 run, then reproduce a database from the previous released schema.
  raw.close();
  let db = openDb(path);
  db.close();
  const previous = new Database(path);
  previous.exec("DROP TABLE team_members; DROP TABLE teams; ALTER TABLE runs DROP COLUMN team_id; ALTER TABLE runs DROP COLUMN control_json; ALTER TABLE tasks DROP COLUMN checkpoint_json; ALTER TABLE agents DROP COLUMN skills_json; ALTER TABLE agents DROP COLUMN effort; ALTER TABLE agents DROP COLUMN rate_limit_policy_json; DROP TABLE projects; DROP TABLE settings; PRAGMA user_version = 1;");
  previous.close();
  db = openDb(path);
  const before = db.getRun("building")!;
  expect(before).toMatchObject({ continuous: false, limits: null, agentCalls: 0 });
  const handoff = { text: "Interface: stable", files: ["a.ts"], check: { command: "bun test", ok: true, output: "passed" }, review: { verdict: "approve" as const, findings: "" } };
  db.updateRun("building", { status: "running", continuous: true, checkpoint: "execute", cycle: 2, guidance: "Keep the interface", agentCalls: 8, activeElapsedMs: 100, activeSince: Date.now() - 1000, limits: { maxDurationMs: 60_000, maxAgentCalls: 10 }, history: [{ cycle: 1, createdAt: 1, plan: before.plan, report: "Verified" }] });
  const task = db.listTasks("building")[0]!;
  db.updateTask(task.id, { status: "running", phase: "merge", cycle: 2, startCommit: "abc", handoff });
  db.close();
  db = openDb(path);
  db.failInterrupted();
  expect(db.getRun("building")).toMatchObject({ status: "failed", checkpoint: "execute", cycle: 2, activeSince: null, agentCalls: 8, guidance: "Keep the interface", history: [{ report: "Verified" }] });
  expect(db.getRun("building")!.activeElapsedMs).toBeGreaterThanOrEqual(1100);
  expect(db.getTask(task.id)).toMatchObject({ status: "failed", phase: "merge", startCommit: "abc", handoff });
  db.close();
});

test("agent stats total work and reviews per agent, and deleting a run removes its rows", () => {
  const db = openDb(":memory:");
  const agent = (name: string) => db.createAgent({ name, runtime: "claude-code", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null });
  const director = agent("Director");
  const worker = agent("Worker");
  const reviewer = agent("Reviewer");
  db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: director.id, baseCommit: "b", branch: "orchestra/r", warning: null });
  const t = (id: string, reviewerId = "") => ({ id, title: id, description: "d", acceptanceCriteria: "", agentId: worker.id, reviewerId, dependsOn: [] });
  db.insertTasks("r", { summary: "s", stage: "build", verify: "", lessons: "", tasks: [t("a", reviewer.id), t("b"), t("c")] });
  const [a, b, c] = db.listTasks("r");
  db.updateTask(a!.id, { status: "done", iterations: 1 });
  db.updateTask(b!.id, { status: "done", iterations: 3 });
  db.updateTask(c!.id, { status: "failed", iterations: 3 });
  db.addUsage("r", a!.id, { costUsd: 0.5, tokens: 100 });
  db.addUsage("r", null, { costUsd: 1, tokens: 50 }); // the Director's own call belongs to no task
  db.addLog("r", a!.id, "text", "hello");

  expect(db.agentStats()).toEqual({
    [worker.id]: { done: 2, failed: 1, firstTry: 1, avgAttempts: 2, costUsd: 0.5, tokens: 100, reviews: 0 },
    [reviewer.id]: { done: 0, failed: 0, firstTry: 0, avgAttempts: null, costUsd: 0, tokens: 0, reviews: 1 },
  });

  expect(db.deleteRun("r")).toBe(true);
  expect(db.getRun("r")).toBeNull();
  expect(db.listTasks("r")).toEqual([]);
  expect(db.listLogs("r", a!.id)).toEqual([]);
  expect(db.agentStats()).toEqual({});
  expect(db.deleteRun("r")).toBe(false);
  db.close();
});

test("migration 7 defaults safeguards off and persists agent and project policies independently of memory", () => {
  const path = join(dir, "quota.db");
  writeV0(path);
  let db = openDb(path);
  expect(db.getAgent("ag")!.rateLimitPolicy).toBeNull();
  expect(db.getRateLimitPolicy("/project")).toBeNull();
  const policy = { maxUsedPercent: 50, window: "weekly" as const };
  db.updateAgent("ag", { ...db.getAgent("ag")!, rateLimitPolicy: policy });
  db.setRateLimitPolicy("/project", policy);
  db.setMemory("/project", "Keep this");
  db.close();
  db = openDb(path);
  expect(db.getAgent("ag")!.rateLimitPolicy).toEqual(policy);
  expect(db.getRateLimitPolicy("/project")).toEqual(policy);
  db.setRateLimitPolicy("/project", null);
  expect(db.getMemory("/project")).toBe("Keep this");
  expect(db.getRateLimitPolicy("/project")).toBeNull();
  db.close();
});

test("migration 8 starts with no global policy and retains a saved global safeguard on reopen", () => {
  const path = join(dir, "global-quota.db");
  writeV0(path);
  let db = openDb(path);
  expect(db.getGlobalRateLimitPolicy()).toBeNull();
  const policy = { maxUsedPercent: 50, window: "both" as const };
  db.setGlobalRateLimitPolicy(policy);
  db.close();
  db = openDb(path);
  expect(db.getGlobalRateLimitPolicy()).toEqual(policy);
  expect(db.getAgent("ag")!.rateLimitPolicy).toBeNull();
  expect(db.getRateLimitPolicy("/project")).toBeNull();
  db.setGlobalRateLimitPolicy(null);
  expect(db.getGlobalRateLimitPolicy()).toBeNull();
  db.close();
});
