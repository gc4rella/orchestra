import { afterAll, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdtempSync, realpathSync, rmSync, statSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import type { Agent, RuntimeManifest } from "../src/shared/types.ts";

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
  expect(run.firstRunnable).toBeNull();
  expect(run.firstAccepted).toBeNull();
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
  expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(12);
  raw.close();
});

test("migration 10 keeps chat history, recovers interrupted replies and removes history with its run", () => {
  const path = join(dir, "chat-v10.db");
  writeV0(path);
  let db = openDb(path);
  db.updateRun("building", { status: "running", agentCalls: 7, guidance: "Keep the interface" });
  db.close();
  const v9 = new Database(path);
  v9.exec("DROP TABLE audit_records; ALTER TABLE tasks DROP COLUMN audit_legacy; DROP TABLE project_secrets; DROP TABLE director_chat; PRAGMA user_version = 9;");
  v9.close();
  db = openDb(path);
  expect(db.getRun("building")).toMatchObject({ agentCalls: 7, guidance: "Keep the interface" });
  expect(db.getRun("building")?.chatCalls).toBe(0);
  db.updateRun("building", { chatCalls: 2 });
  expect(db.listDirectorChat("building")).toEqual([]);
  const first = db.addDirectorChat("building", "What is being built?");
  const answered = db.finishDirectorChat(first.id, "The checkout.");
  db.addDirectorChat("building", "What is next?");
  db.close();
  db = openDb(path);
  db.failInterrupted();
  expect(db.getRun("building")).toMatchObject({ chatCalls: 2, agentCalls: 7 });
  expect(db.listDirectorChat("building")).toMatchObject([answered, { status: "failed", error: expect.stringContaining("restart") }]);
  expect(db.finishDirectorChat(first.id, "late replacement")).toEqual(answered);
  db.deleteRun("building");
  expect(db.listDirectorChat("building")).toEqual([]);
  db.close();
});

test("migration 11 encrypts project secrets, preserves checkpoints, and isolates preview credentials", () => {
  const path = join(dir, "secrets-v11.db");
  writeV0(path);
  let db = openDb(path);
  db.updateRun("building", { agentCalls: 7, activeElapsedMs: 1200 });
  db.close();
  const v10 = new Database(path);
  v10.exec("DROP TABLE audit_records; ALTER TABLE tasks DROP COLUMN audit_legacy; DROP TABLE project_secrets; PRAGMA user_version = 10;");
  v10.close();
  db = openDb(path);
  expect(db.getRun("building")).toMatchObject({ agentCalls: 7, activeElapsedMs: 1200 });
  expect(db.listSecrets("/w", "building")).toEqual([]);
  db.saveSecret("/w", { name: "API_KEY", value: "fixture-api-value", environment: true });
  db.saveSecret("/w", { name: "password", value: "fixture-login-value", environment: false }, { runId: "building", commit: "abc" });
  expect(db.listSecrets("/w", "building")).toMatchObject([{ name: "API_KEY", source: "saved", environment: true }, { name: "password", source: "preview", commit: "abc", environment: false }]);
  expect(JSON.stringify(db.listSecrets("/w", "building"))).not.toContain("fixture-");
  expect(db.listSecrets("/elsewhere", "building")).toEqual([]);
  expect(db.listSecrets("/w", "defining")).toHaveLength(1);
  expect(db.secretEnvironment("/w")).toEqual({ API_KEY: "fixture-api-value" });
  db.close();
  const raw = new Database(path);
  const records = raw.query("SELECT * FROM project_secrets").all();
  expect(JSON.stringify(records)).not.toContain("fixture-");
  expect(statSync(`${path}.secrets-key`).mode & 0o777).toBe(0o600);
  raw.close();
  db = openDb(path);
  expect(db.revealSecret("/w", "building", "password")).toBe("fixture-login-value");
  expect(db.revealSecret("/elsewhere", "building", "password")).toBeNull();
  db.deleteRun("building");
  expect(db.listSecrets("/w", "building")).toHaveLength(1);
  expect(db.revealSecret("/w", "", "API_KEY")).toBe("fixture-api-value");
  db.deleteSecret("/w", "", "API_KEY");
  expect(db.secretEnvironment("/w")).toEqual({});
  db.close();
});

