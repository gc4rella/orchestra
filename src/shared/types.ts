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

/** What happens if a run starts in this project directory; "invalid" says why it can't. */
export type WorkspaceCheck =
  | { kind: "new" }
  | { kind: "empty" }
  | { kind: "repo"; head: string; branch: string | null; dirty: number }
  | { kind: "invalid"; reason: string; root?: string };

export type FolderListing = {
  path: string;
  parent: string | null;
  home: string;
  folders: { name: string; path: string; repo: boolean }[];
};

export type RuntimeInfo = { runtime: Runtime; installed: boolean; version: string | null };

export type RunStatus = "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled";
/** "superseded": replaced by a recovery plan after it failed or was blocked. */
export type TaskStatus = "pending" | "running" | "done" | "failed" | "blocked" | "cancelled" | "superseded";

export type PlanTask = {
  id: string;
  title: string;
  description: string;
  agentId: string;
  /** Teammate who reviews the work before it is merged; "" for no review. */
  reviewerId: string;
  dependsOn: string[];
  acceptanceCriteria: string;
};
/**
 * "definition": spec/design groundwork, after which the director plans the build. "build": the rest of the work.
 * "fix": the director's verification of a finished build; its tasks fix what is missing, and no tasks means accepted.
 */
export const PLAN_STAGES = ["definition", "build", "fix"] as const;
export type PlanStage = (typeof PLAN_STAGES)[number];
/** `verify` is a shell command that checks the work (install, test, build); "" for none. */
export type Plan = { summary: string; stage: PlanStage; verify: string; tasks: PlanTask[] };

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
  /** Plans are approved without the user, and failures and verification gaps are re-planned automatically. */
  autonomous: boolean;
  /** USD reported by the CLIs (Claude Code only); tokens from every runtime. */
  costUsd: number;
  tokens: number;
  /** Automatic recovery re-plans and verification fix rounds used so far. */
  recoveries: number;
  fixRounds: number;
  /** The director's verification report once the run completes. */
  report: string | null;
  createdAt: number;
};

export type Usage = { costUsd: number | null; tokens: number };
/** A CLI conversation that can be resumed, with the usage it has accumulated so far. */
export type Session = { id: string; costUsd: number; tokens: number };

export type Task = {
  id: string;
  runId: string;
  key: string;
  title: string;
  description: string;
  acceptance: string;
  agentId: string;
  reviewerId: string | null;
  dependsOn: string[];
  /** Stage of the plan that created the task. */
  stage: PlanStage;
  status: TaskStatus;
  summary: string | null;
  error: string | null;
  /** Guidance for the next attempt (the user's retry instructions); cleared once it starts. */
  feedback: string | null;
  /** Agent's conversation, resumed for fixes and retries. */
  session: Session | null;
  /** Work → check → review passes in the current attempt. */
  iterations: number;
  costUsd: number;
  tokens: number;
  /** Merge commit on the run branch, for the task's diff. */
  mergeCommit: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

/** One file of a diff; `patch` holds the hunks (from the first "@@"), clipped when `truncated`. */
export type DiffFile = {
  path: string;
  oldPath: string | null;
  status: "added" | "modified" | "deleted" | "renamed";
  additions: number;
  deletions: number;
  binary: boolean;
  patch: string;
  truncated: boolean;
};

/** A reviewer's note on one line of the run's diff; sent to the director as feedback. */
export type ReviewComment = { file: string; line: number; text: string };

export type LogKind = "text" | "tool" | "result" | "error" | "system";
export type LogEntry = { id: number; runId: string; taskId: string | null; ts: number; kind: LogKind; text: string };

export type ServerEvent =
  | { type: "run"; run: Run }
  | { type: "task"; task: Task }
  | { type: "log"; log: LogEntry };

export const FINISHED_RUN: RunStatus[] = ["completed", "failed", "cancelled"];
