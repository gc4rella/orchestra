import { Database } from "bun:sqlite";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { SecretBody, SecretError, secretCipher } from "./secrets.ts";
import type { SecretInput } from "./secrets.ts";
import type { Secret } from "../shared/types.ts";
import type {
  Agent, AgentStats, LogEntry, LogKind, Plan, PlanStage, Run, RunStatus, Runtime, Session, Skill, Task, TaskStatus, Team, Usage, RunControl, TaskCheckpoint, RateLimitPolicy, Evidence, AgentEvent, DeliveryPolicy, DirectorChatTurn,
} from "../shared/types.ts";

import { defaultRunControl, defaultTaskCheckpoint, defaultDeliveryPolicy, DEFAULT_RUN_TIMEOUTS } from "../shared/types.ts";

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

/**
 * Applied in order on top of SCHEMA (version 0), tracked in PRAGMA user_version.
 * Additive only, with defaults, so an older build keeps working on a migrated database.
 */
const MIGRATIONS = [
  `
  ALTER TABLE runs ADD COLUMN autonomous INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN recoveries INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN fix_rounds INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE runs ADD COLUMN report TEXT;
  ALTER TABLE tasks ADD COLUMN stage TEXT NOT NULL DEFAULT 'build';
  ALTER TABLE tasks ADD COLUMN reviewer_id TEXT;
  ALTER TABLE tasks ADD COLUMN feedback TEXT;
  ALTER TABLE tasks ADD COLUMN session_json TEXT;
  ALTER TABLE tasks ADD COLUMN iterations INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN cost_usd REAL NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN tokens INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN merge_commit TEXT;
  -- Before stages were stored, build tasks were only inserted when a build plan was approved, so existing
  -- tasks are definition work when the stored plan is the definition plan or a build plan not yet approved.
  UPDATE tasks SET stage = 'definition' WHERE run_id IN (
    SELECT id FROM runs WHERE json_extract(plan_json, '$.stage') = 'definition'
      OR (json_extract(plan_json, '$.stage') = 'build' AND (status = 'awaiting_approval'
        OR (status = 'failed' AND NOT EXISTS (SELECT 1 FROM tasks t WHERE t.run_id = runs.id AND t.status != 'done'))))
  );
  `,
  `ALTER TABLE runs ADD COLUMN control_json TEXT NOT NULL DEFAULT '{}';
   ALTER TABLE tasks ADD COLUMN checkpoint_json TEXT NOT NULL DEFAULT '{}';`,
  `
  CREATE TABLE teams (
    id TEXT PRIMARY KEY, name TEXT NOT NULL, director_id TEXT NOT NULL REFERENCES agents(id), created_at INTEGER NOT NULL
  );
  CREATE TABLE team_members (
    team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE, agent_id TEXT NOT NULL REFERENCES agents(id) ON DELETE CASCADE,
    PRIMARY KEY (team_id, agent_id)
  );
  ALTER TABLE runs ADD COLUMN team_id TEXT;
  -- Before teams, the one Director-role agent staffed every run from all other agents: that becomes the first team.
  INSERT INTO teams (id, name, director_id, created_at)
    SELECT 'default', 'My team', director, CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER) FROM (SELECT COALESCE(
      (SELECT id FROM agents WHERE lower(trim(role)) = 'director (product & engineering)' ORDER BY created_at LIMIT 1),
      (SELECT director_agent_id FROM runs ORDER BY created_at DESC LIMIT 1)
    ) AS director) WHERE director IS NOT NULL;
  INSERT INTO team_members (team_id, agent_id)
    SELECT t.id, a.id FROM teams t JOIN agents a ON a.id != t.director_id WHERE t.id = 'default';
  UPDATE runs SET team_id = 'default' WHERE EXISTS (SELECT 1 FROM teams WHERE id = 'default');
  `,
  // The old `skills` column keeps the free-text expertise; marketplace skills are their own list.
  `ALTER TABLE agents ADD COLUMN skills_json TEXT NOT NULL DEFAULT '[]';`,
  `ALTER TABLE agents ADD COLUMN effort TEXT;`,
  // Keyed by the run's workdir, the same key the UI groups projects by.
  `CREATE TABLE projects (workdir TEXT PRIMARY KEY, memory TEXT NOT NULL DEFAULT '', updated_at INTEGER NOT NULL);`,
  `ALTER TABLE agents ADD COLUMN rate_limit_policy_json TEXT NOT NULL DEFAULT 'null';
   ALTER TABLE projects ADD COLUMN rate_limit_policy_json TEXT NOT NULL DEFAULT 'null';`,
  `CREATE TABLE settings (key TEXT PRIMARY KEY, value_json TEXT NOT NULL);`,
  `ALTER TABLE projects ADD COLUMN delivery_policy_json TEXT NOT NULL DEFAULT 'null';
   CREATE TABLE evidence (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX evidence_run ON evidence(run_id, created_at);
   CREATE TABLE agent_events (id TEXT PRIMARY KEY, run_id TEXT NOT NULL REFERENCES runs(id), payload_json TEXT NOT NULL, created_at INTEGER NOT NULL);
   CREATE INDEX agent_events_run ON agent_events(run_id, created_at);
   CREATE TABLE project_lessons (id TEXT PRIMARY KEY, workdir TEXT NOT NULL, source_run_id TEXT NOT NULL, source_commit TEXT NOT NULL,
     text TEXT NOT NULL, evidence_json TEXT NOT NULL DEFAULT '[]', status TEXT NOT NULL DEFAULT 'proposed', created_at INTEGER NOT NULL,
     UNIQUE(source_run_id, source_commit, text));`,
  `CREATE TABLE director_chat (
     id INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
     text TEXT NOT NULL, reply TEXT NOT NULL DEFAULT '', status TEXT NOT NULL DEFAULT 'pending',
     error TEXT, created_at INTEGER NOT NULL
   );
   CREATE INDEX director_chat_run ON director_chat(run_id, id);`,
  `CREATE TABLE project_secrets (
     workdir TEXT NOT NULL, scope TEXT NOT NULL DEFAULT '', name TEXT NOT NULL, encrypted_value TEXT NOT NULL,
     environment INTEGER NOT NULL DEFAULT 0, source_run_id TEXT REFERENCES runs(id) ON DELETE CASCADE,
     source_commit TEXT, updated_at INTEGER NOT NULL,
     PRIMARY KEY (workdir, scope, name)
   );`,
];

