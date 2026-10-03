import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Agent, LogEntry, LogKind, Plan, Run, RunStatus, Runtime, Task, TaskStatus } from "../shared/types.ts";

export const orchestraHome = () => process.env.ORCHESTRA_HOME ?? join(homedir(), ".orchestra");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, runtime TEXT NOT NULL, model TEXT, role TEXT NOT NULL,
  skills TEXT NOT NULL, instructions TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS runs (
  id TEXT PRIMARY KEY, prompt TEXT NOT NULL, workdir TEXT NOT NULL,
  director_agent_id TEXT NOT NULL REFERENCES agents(id), status TEXT NOT NULL, plan_json TEXT,
  base_commit TEXT NOT NULL, branch TEXT NOT NULL, error TEXT, warning TEXT, created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS tasks (
  id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), key TEXT NOT NULL, title TEXT NOT NULL,
  description TEXT NOT NULL, acceptance TEXT NOT NULL, agent_id TEXT NOT NULL REFERENCES agents(id),
  depends_on TEXT NOT NULL, status TEXT NOT NULL, summary TEXT, error TEXT,
  started_at INTEGER, finished_at INTEGER, UNIQUE (run_id, key)
);
CREATE TABLE IF NOT EXISTS logs (
  id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id), task_id TEXT,
  ts INTEGER NOT NULL, kind TEXT NOT NULL, text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_run_task ON logs (run_id, task_id);
