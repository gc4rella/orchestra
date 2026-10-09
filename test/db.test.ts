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
  expect(run).toMatchObject({ prompt: "p", status: "awaiting_approval", autonomous: false, costUsd: 0, tokens: 0, recoveries: 0, report: null });
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
  expect(raw.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version).toBe(1);
  raw.close();
});

test("a new database starts at the latest version", () => {
  const db = openDb(":memory:");
  const agent = db.createAgent({ name: "D", runtime: "claude-code", model: null, role: "r", skills: "", instructions: null });
  const run = db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: agent.id, baseCommit: "b", branch: "orchestra/r", warning: null, autonomous: true });
  expect(run.autonomous).toBe(true);
  db.addUsage("r", null, { costUsd: 0.5, tokens: 10 });
  db.addUsage("r", null, { costUsd: null, tokens: 5 });
  expect(db.getRun("r")).toMatchObject({ costUsd: 0.5, tokens: 15 });
});

test("reviewers remain in use even when they have no assigned tasks", () => {
  const db = openDb(":memory:");
  const agent = (name: string) => db.createAgent({ name, runtime: "claude-code", model: null, role: "Engineer", skills: "", instructions: null });
  const director = agent("Director");
  const worker = agent("Worker");
  const reviewer = agent("Reviewer");
  const spare = agent("Spare");
  db.createRun({ id: "r", prompt: "p", workdir: "/w", directorAgentId: director.id, baseCommit: "b", branch: "orchestra/r", warning: null });
  db.insertTasks("r", { summary: "s", stage: "build", verify: "", tasks: [{
    id: "t", title: "T", description: "D", acceptanceCriteria: "", agentId: worker.id, reviewerId: reviewer.id, dependsOn: [],
  }] });
  expect(db.agentInUse(reviewer.id)).toBe(true);
  expect(db.agentInUse(spare.id)).toBe(false);
  db.close();
});