test("a missing secrets key cannot be silently replaced while encrypted records remain", () => {
  const path = join(dir, "missing-key.db");
  let db = openDb(path);
  db.saveSecret("/w", { name: "TOKEN", value: "fixture-token", environment: true });
  db.close();
  unlinkSync(`${path}.secrets-key`);
  db = openDb(path);
  expect(() => db.revealSecret("/w", "", "TOKEN")).toThrow("key is missing");
  expect(() => db.saveSecret("/w", { name: "OTHER", value: "fixture-other", environment: false })).toThrow("key is missing");
  expect(existsSync(`${path}.secrets-key`)).toBe(false);
  expect(db.listSecrets("/w", "run")).toHaveLength(1);
  db.close();
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
  previous.exec("DROP TABLE audit_records; ALTER TABLE tasks DROP COLUMN audit_legacy; DROP TABLE team_members; DROP TABLE teams; ALTER TABLE runs DROP COLUMN team_id; ALTER TABLE runs DROP COLUMN control_json; ALTER TABLE tasks DROP COLUMN checkpoint_json; ALTER TABLE agents DROP COLUMN skills_json; ALTER TABLE agents DROP COLUMN effort; ALTER TABLE agents DROP COLUMN rate_limit_policy_json; DROP TABLE projects; DROP TABLE settings; DROP TABLE evidence; DROP TABLE agent_events; DROP TABLE project_lessons; DROP TABLE project_secrets; DROP TABLE director_chat; PRAGMA user_version = 1;");
  previous.close();
  db = openDb(path);
  const before = db.getRun("building")!;
  expect(before).toMatchObject({ continuous: false, limits: null, agentCalls: 0, preview: { enabled: false, command: "" } });
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
    [worker.id]: { done: 2, failed: 1, firstTry: 0, avgAttempts: null, costUsd: 0, tokens: 0, reviews: 0, usageIncomplete: true, attemptsIncomplete: true },
    [reviewer.id]: { done: 0, failed: 0, firstTry: 0, avgAttempts: null, costUsd: 0, tokens: 0, reviews: 1, usageIncomplete: true, attemptsIncomplete: true },
  });

  expect(db.deleteRun("r")).toBe(true);
  expect(db.getRun("r")).toBeNull();
  expect(db.listTasks("r")).toEqual([]);
  expect(db.listLogs("r", a!.id)).toEqual([]);
  expect(db.agentStats()).toEqual({});
  expect(db.deleteRun("r")).toBe(false);
  db.close();
});

test("migration 12 preserves legacy history and appends immutable invocation and task audit records", () => {
  const path = join(dir, "audit-v12.db");
  writeV0(path);
  let db = openDb(path);
  db.updateRun("building", { status: "running", agentCalls: 7, activeElapsedMs: 1200, recoveries: 1 });
  db.close();
  const previous = new Database(path);
  previous.exec("DROP TABLE audit_records; ALTER TABLE tasks DROP COLUMN audit_legacy; UPDATE tasks SET checkpoint_json = json_remove(checkpoint_json, '$.attempt'); PRAGMA user_version = 11;");
  previous.close();
  db = openDb(path);
  expect(db.getRun("building")).toMatchObject({ agentCalls: 7, activeElapsedMs: 1200, recoveries: 1 });
  const task = db.listTasks("building")[0]!;
  expect(task.attempt).toBe(1);
  expect(db.listAudit("building")).toEqual([]);
  const agent = db.getAgent("ag")!;
  const manifest: RuntimeManifest = { runtime: "codex", version: "fixture-version", model: "fixture-model", effort: "high", transport: "batch", skills: [{ id: "o/r/procedure", revision: "source-revision" }], environment: { sources: [], notices: [] } };
  const started = db.recordAudit({ kind: "invocation-started", runId: "building", taskId: task.id, invocationId: "original-call", agent: { id: agent.id, name: agent.name, role: agent.role, runtime: agent.runtime, model: agent.model, effort: agent.effort }, purpose: "work", phase: "work", attempt: 1, inputCommit: "original-input", promptDigest: "prompt-digest", guidanceDigest: "guidance-digest", manifest, registeredSkills: manifest.skills, selectedSkills: manifest.skills, ts: 10 });
  const phase = db.recordAudit({ kind: "task-phase", runId: "building", taskId: task.id, agentId: agent.id, attempt: 1, phase: "work", status: "running", commit: "original-input", ts: 11 });
  const saved = structuredClone(started);
  if (started.kind === "invocation-started") started.manifest.model = "caller changed copy";
  db.updateAgent(agent.id, { ...agent, name: "Renamed", instructions: "Changed instructions" });
  expect(db.listAudit("building")).toEqual([saved, phase]);
  expect(() => db.recordAudit({ ...saved, id: "another-start" })).toThrow();
  db.close();
  db = openDb(path);
  expect(db.listTaskAudit(task.id)).toEqual([saved, phase]);
  db.failInterrupted();
  const recovered = db.listAudit("building");
  expect(recovered).toHaveLength(3);
  expect(recovered[2]).toMatchObject({ kind: "invocation-finished", invocationId: "original-call", status: "interrupted", usage: null });
  db.failInterrupted();
  expect(db.listAudit("building")).toHaveLength(3);
  expect(db.getRun("building")).toMatchObject({ status: "failed", agentCalls: 7, recoveries: 1 });
  expect(db.agentStats().ag).toMatchObject({ firstTry: 0, usageIncomplete: true, attemptsIncomplete: true });
  db.deleteRun("building");
  expect(db.listAudit("building")).toEqual([]);
  expect(db.listTaskAudit(task.id)).toEqual([]);
  db.close();
  const raw = new Database(path);
  expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(12);
  raw.close();
});

