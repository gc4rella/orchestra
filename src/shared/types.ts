export const RUNTIMES = ["claude-code", "codex"] as const;
export type Runtime = (typeof RUNTIMES)[number];

export type Agent = {
  id: string;
  name: string;
  runtime: Runtime;
  model: string | null;
  role: string;
  skills: string;
  instructions: string | null;
  createdAt: number;
};

/** The one agent with this role directs every run: it plans and staffs, the rest of the team does the work. */
export const DIRECTOR_ROLE = "Director (product & engineering)";
export const isDirector = (a: Pick<Agent, "role">) => a.role.trim().toLowerCase() === DIRECTOR_ROLE.toLowerCase();

export type RuntimeInfo = { runtime: Runtime; installed: boolean; version: string | null };

export type RunStatus = "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked" | "cancelled";

export type PlanTask = {
  id: string;
  title: string;
  description: string;
  agentId: string;
  dependsOn: string[];
  acceptanceCriteria: string;
};
/** "definition": spec/design groundwork, after which the director plans the build. "build": the rest of the work. */
export const PLAN_STAGES = ["definition", "build"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];
export type Plan = { summary: string; stage: PlanStage; tasks: PlanTask[] };

export type Run = {
  id: string;
  prompt: string;
  workdir: string;
  directorAgentId: string;
  status: RunStatus;
  plan: Plan | null;
  baseCommit: string;
  branch: string;
  error: string | null;
  warning: string | null;
  createdAt: number;
};

export type Task = {
  id: string;
  runId: string;
  key: string;
  title: string;
  description: string;
  acceptance: string;
  agentId: string;
  dependsOn: string[];
  status: TaskStatus;
  summary: string | null;
  error: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

export type LogKind = "text" | "tool" | "result" | "error" | "system";
export type LogEntry = { id: number; runId: string; taskId: string | null; ts: number; kind: LogKind; text: string };

export type ServerEvent =
  | { type: "run"; run: Run }
  | { type: "task"; task: Task }
  | { type: "log"; log: LogEntry };

export const FINISHED_RUN: RunStatus[] = ["completed", "failed", "cancelled"];
