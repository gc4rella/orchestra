export const RUNTIMES = ["claude-code", "codex"] as const;
export type Runtime = (typeof RUNTIMES)[number];
/** Reasoning effort levels each CLI accepts: `claude --effort`, Codex's `model_reasoning_effort`. */
export const EFFORTS: Record<Runtime, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export type Agent = {
  id: string;
  name: string;
  runtime: Runtime;
  model: string | null;
  /** One of `EFFORTS[runtime]`; null leaves it to the CLI. */
  effort: string | null;
  role: string;
  /** What the agent is especially good at, in plain words; the Director staffs by it. */
  expertise: string;
  /** Marketplace skills from Orchestra's skill library, read by the agent when one applies. */
  skills: Skill[];
  instructions: string | null;
  createdAt: number;
};

/** A skills.sh skill, `id` being `owner/repo/skill`; name and description come from its SKILL.md. */
export type Skill = { id: string; name: string; description: string };
/** A skills.sh search result. */
export type SkillListing = { id: string; name: string; installs: number };

/** The role for agents hired to direct: a team's Director plans and staffs its runs, the members do the work. */
export const DIRECTOR_ROLE = "Director (product & engineering)";
export const isDirector = (a: Pick<Agent, "role">) => a.role.trim().toLowerCase() === DIRECTOR_ROLE.toLowerCase();

/** A selection from the hired agents: one Director plus the members it staffs. `memberIds` excludes the Director. */
export type Team = { id: string; name: string; directorId: string; memberIds: string[]; createdAt: number };

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

/** An agent's track record across runs. Cost and tokens include the reviews of its tasks. */
export type AgentStats = { done: number; failed: number; firstTry: number; avgAttempts: number | null; costUsd: number; tokens: number; reviews: number };

/** What a CLI uses when an agent leaves model or effort empty, read from the CLI's user config; null when unknown. */
export type CliDefaults = { model: string | null; effort: string | null };
export type RuntimeInfo = { runtime: Runtime; installed: boolean; version: string | null; defaults: CliDefaults };
/** Result of one tiny read-only call that shows whether an agent's CLI is signed in. */
export type ProbeResult = { ok: boolean; ms: number; error: string | null; usage: Usage | null };

export type RunStatus = "planning" | "awaiting_approval" | "running" | "completed" | "failed" | "cancelled" | "pausing" | "paused";
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
/**
 * `verify` is a shell command that checks the work (install, test, build); "" for none.
 * `lessons` are lines the Director proposes for the project memory when it accepts a build; "" otherwise.
 */
export type Plan = { summary: string; stage: PlanStage; verify: string; lessons: string; tasks: PlanTask[] };
/** Cap of a project's memory, which every agent prompt of the project's runs carries. */
export const MAX_MEMORY = 8000;
/** Pause reason when an autonomous run's plan brings a verify command the user hasn't typed or approved for the project. */
export const VERIFY_APPROVAL_PAUSE = "New verify command needs your OK";
/** Trusted verify commands kept per project; the oldest drop off first. */
export const MAX_TRUSTED_CHECKS = 50;

export type RunLimits = { maxDurationMs: number; maxAgentCalls: number };
export const DEFAULT_RUN_LIMITS: RunLimits = { maxDurationMs: 2 * 60 * 60_000, maxAgentCalls: 40 };
/** How a run works: tasks at once, and how long one agent call or one verify run may take. */
export type RunPacing = { maxParallel: number; agentTimeoutMs: number; checkTimeoutMs: number };
export const DEFAULT_PACING: RunPacing = { maxParallel: 3, agentTimeoutMs: 45 * 60_000, checkTimeoutMs: 15 * 60_000 };
export const PACING_BOUNDS = {
  maxParallel: { min: 1, max: 8 },
  agentTimeoutMinutes: { min: 5, max: 240 },
  checkTimeoutMinutes: { min: 1, max: 120 },
} as const;
export type PlanningPurpose = "initial" | "build" | "recover" | "fix" | "improve";
export type CheckEvidence = { command: string; ok: boolean; output: string };
export type RunHistory = { cycle: number; createdAt: number; plan: Plan | null; report: string | null };
export type RunControl = {
  continuous: boolean;
  /** The user's own command for checking the project; the Director uses it as `verify` unless it doesn't fit. */
  checkCommand: string;
  limits: RunLimits | null;
  pacing: RunPacing;
  agentCalls: number;
  activeElapsedMs: number;
  activeSince: number | null;
  cycle: number;
  checkpoint: "plan" | "approve" | "execute";
  purpose: PlanningPurpose | null;
  planningPhase: "check" | "director";
  check: CheckEvidence | null;
  guidance: string;
  pauseReason: string | null;
  history: RunHistory[];
};
export const defaultRunControl = (): RunControl => ({
  continuous: false, checkCommand: "", limits: null, pacing: { ...DEFAULT_PACING }, agentCalls: 0, activeElapsedMs: 0, activeSince: null,
  cycle: 1, checkpoint: "plan", purpose: null, planningPhase: "check", check: null,
  guidance: "", pauseReason: null, history: [],
});
export type TaskPhase = "work" | "commit" | "check" | "review" | "merge" | "done";
export type Handoff = {
  text: string;
  files: string[];
  check: CheckEvidence | null;
  review: { verdict: "approve" | "changes"; findings: string } | null;
};
export type TaskCheckpoint = { phase: TaskPhase; cycle: number; startCommit: string | null; handoff: Handoff | null };
export const defaultTaskCheckpoint = (): TaskCheckpoint => ({ phase: "work", cycle: 1, startCommit: null, handoff: null });

export type Run = RunControl & {
  id: string;
  prompt: string;
  workdir: string;
  /** The team the run staffs from; its Director is fixed for the run as `directorAgentId`. */
  teamId: string | null;
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

export type Task = TaskCheckpoint & {
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
  | { type: "log"; log: LogEntry }
  | { type: "deleted"; runId: string };

export const FINISHED_RUN: RunStatus[] = ["completed", "failed", "cancelled"];