test("audited statistics retain failed authors, attribute every caller's usage, and reject retry first-try credit", () => {
  const db = openDb(":memory:");
  const make = (name: string) => db.createAgent({ name, runtime: "claude-code", model: "fixture", effort: null, role: "Engineer", expertise: "", skills: [], instructions: null });
  const director = make("Director"), first = make("First author"), replacement = make("Replacement"), reviewer = make("Reviewer");
  db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: director.id, baseCommit: "base", branch: "orchestra/r", warning: null });
  db.insertTasks("r", { summary: "s", stage: "build", verify: "", lessons: "", tasks: [{ id: "a", title: "A", description: "D", acceptanceCriteria: "Files work", agentId: first.id, reviewerId: reviewer.id, dependsOn: [] }] });
  const task = db.listTasks("r")[0]!;
  const invocation = (id: string, actor: Agent, purpose: string, attempt: number | null, taskId: string | null, tokens: number, costUsd: number, status: "completed" | "failed" = "completed") => {
    const manifest: RuntimeManifest = { runtime: actor.runtime, version: null, model: actor.model, effort: actor.effort, transport: "batch", skills: [], environment: { sources: [], notices: [] } };
    db.recordAudit({ kind: "invocation-started", runId: "r", taskId, invocationId: id, agent: { id: actor.id, name: actor.name, role: actor.role, runtime: actor.runtime, model: actor.model, effort: actor.effort }, purpose, phase: taskId ? purpose === "review" ? "review" : "work" : null, attempt, inputCommit: "input", promptDigest: "prompt", guidanceDigest: "guidance", manifest, registeredSkills: [], selectedSkills: [] });
    db.recordAudit({ kind: "invocation-finished", runId: "r", taskId, invocationId: id, status, usage: { tokens, costUsd }, error: status === "failed" ? "Fixture failure" : null });
  };
  invocation("first", first, "work", 1, task.id, 100, 0.1, "failed");
  db.recordAudit({ kind: "task-phase", runId: "r", taskId: task.id, agentId: first.id, attempt: 1, phase: "work", status: "failed", commit: "first-output" });
  db.recordAudit({ kind: "task-assignment", runId: "r", taskId: task.id, agentId: replacement.id, previousAgentId: first.id, attempt: 2, phase: "work", status: "pending", commit: "first-output", reason: "User reassigned failed work" });
  invocation("replacement", replacement, "work", 2, task.id, 20, 0.02);
  invocation("review", reviewer, "review", 2, task.id, 5, 0.005);
  invocation("planning", director, "planning", null, null, 30, 0.03);
  db.recordAudit({ kind: "task-review", runId: "r", taskId: task.id, agentId: replacement.id, reviewerId: reviewer.id, attempt: 2, phase: "review", commit: "reviewed-output", verdict: "approve", findings: "Checks passed" });
  db.recordAudit({ kind: "task-phase", runId: "r", taskId: task.id, agentId: replacement.id, attempt: 2, phase: "done", status: "done", commit: "reviewed-output" });
  db.updateTask(task.id, { agentId: replacement.id, previousAgentIds: [first.id], attempt: 2, status: "done", phase: "done", iterations: 1 });
  db.addUsage("r", task.id, { tokens: 125, costUsd: 0.125 });
  const stats = db.agentStats();
  expect(stats[first.id]).toMatchObject({ failed: 1, done: 0, tokens: 100, costUsd: 0.1 });
  expect(stats[replacement.id]).toMatchObject({ done: 1, failed: 0, firstTry: 0, avgAttempts: 2, tokens: 20, costUsd: 0.02 });
  expect(stats[reviewer.id]).toMatchObject({ reviews: 1, tokens: 5, costUsd: 0.005 });
  expect(stats[director.id]).toMatchObject({ done: 0, tokens: 30, costUsd: 0.03 });
  expect(stats[replacement.id]!.usageIncomplete).toBeUndefined();
  expect(db.listTaskAudit(task.id).some((record) => record.kind === "task-review" && record.commit === "reviewed-output")).toBe(true);
  db.close();
});