`;

type AgentRow = {
  id: string; name: string; runtime: Runtime; model: string | null; role: string; skills: string;
  instructions: string | null; created_at: number;
};
type RunRow = {
  id: string; prompt: string; workdir: string; director_agent_id: string; status: RunStatus; plan_json: string | null;
  base_commit: string; branch: string; error: string | null; warning: string | null; created_at: number;
};
type TaskRow = {
  id: string; run_id: string; key: string; title: string; description: string; acceptance: string; agent_id: string;
  depends_on: string; status: TaskStatus; summary: string | null; error: string | null;
  started_at: number | null; finished_at: number | null;
};
type LogRow = { id: number; run_id: string; task_id: string | null; ts: number; kind: LogKind; text: string };

const toAgent = (r: AgentRow): Agent => ({
  id: r.id, name: r.name, runtime: r.runtime, model: r.model, role: r.role, skills: r.skills,
  instructions: r.instructions, createdAt: r.created_at,
});
const toRun = (r: RunRow): Run => ({
  id: r.id, prompt: r.prompt, workdir: r.workdir, directorAgentId: r.director_agent_id, status: r.status,
  plan: r.plan_json ? (JSON.parse(r.plan_json) as Plan) : null, baseCommit: r.base_commit, branch: r.branch,
  error: r.error, warning: r.warning, createdAt: r.created_at,
});
const toTask = (r: TaskRow): Task => ({
  id: r.id, runId: r.run_id, key: r.key, title: r.title, description: r.description, acceptance: r.acceptance,
  agentId: r.agent_id, dependsOn: JSON.parse(r.depends_on) as string[], status: r.status, summary: r.summary,
  error: r.error, startedAt: r.started_at, finishedAt: r.finished_at,
});
const toLog = (r: LogRow): LogEntry => ({ id: r.id, runId: r.run_id, taskId: r.task_id, ts: r.ts, kind: r.kind, text: r.text });

export type AgentInput = Omit<Agent, "id" | "createdAt">;
export type Db = ReturnType<typeof openDb>;

export function openDb(path = join(orchestraHome(), "orchestra.db")) {
  if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);

  const getRun = (id: string) => {
    const row = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  };
  const getTask = (id: string) => {
    const row = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toTask(row) : null;
  };

  return {
    close: () => db.close(),

    listAgents: () => db.query<AgentRow, []>("SELECT * FROM agents ORDER BY created_at").all().map(toAgent),
    getAgent: (id: string) => {
      const row = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
      return row ? toAgent(row) : null;
    },
    createAgent: (a: AgentInput): Agent => {
      const agent: Agent = { ...a, id: crypto.randomUUID(), createdAt: Date.now() };
      db.query(
        "INSERT INTO agents (id, name, runtime, model, role, skills, instructions, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(agent.id, agent.name, agent.runtime, agent.model, agent.role, agent.skills, agent.instructions, agent.createdAt);
      return agent;
    },
    updateAgent: (id: string, a: AgentInput) =>
      db.query("UPDATE agents SET name = ?, runtime = ?, model = ?, role = ?, skills = ?, instructions = ? WHERE id = ?")
        .run(a.name, a.runtime, a.model, a.role, a.skills, a.instructions, id).changes > 0,
    agentInUse: (id: string) =>
      db.query("SELECT 1 FROM runs WHERE director_agent_id = ?1 UNION SELECT 1 FROM tasks WHERE agent_id = ?1").get(id) !== null,
    deleteAgent: (id: string) => db.query("DELETE FROM agents WHERE id = ?").run(id).changes > 0,

    listRuns: () => db.query<RunRow, []>("SELECT * FROM runs ORDER BY created_at DESC").all().map(toRun),
    getRun,
    createRun: (r: Pick<Run, "id" | "prompt" | "workdir" | "directorAgentId" | "baseCommit" | "branch" | "warning">): Run => {
      db.query(
        "INSERT INTO runs (id, prompt, workdir, director_agent_id, status, base_commit, branch, warning, created_at) VALUES (?, ?, ?, ?, 'planning', ?, ?, ?, ?)",
      ).run(r.id, r.prompt, r.workdir, r.directorAgentId, r.baseCommit, r.branch, r.warning, Date.now());
      return getRun(r.id)!;
    },
    updateRun: (id: string, patch: { status?: RunStatus; plan?: Plan | null; error?: string | null }): Run => {
      const cur = getRun(id)!;
      const status = patch.status ?? cur.status;
      const plan = patch.plan === undefined ? cur.plan : patch.plan;
      const error = patch.error === undefined ? cur.error : patch.error;
      db.query("UPDATE runs SET status = ?, plan_json = ?, error = ? WHERE id = ?")
        .run(status, plan ? JSON.stringify(plan) : null, error, id);
      return getRun(id)!;
    },

    listTasks: (runId: string) =>
      db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId).map(toTask),
    getTask,
    insertTasks: (runId: string, plan: Plan) =>
      db.transaction(() => {
        const insert = db.query(
          "INSERT INTO tasks (id, run_id, key, title, description, acceptance, agent_id, depends_on, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending')",
        );
        for (const t of plan.tasks) {
          insert.run(crypto.randomUUID(), runId, t.id, t.title, t.description, t.acceptanceCriteria, t.agentId, JSON.stringify(t.dependsOn));
        }
      })(),
    updateTask: (id: string, patch: Partial<Pick<Task, "status" | "summary" | "error" | "startedAt" | "finishedAt">>): Task => {
      const cur = getTask(id)!;
      const next = { ...cur, ...patch };
      db.query("UPDATE tasks SET status = ?, summary = ?, error = ?, started_at = ?, finished_at = ? WHERE id = ?")
        .run(next.status, next.summary, next.error, next.startedAt, next.finishedAt, id);
      return getTask(id)!;
    },

    addLog: (runId: string, taskId: string | null, kind: LogKind, text: string): LogEntry => {
      const ts = Date.now();
      const { lastInsertRowid } = db.query("INSERT INTO logs (run_id, task_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)")
        .run(runId, taskId, ts, kind, text);
      return { id: Number(lastInsertRowid), runId, taskId, ts, kind, text };
    },
    listLogs: (runId: string, taskId: string | null) =>
      db.query<LogRow, [string, string | null]>("SELECT * FROM logs WHERE run_id = ? AND task_id IS ? ORDER BY id")
        .all(runId, taskId).map(toLog),

    /** After a restart no child process survives: fail anything that was in flight. */
    failInterrupted: () => {
      db.query("UPDATE tasks SET status = 'failed', error = 'interrupted by server restart', finished_at = ? WHERE status = 'running'")
        .run(Date.now());
      db.query("UPDATE runs SET status = 'failed', error = 'interrupted by server restart' WHERE status IN ('planning', 'running')").run();
    },
  };
}