function migrate(db: Database) {
  const version = db.query<{ user_version: number }, []>("PRAGMA user_version").get()!.user_version;
  MIGRATIONS.slice(version).forEach((sql, i) =>
    db.transaction(() => {
      db.exec(sql);
      db.exec(`PRAGMA user_version = ${version + i + 1}`);
    })(),
  );
}

/** Plans stored before `verify`, `lessons` and `reviewerId` existed; the strict schema would reject them on approval. */
function normalizePlan(raw: Plan): Plan {
  return { ...raw, verify: raw.verify ?? "", lessons: raw.lessons ?? "", tasks: raw.tasks.map((t) => ({ ...t, reviewerId: t.reviewerId ?? "" })) };
}

type AgentRow = {
  id: string; name: string; runtime: Runtime; model: string | null; effort: string | null; role: string; skills: string;
  instructions: string | null; created_at: number; skills_json: string; rate_limit_policy_json: string;
};
type TeamRow = { id: string; name: string; director_id: string; created_at: number; member_ids: string };
type RunRow = {
  id: string; prompt: string; workdir: string; team_id: string | null; director_agent_id: string; status: RunStatus; plan_json: string | null;
  base_commit: string; branch: string; error: string | null; warning: string | null; autonomous: number;
  cost_usd: number; tokens: number; recoveries: number; fix_rounds: number; report: string | null; created_at: number; control_json: string;
};
type TaskRow = {
  id: string; run_id: string; key: string; title: string; description: string; acceptance: string; agent_id: string;
  reviewer_id: string | null; depends_on: string; stage: PlanStage; status: TaskStatus; summary: string | null;
  error: string | null; feedback: string | null; session_json: string | null; iterations: number; cost_usd: number;
  tokens: number; merge_commit: string | null; started_at: number | null; finished_at: number | null; checkpoint_json: string;
};
type LogRow = { id: number; run_id: string; task_id: string | null; ts: number; kind: LogKind; text: string };