test("audited statistics distinguish a clean first attempt, repair calls, and unknown usage", () => {
  const db = openDb(":memory:");
  const actor = db.createAgent({ name: "Worker", runtime: "codex", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null });
  db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: actor.id, baseCommit: "b", branch: "orchestra/r", warning: null });
  const item = (id: string) => ({ id, title: id, description: "D", acceptanceCriteria: "Works", agentId: actor.id, reviewerId: "", dependsOn: [] });
  db.insertTasks("r", { summary: "s", stage: "build", verify: "", lessons: "", tasks: [item("clean"), item("repaired")] });
  const manifest: RuntimeManifest = { runtime: actor.runtime, version: null, model: null, effort: null, transport: "batch", skills: [], environment: { sources: [], notices: [] } };
  for (const task of db.listTasks("r")) {
    const calls = task.key === "clean" ? 1 : 2;
    for (let index = 0; index < calls; index++) {
      const invocationId = `${task.key}-${index}`;
      db.recordAudit({ kind: "invocation-started", runId: "r", taskId: task.id, invocationId, agent: { id: actor.id, name: actor.name, role: actor.role, runtime: actor.runtime, model: null, effort: null }, purpose: "work", phase: "work", attempt: 1, inputCommit: "input", promptDigest: "p", guidanceDigest: "g", manifest, registeredSkills: [], selectedSkills: [] });
      db.recordAudit({ kind: "invocation-finished", runId: "r", taskId: task.id, invocationId, status: "completed", usage: task.key === "clean" ? { tokens: 12, costUsd: null } : null, error: null });
    }
    db.updateTask(task.id, { status: "done", iterations: calls });
    db.recordAudit({ kind: "task-phase", runId: "r", taskId: task.id, agentId: actor.id, attempt: 1, phase: "done", status: "done", commit: "output" });
  }
  expect(db.agentStats()[actor.id]).toMatchObject({ done: 2, firstTry: 1, avgAttempts: 1.5, tokens: 12, costUsd: 0, usageIncomplete: true });
  db.close();
});