const toAgent = (r: AgentRow): Agent => ({
  id: r.id, name: r.name, runtime: r.runtime, model: r.model, effort: r.effort, role: r.role, expertise: r.skills,
  rateLimitPolicy: JSON.parse(r.rate_limit_policy_json) as RateLimitPolicy | null,
  skills: JSON.parse(r.skills_json) as Skill[], instructions: r.instructions, createdAt: r.created_at,
});
const toTeam = (r: TeamRow): Team => ({
  id: r.id, name: r.name, directorId: r.director_id, memberIds: JSON.parse(r.member_ids) as string[], createdAt: r.created_at,
});
const toRun = (r: RunRow): Run => {
  const control = JSON.parse(r.control_json) as Partial<RunControl>;
  return {
    ...defaultRunControl(), checkpoint: r.status === "awaiting_approval" ? "approve" : r.status === "running" ? "execute" : "plan", ...control,
    timeouts: { ...DEFAULT_RUN_TIMEOUTS, ...control.timeouts },
    history: (control.history ?? []).map((h) => ({ ...h, plan: h.plan && normalizePlan(h.plan) })),
    id: r.id, prompt: r.prompt, workdir: r.workdir, teamId: r.team_id, directorAgentId: r.director_agent_id, status: r.status,
    plan: r.plan_json ? normalizePlan(JSON.parse(r.plan_json) as Plan) : null, baseCommit: r.base_commit, branch: r.branch,
    error: r.error, warning: r.warning, autonomous: r.autonomous === 1, costUsd: r.cost_usd, tokens: r.tokens,
    recoveries: r.recoveries, fixRounds: r.fix_rounds, report: r.report, createdAt: r.created_at,
  };
};
const toTask = (r: TaskRow): Task => ({
  ...defaultTaskCheckpoint(), phase: r.status === "done" ? "done" : "work", ...JSON.parse(r.checkpoint_json) as Partial<TaskCheckpoint>,
  id: r.id, runId: r.run_id, key: r.key, title: r.title, description: r.description, acceptance: r.acceptance,
  agentId: r.agent_id, reviewerId: r.reviewer_id, dependsOn: JSON.parse(r.depends_on) as string[], stage: r.stage,
  status: r.status, summary: r.summary, error: r.error, feedback: r.feedback,
  session: r.session_json ? (JSON.parse(r.session_json) as Session) : null, iterations: r.iterations,
  costUsd: r.cost_usd, tokens: r.tokens, mergeCommit: r.merge_commit, startedAt: r.started_at, finishedAt: r.finished_at,
});
const toLog = (r: LogRow): LogEntry => ({ id: r.id, runId: r.run_id, taskId: r.task_id, ts: r.ts, kind: r.kind, text: r.text });
const CHAT_SELECT = "SELECT id, run_id AS runId, text, reply, status, error, created_at AS createdAt FROM director_chat";

export type AgentInput = Omit<Agent, "id" | "createdAt">;
export type TeamInput = Omit<Team, "id" | "createdAt">;
export type RunPatch = Partial<RunControl & Pick<Run, "status" | "plan" | "error" | "recoveries" | "fixRounds" | "report">>;
export type TaskPatch = Partial<TaskCheckpoint & Pick<
  Task, "agentId" | "reviewerId" | "status" | "summary" | "error" | "feedback" | "session" | "iterations" | "mergeCommit" | "startedAt" | "finishedAt"
>>;
export type Db = ReturnType<typeof openDb>;