test("capacity checkpoints default for older data and retain transfers and authorship across restart", () => {
  const path = join(dir, "capacity.db");
  writeV0(path);
  let db = openDb(path);
  expect(db.getRun("building")!.capacityLimits).toEqual([]);
  const taskId = db.listTasks("building")[0]!.id;
  expect(db.getTask(taskId)!.previousAgentIds).toEqual([]);
  const limit = { agentId: "ag", runtime: "codex" as const, reason: "rate limit", rerouted: true };
  db.updateRun("building", { status: "paused", capacityLimits: [limit], agentCalls: 7, activeElapsedMs: 1200, recoveries: 1 });
  db.updateTask(taskId, { previousAgentIds: ["earlier-author"], reviewerId: "ag", phase: "review", iterations: 2 });
  db.close();
  db = openDb(path);
  expect(db.getRun("building")).toMatchObject({ capacityLimits: [limit], agentCalls: 7, activeElapsedMs: 1200, recoveries: 1 });
  expect(db.getTask(taskId)).toMatchObject({ previousAgentIds: ["earlier-author"], reviewerId: "ag", phase: "review", iterations: 2 });
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

test("migration 9 preserves v8 checkpoints and persists delivery contracts, immutable evidence, invocation events and lesson provenance", () => {
  const path = join(dir, "delivery-v9.db");
  writeV0(path);
  let db = openDb(path);
  db.setMemory("/w", "Keep the checkout test");
  db.setRateLimitPolicy("/w", { maxUsedPercent: 60, window: "weekly" });
  db.updateRun("building", { status: "paused", agentCalls: 7, activeElapsedMs: 1200, recoveries: 1, fixRounds: 1, guidance: "Keep the interface", pauseReason: "Paused by user" });
  const taskId = db.listTasks("building")[0]!.id;
  db.updateTask(taskId, { phase: "check", startCommit: "old-start", handoff: { text: "Ready for checks", files: ["src/checkout.ts"], check: null, review: null } });
  db.close();
  const v8 = new Database(path);
  v8.exec(`
    ALTER TABLE projects DROP COLUMN delivery_policy_json;
    DROP TABLE evidence;
    DROP TABLE agent_events;
    DROP TABLE project_lessons;
    UPDATE runs SET control_json = json_remove(control_json, '$.delivery', '$.requirements', '$.acceptedCommit', '$.recommendation');
    UPDATE tasks SET checkpoint_json = json_remove(checkpoint_json, '$.contract', '$.contextVersions');
    DROP TABLE audit_records; ALTER TABLE tasks DROP COLUMN audit_legacy;
    DROP TABLE project_secrets; DROP TABLE director_chat;
    PRAGMA user_version = 8;
  `);
  v8.close();

  db = openDb(path);
  expect(db.getDeliveryPolicy("/w")).toEqual({ profile: "balanced", strategy: "auto", maxParallel: 3 });
  expect(db.getRun("building")).toMatchObject({ status: "paused", agentCalls: 7, activeElapsedMs: 1200, recoveries: 1, fixRounds: 1, guidance: "Keep the interface", requirements: [], acceptedCommit: null });
  expect(db.getTask(taskId)).toMatchObject({ phase: "check", startCommit: "old-start", handoff: { text: "Ready for checks" }, contract: { requirementIds: [], inputs: [], outputs: [], resources: [] }, contextVersions: {} });
  expect(db.getMemory("/w")).toBe("Keep the checkout test");
  expect(db.getRateLimitPolicy("/w")).toEqual({ maxUsedPercent: 60, window: "weekly" });
  expect(db.listEvidence("building")).toEqual([]);
  expect(db.listAgentEvents("building")).toEqual([]);

  const delivery = { profile: "quality" as const, strategy: "team" as const, maxParallel: 4 };
  const contract = { requirementIds: ["checkout"], inputs: ["src/api.ts"], outputs: ["src/checkout.ts"], resources: ["checkout-interface"] };
  const requirement = { id: "checkout", title: "Checkout", description: "Place an order", kind: "command" as const, check: "bun test", required: true, inputs: ["src"], artifacts: [], version: 1, updatedAt: 5 };
  db.setDeliveryPolicy("/w", delivery);
  db.updateRun("building", { delivery, requirements: [requirement], acceptedCommit: "checked-revision" });
  db.updateTask(taskId, { contract, contextVersions: { "src/api.ts": "fingerprint" } });
  const proof = db.recordEvidence({ runId: "building", taskId, requirementIds: ["checkout"], requirementVersions: { checkout: 1 }, commit: "checked-revision", scope: "acceptance", producer: "Orchestra", command: "bun test", status: "passed", output: "original proof", durationMs: 50, artifacts: [] });
  const storedProof = structuredClone(proof);
  proof.output = "caller modified its copy";
  const event = { id: "invocation-start", runId: "building", taskId, invocationId: "call", parentId: null, agentId: "ag", kind: "started" as const, text: "Checking", ts: 5 };
  db.recordAgentEvent(event);
  expect(() => db.recordAgentEvent({ ...event, text: "Replacement" })).toThrow();
  db.proposeLessons("building", "checked-revision", "- Keep checkout covered\n- Keep checkout covered");
  db.proposeLessons("building", "checked-revision", "Keep checkout covered");
  expect(db.listLessons("/w")).toHaveLength(1);
  expect(db.listLessons("/w")[0]).toMatchObject({ status: "proposed", evidenceIds: [storedProof.id], commit: "checked-revision" });
  expect(db.getMemory("/w")).toBe("Keep the checkout test");
  db.close();

  db = openDb(path);
  expect(db.getDeliveryPolicy("/w")).toEqual(delivery);
  expect(db.getRun("building")).toMatchObject({ delivery, requirements: [requirement], acceptedCommit: "checked-revision", agentCalls: 7 });
  expect(db.getTask(taskId)).toMatchObject({ contract, contextVersions: { "src/api.ts": "fingerprint" }, phase: "check" });
  expect(db.listEvidence("building")).toEqual([storedProof]);
  expect(db.listAgentEvents("building")).toEqual([event]);
  const lesson = db.listLessons("/w")[0]!;
  db.setLessonStatus("/w", lesson.id, "accepted");
  db.deleteRun("building");
  expect(db.listEvidence("building")).toEqual([]);
  expect(db.listAgentEvents("building")).toEqual([]);
  expect(db.listTasks("building")).toEqual([]);
  expect(db.listLessons("/w")[0]).toMatchObject({ id: lesson.id, status: "accepted", runId: "building" });
  expect(db.getMemory("/w")).toBe("Keep the checkout test");
  db.close();
  const raw = new Database(path);
  expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(12);
  raw.close();
});