export function openDb(path = join(orchestraHome(), "orchestra.db")) {
  if (path !== ":memory:") mkdirSync(join(path, ".."), { recursive: true });
  const db = new Database(path, { strict: true });
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;");
  db.exec(SCHEMA);
  migrate(db);
  const cipher = secretCipher(path === ":memory:" ? null : `${path}.secrets-key`);
  const secretContext = (workdir: string, scope: string, name: string) => JSON.stringify([workdir, scope, name]);
  const revealSecret = (workdir: string, scope: string, name: string) => {
    const row = db.query<{ encrypted_value: string }, [string, string, string]>("SELECT encrypted_value FROM project_secrets WHERE workdir = ? AND scope = ? AND name = ?").get(workdir, scope, name);
    return row ? cipher.open(row.encrypted_value, secretContext(workdir, scope, name)) : null;
  };

  const getRun = (id: string) => {
    const row = db.query<RunRow, [string]>("SELECT * FROM runs WHERE id = ?").get(id);
    return row ? toRun(row) : null;
  };
  // Members in the order they were added (rowid), so the roster reads the way the team was formed.
  const TEAM_SELECT = `SELECT t.*, (SELECT COALESCE(json_group_array(agent_id), '[]') FROM (SELECT agent_id FROM team_members m WHERE m.team_id = t.id ORDER BY m.rowid)) AS member_ids FROM teams t`;
  const getTeam = (id: string) => {
    const row = db.query<TeamRow, [string]>(`${TEAM_SELECT} WHERE t.id = ?`).get(id);
    return row ? toTeam(row) : null;
  };
  const setMembers = (teamId: string, memberIds: string[]) => {
    db.query("DELETE FROM team_members WHERE team_id = ?").run(teamId);
    const insert = db.query("INSERT INTO team_members (team_id, agent_id) VALUES (?, ?)");
    for (const agentId of memberIds) insert.run(teamId, agentId);
  };
  const getTask = (id: string) => {
    const row = db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE id = ?").get(id);
    return row ? toTask(row) : null;
  };

  return {
    close: () => db.close(),

    listSecrets: (workdir: string, runId: string): Secret[] => db.query<{ name: string; scope: string; environment: number; source_commit: string | null; updated_at: number }, [string, string]>("SELECT name, scope, environment, source_commit, updated_at FROM project_secrets WHERE workdir = ? AND scope IN ('', ?) ORDER BY scope, name").all(workdir, runId)
      .map((row) => ({ name: row.name, source: row.scope ? "preview" : "saved", environment: !!row.environment, commit: row.source_commit, updatedAt: row.updated_at })),
    revealSecret,
    saveSecret: (workdir: string, input: SecretInput, preview?: { runId: string; commit: string | null }) => {
      const parsed = SecretBody.safeParse(input);
      if (!parsed.success) throw new SecretError("Invalid secret name, value or environment variable");
      const { name, value, environment } = parsed.data;
      const scope = preview?.runId ?? "";
      const existing = db.query("SELECT 1 FROM project_secrets WHERE workdir = ? AND scope = ? AND name = ?").get(workdir, scope, name);
      if (!existing && db.query<{ count: number }, [string, string]>("SELECT COUNT(*) AS count FROM project_secrets WHERE workdir = ? AND scope = ?").get(workdir, scope)!.count >= 100) throw new SecretError("This project already has 100 secrets in this group");
      const createKey = db.query("SELECT 1 FROM project_secrets LIMIT 1").get() === null;
      db.query("INSERT INTO project_secrets (workdir, scope, name, encrypted_value, environment, source_run_id, source_commit, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8) ON CONFLICT(workdir, scope, name) DO UPDATE SET encrypted_value = ?4, environment = ?5, source_commit = ?7, updated_at = ?8")
        .run(workdir, scope, name, cipher.seal(value, secretContext(workdir, scope, name), createKey), preview ? 0 : Number(environment), preview?.runId ?? null, preview?.commit ?? null, Date.now());
    },
    deleteSecret: (workdir: string, scope: string, name: string) => db.query("DELETE FROM project_secrets WHERE workdir = ? AND scope = ? AND name = ?").run(workdir, scope, name).changes > 0,
    secretEnvironment: (workdir: string): Record<string, string> => Object.fromEntries(db.query<{ name: string }, [string]>("SELECT name FROM project_secrets WHERE workdir = ? AND scope = '' AND environment = 1").all(workdir)
      .map(({ name }) => [name, revealSecret(workdir, "", name)!])),

    listAgents: () => db.query<AgentRow, []>("SELECT * FROM agents ORDER BY created_at").all().map(toAgent),
    getAgent: (id: string) => {
      const row = db.query<AgentRow, [string]>("SELECT * FROM agents WHERE id = ?").get(id);
      return row ? toAgent(row) : null;
    },
    createAgent: (a: AgentInput): Agent => {
      const agent: Agent = { ...a, rateLimitPolicy: a.rateLimitPolicy ?? null, id: crypto.randomUUID(), createdAt: Date.now() };
      db.query(
        "INSERT INTO agents (id, name, runtime, model, effort, role, skills, skills_json, instructions, created_at, rate_limit_policy_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      ).run(agent.id, agent.name, agent.runtime, agent.model, agent.effort, agent.role, agent.expertise, JSON.stringify(agent.skills), agent.instructions, agent.createdAt, JSON.stringify(agent.rateLimitPolicy));
      return agent;
    },
    updateAgent: (id: string, a: AgentInput) =>
      db.query("UPDATE agents SET name = ?, runtime = ?, model = ?, effort = ?, role = ?, skills = ?, skills_json = ?, instructions = ?, rate_limit_policy_json = ? WHERE id = ?")
        .run(a.name, a.runtime, a.model, a.effort, a.role, a.expertise, JSON.stringify(a.skills), a.instructions, JSON.stringify(a.rateLimitPolicy ?? null), id).changes > 0,
    agentInUse: (id: string) =>
      db.query("SELECT 1 FROM runs WHERE director_agent_id = ?1 UNION SELECT 1 FROM tasks WHERE agent_id = ?1 OR reviewer_id = ?1").get(id) !== null,
    /** Per-agent totals over all runs; agents without tasks or reviews are absent. */
    agentStats: (): Record<string, AgentStats> => {
      const stats: Record<string, AgentStats> = {};
      const blank = (): AgentStats => ({ done: 0, failed: 0, firstTry: 0, avgAttempts: null, costUsd: 0, tokens: 0, reviews: 0 });
      type WorkRow = { agent_id: string; done: number; failed: number; first_try: number; avg_attempts: number | null; cost_usd: number; tokens: number };
      for (const r of db.query<WorkRow, []>(
        `SELECT agent_id, SUM(status = 'done') AS done, SUM(status = 'failed') AS failed,
           SUM(status = 'done' AND iterations <= 1) AS first_try, AVG(CASE WHEN status = 'done' THEN iterations END) AS avg_attempts,
           SUM(cost_usd) AS cost_usd, SUM(tokens) AS tokens
         FROM tasks GROUP BY agent_id`,
      ).all()) {
        stats[r.agent_id] = { ...blank(), done: r.done, failed: r.failed, firstTry: r.first_try, avgAttempts: r.avg_attempts, costUsd: r.cost_usd, tokens: r.tokens };
      }
      for (const r of db.query<{ reviewer_id: string; reviews: number }, []>(
        "SELECT reviewer_id, COUNT(*) AS reviews FROM tasks WHERE reviewer_id IS NOT NULL AND status = 'done' GROUP BY reviewer_id",
      ).all()) {
        stats[r.reviewer_id] = { ...(stats[r.reviewer_id] ?? blank()), reviews: r.reviews };
      }
      return stats;
    },
    deleteAgent: (id: string) => db.query("DELETE FROM agents WHERE id = ?").run(id).changes > 0,

    listTeams: () => db.query<TeamRow, []>(`${TEAM_SELECT} ORDER BY t.created_at, t.rowid`).all().map(toTeam),
    getTeam,
    createTeam: (t: TeamInput): Team =>
      db.transaction(() => {
        const id = crypto.randomUUID();
        db.query("INSERT INTO teams (id, name, director_id, created_at) VALUES (?, ?, ?, ?)").run(id, t.name, t.directorId, Date.now());
        setMembers(id, t.memberIds);
        return getTeam(id)!;
      })(),
    updateTeam: (id: string, t: TeamInput) =>
      db.transaction(() => {
        if (db.query("UPDATE teams SET name = ?, director_id = ? WHERE id = ?").run(t.name, t.directorId, id).changes === 0) return false;
        setMembers(id, t.memberIds);
        return true;
      })(),
    teamInUse: (id: string) => db.query("SELECT 1 FROM runs WHERE team_id = ?").get(id) !== null,
    teamsDirectedBy: (agentId: string) => db.query<TeamRow, [string]>(`${TEAM_SELECT} WHERE t.director_id = ?`).all(agentId).map(toTeam),
    /** Memberships go with the team. */
    deleteTeam: (id: string) => db.query("DELETE FROM teams WHERE id = ?").run(id).changes > 0,

    getGlobalRateLimitPolicy: (): RateLimitPolicy | null => {
      const row = db.query<{ value_json: string }, []>("SELECT value_json FROM settings WHERE key = 'rateLimitPolicy'").get();
      return row ? JSON.parse(row.value_json) : null;
    },
    setGlobalRateLimitPolicy: (policy: RateLimitPolicy | null) => {
      db.query("INSERT INTO settings (key, value_json) VALUES ('rateLimitPolicy', ?1) ON CONFLICT (key) DO UPDATE SET value_json = ?1")
        .run(JSON.stringify(policy));
    },
    getRateLimitPolicy: (workdir: string): RateLimitPolicy | null => {
      const row = db.query<{ rate_limit_policy_json: string }, [string]>("SELECT rate_limit_policy_json FROM projects WHERE workdir = ?").get(workdir);
      return row ? JSON.parse(row.rate_limit_policy_json) : null;
    },
    setRateLimitPolicy: (workdir: string, policy: RateLimitPolicy | null) => {
      db.query("INSERT INTO projects (workdir, rate_limit_policy_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (workdir) DO UPDATE SET rate_limit_policy_json = ?2, updated_at = ?3")
        .run(workdir, JSON.stringify(policy), Date.now());
    },
    /** A project's memory: notes every agent in its runs is given; "" until the user saves some. */
    getMemory: (workdir: string) =>
      db.query<{ memory: string }, [string]>("SELECT memory FROM projects WHERE workdir = ?").get(workdir)?.memory ?? "",
    setMemory: (workdir: string, memory: string) => {
      db.query("INSERT INTO projects (workdir, memory, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT (workdir) DO UPDATE SET memory = ?2, updated_at = ?3")
        .run(workdir, memory, Date.now());
      const lines = new Set(memory.split("\n").map((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim()));
      for (const lesson of db.query<{ id: string; text: string }, [string]>("SELECT id, text FROM project_lessons WHERE workdir = ? AND status = 'proposed'").all(workdir)) {
        if (lines.has(lesson.text)) db.query("UPDATE project_lessons SET status = 'accepted' WHERE id = ?").run(lesson.id);
      }
    },

    listRuns: () => db.query<RunRow, []>("SELECT * FROM runs ORDER BY created_at DESC").all().map(toRun),
    getRun,
    getDeliveryPolicy: (workdir: string): DeliveryPolicy => {
      const row = db.query<{ delivery_policy_json: string }, [string]>("SELECT delivery_policy_json FROM projects WHERE workdir = ?").get(workdir);
      return row ? JSON.parse(row.delivery_policy_json) ?? defaultDeliveryPolicy() : defaultDeliveryPolicy();
    },
    setDeliveryPolicy: (workdir: string, delivery: DeliveryPolicy) => {
      db.query("INSERT INTO projects (workdir, delivery_policy_json, updated_at) VALUES (?1, ?2, ?3) ON CONFLICT(workdir) DO UPDATE SET delivery_policy_json = ?2, updated_at = ?3")
        .run(workdir, JSON.stringify(delivery), Date.now());
    },
    recordEvidence: (input: Omit<Evidence, "id" | "createdAt">): Evidence => {
      const evidence: Evidence = { ...input, id: crypto.randomUUID(), createdAt: Date.now() };
      db.query("INSERT INTO evidence (id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?)")
        .run(evidence.id, evidence.runId, JSON.stringify(evidence), evidence.createdAt);
      return evidence;
    },
    listEvidence: (runId: string): Evidence[] => db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM evidence WHERE run_id = ? ORDER BY rowid").all(runId).map((r) => JSON.parse(r.payload_json) as Evidence),
    recordAgentEvent: (event: AgentEvent): AgentEvent => {
      db.query("INSERT INTO agent_events (id, run_id, payload_json, created_at) VALUES (?, ?, ?, ?)").run(event.id, event.runId, JSON.stringify(event), event.ts);
      return event;
    },
    listAgentEvents: (runId: string): AgentEvent[] => db.query<{ payload_json: string }, [string]>("SELECT payload_json FROM agent_events WHERE run_id = ? ORDER BY rowid").all(runId).map((r) => JSON.parse(r.payload_json) as AgentEvent),
    proposeLessons: (runId: string, commit: string, text: string) => {
      const run = getRun(runId)!;
      const evidence = db.query<{ id: string }, [string]>("SELECT id FROM evidence WHERE run_id = ? ORDER BY rowid DESC LIMIT 20").all(runId).map((r) => r.id);
      const insert = db.query("INSERT OR IGNORE INTO project_lessons (id, workdir, source_run_id, source_commit, text, evidence_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)");
      for (const line of text.split("\n").map((v) => v.replace(/^\s*[-*\d.)]+\s*/, "").trim()).filter(Boolean).slice(0, 10)) {
        insert.run(crypto.randomUUID(), run.workdir, runId, commit, line, JSON.stringify(evidence), Date.now());
      }
    },
    listLessons: (workdir: string) => db.query<{ id: string; source_run_id: string; source_commit: string; text: string; evidence_json: string; status: "proposed" | "accepted" | "retired"; created_at: number }, [string]>("SELECT * FROM project_lessons WHERE workdir = ? ORDER BY created_at DESC LIMIT 100").all(workdir)
      .map((r) => ({ id: r.id, runId: r.source_run_id, commit: r.source_commit, text: r.text, evidenceIds: JSON.parse(r.evidence_json) as string[], status: r.status, createdAt: r.created_at })),
    setLessonStatus: (workdir: string, id: string, status: "accepted" | "retired") => db.query("UPDATE project_lessons SET status = ? WHERE id = ? AND workdir = ?").run(status, id, workdir).changes > 0,
    createRun: (
      r: Pick<Run, "id" | "prompt" | "workdir" | "directorAgentId" | "baseCommit" | "branch" | "warning"> & { delivery?: DeliveryPolicy; preview?: Run["preview"]; teamId?: string | null; autonomous?: boolean; continuous?: boolean; autoContinueOnRateLimit?: boolean; rateLimitPolicy?: RateLimitPolicy | null; checkCommand?: string; limits?: Run["limits"]; timeouts?: Run["timeouts"] },
    ): Run => {
      db.query(
        "INSERT INTO runs (id, prompt, workdir, team_id, director_agent_id, status, base_commit, branch, warning, autonomous, created_at, control_json) VALUES (?, ?, ?, ?, ?, 'planning', ?, ?, ?, ?, ?, ?)",
      ).run(r.id, r.prompt, r.workdir, r.teamId ?? null, r.directorAgentId, r.baseCommit, r.branch, r.warning, r.autonomous ? 1 : 0, Date.now(), JSON.stringify({ ...defaultRunControl(), delivery: r.delivery ?? defaultDeliveryPolicy(), acceptedCommit: r.baseCommit, preview: r.preview ?? defaultRunControl().preview, rateLimitPolicy: r.rateLimitPolicy ?? null, continuous: r.continuous ?? false, autoContinueOnRateLimit: r.autoContinueOnRateLimit ?? false, checkCommand: r.checkCommand ?? "", limits: r.limits ?? null, timeouts: r.timeouts ?? { ...DEFAULT_RUN_TIMEOUTS } }));
      return getRun(r.id)!;
    },
    transaction: <T>(fn: () => T): T => db.transaction(fn)(),
    updateRun: (id: string, patch: RunPatch): Run => {
      const next = { ...getRun(id)!, ...patch };
      db.query("UPDATE runs SET status = ?, plan_json = ?, error = ?, recoveries = ?, fix_rounds = ?, report = ?, control_json = ? WHERE id = ?")
        .run(next.status, next.plan ? JSON.stringify(next.plan) : null, next.error, next.recoveries, next.fixRounds, next.report, JSON.stringify(Object.fromEntries(Object.keys(defaultRunControl()).map((k) => [k, next[k as keyof RunControl]]))), id);
      return getRun(id)!;
    },

    /** Logs and tasks reference the run, so they go first. */
    deleteRun: (id: string) =>
      db.transaction(() => {
        db.query("DELETE FROM evidence WHERE run_id = ?").run(id);
        db.query("DELETE FROM agent_events WHERE run_id = ?").run(id);
        db.query("DELETE FROM logs WHERE run_id = ?").run(id);
        db.query("DELETE FROM tasks WHERE run_id = ?").run(id);
        return db.query("DELETE FROM runs WHERE id = ?").run(id).changes > 0;
      })(),

    listTasks: (runId: string) =>
      db.query<TaskRow, [string]>("SELECT * FROM tasks WHERE run_id = ? ORDER BY rowid").all(runId).map(toTask),
    getTask,
    insertTasks: (runId: string, plan: Plan, cycle = 1) =>
      db.transaction(() => {
        const insert = db.query(
          "INSERT INTO tasks (id, run_id, key, title, description, acceptance, agent_id, reviewer_id, depends_on, stage, status, checkpoint_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)",
        );
        for (const t of plan.tasks) {
          insert.run(
            crypto.randomUUID(), runId, t.id, t.title, t.description, t.acceptanceCriteria, t.agentId, t.reviewerId || null,
            JSON.stringify(t.dependsOn), plan.stage, JSON.stringify({ ...defaultTaskCheckpoint(), cycle, ...(t.contract && { contract: t.contract }) }),
          );
        }
      })(),
    updateTask: (id: string, patch: TaskPatch): Task => {
      const next = { ...getTask(id)!, ...patch };
      db.query(
        "UPDATE tasks SET agent_id = ?, reviewer_id = ?, status = ?, summary = ?, error = ?, feedback = ?, session_json = ?, iterations = ?, merge_commit = ?, started_at = ?, finished_at = ?, checkpoint_json = ? WHERE id = ?",
      ).run(
        next.agentId, next.reviewerId, next.status, next.summary, next.error, next.feedback, next.session ? JSON.stringify(next.session) : null,
        next.iterations, next.mergeCommit, next.startedAt, next.finishedAt, JSON.stringify(Object.fromEntries(Object.keys(defaultTaskCheckpoint()).map((k) => [k, next[k as keyof TaskCheckpoint]]))), id,
      );
      return getTask(id)!;
    },
    /** Adds one agent invocation's usage to the run and, when it worked on one, the task. */
    addUsage: (runId: string, taskId: string | null, usage: Usage) =>
      db.transaction(() => {
        const cost = usage.costUsd ?? 0;
        db.query("UPDATE runs SET cost_usd = cost_usd + ?, tokens = tokens + ? WHERE id = ?").run(cost, usage.tokens, runId);
        if (taskId) db.query("UPDATE tasks SET cost_usd = cost_usd + ?, tokens = tokens + ? WHERE id = ?").run(cost, usage.tokens, taskId);
      })(),

    listDirectorChat: (runId: string) => db.query<DirectorChatTurn, [string]>(`${CHAT_SELECT} WHERE run_id = ? ORDER BY id`).all(runId),
    addDirectorChat: (runId: string, text: string): DirectorChatTurn => {
      const { lastInsertRowid } = db.query("INSERT INTO director_chat (run_id, text, created_at) VALUES (?, ?, ?)").run(runId, text, Date.now());
      return db.query<DirectorChatTurn, [number]>(`${CHAT_SELECT} WHERE id = ?`).get(Number(lastInsertRowid))!;
    },
    finishDirectorChat: (id: number, reply: string, error: string | null = null): DirectorChatTurn => {
      db.query("UPDATE director_chat SET reply = ?, status = ?, error = ? WHERE id = ? AND status = 'pending'").run(reply, error === null ? "completed" : "failed", error, id);
      return db.query<DirectorChatTurn, [number]>(`${CHAT_SELECT} WHERE id = ?`).get(id)!;
    },

    addLog: (runId: string, taskId: string | null, kind: LogKind, text: string): LogEntry => {
      const ts = Date.now();
      const { lastInsertRowid } = db.query("INSERT INTO logs (run_id, task_id, ts, kind, text) VALUES (?, ?, ?, ?, ?)")
        .run(runId, taskId, ts, kind, text);
      return { id: Number(lastInsertRowid), runId, taskId, ts, kind, text };
    },
    listActivity: (runId: string) => db.query<LogRow, [string]>("SELECT * FROM logs WHERE run_id = ? AND kind IN ('system', 'error') ORDER BY id DESC LIMIT 300").all(runId).map(toLog).reverse(),
    listLogs: (runId: string, taskId: string | null) =>
      db.query<LogRow, [string, string | null]>("SELECT * FROM logs WHERE run_id = ? AND task_id IS ? ORDER BY id")
        .all(runId, taskId).map(toLog),

    /** After a restart no child process survives: fail anything that was in flight. */
    failInterrupted: () => {
      db.query("UPDATE director_chat SET status = 'failed', error = 'Reply interrupted by server restart. Send your question again.' WHERE status = 'pending'").run();
      for (const run of db.query<RunRow, []>("SELECT * FROM runs WHERE status IN ('planning', 'running', 'pausing') OR (status = 'paused' AND json_extract(control_json, '$.rateLimitResumeAt') IS NOT NULL)").all().map(toRun)) {
        const control: RunControl = { ...run, activeElapsedMs: run.activeElapsedMs + (run.activeSince === null ? 0 : Date.now() - run.activeSince), activeSince: null, rateLimitResumeAt: null, pauseReason: "Interrupted by server restart" };
        db.query("UPDATE runs SET control_json = ? WHERE id = ?").run(JSON.stringify(Object.fromEntries(Object.keys(defaultRunControl()).map((k) => [k, control[k as keyof RunControl]]))), run.id);
      }
      db.query("UPDATE tasks SET status = 'failed', error = 'interrupted by server restart', finished_at = ? WHERE status = 'running'")
        .run(Date.now());
      db.query("UPDATE runs SET status = 'failed', error = 'interrupted by server restart' WHERE status IN ('planning', 'running', 'pausing')").run();
    },
  };
}
