export const RUNTIMES = ["claude-code", "codex"] as const;
export type Runtime = (typeof RUNTIMES)[number];
/** Reasoning effort levels each CLI accepts: `claude --effort`, Codex's `model_reasoning_effort`. */
export const EFFORTS: Record<Runtime, readonly string[]> = {
  "claude-code": ["low", "medium", "high", "xhigh", "max"],
  codex: ["minimal", "low", "medium", "high", "xhigh"],
};

export type RateLimitPolicy = { maxUsedPercent: number; window: "5h" | "weekly" | "both" };
export type QuotaWindow = { window: "5h" | "weekly"; usedPercent: number; resetsAt: number };
export type QuotaWait = { agentId: string; window: QuotaWindow["window"]; attempts: number };
export type CapacityLimit = { agentId: string; runtime: Runtime; reason: string; rerouted: boolean };
export type CapacityAssignment = { taskId: string; key: string; title: string; kind: "worker" | "reviewer"; fromAgentId: string; fromAgentName: string; candidateIds: string[] };
export type CapacityTransfer = Pick<CapacityAssignment, "taskId" | "kind" | "fromAgentId"> & { agentId: string };
export type CapacityProposal = {
  limits: CapacityLimit[];
  agents: { id: string; name: string; role: string; runtime: Runtime; windows: QuotaWindow[]; ceiling: number }[];
  assignments: CapacityAssignment[];
  directorBlocked: boolean;
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
  rateLimitPolicy?: RateLimitPolicy | null;
  createdAt: number;
};

/** A skills.sh skill, `id` being `owner/repo/skill`; name and description come from its SKILL.md. */
export type SkillCompatibility = {
  status: "instructions" | "resources" | "integration-required";
  notices: string[];
  requiredTools: string[];
  profile?: "standard" | "superpowers" | "ecc";
  missingResources?: string[];
  omittedIntegrations?: string[];
};
export type Skill = {
  id: string; name: string; description: string; revision?: string | null; compatibility?: SkillCompatibility;
  provenance?: { repository: string; revision: string; installedAt: number; files: string[] };
};
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

/** Usage belongs to the invoking agent; incomplete legacy attempts and reporting are flagged. */
export type AgentStats = { done: number; failed: number; firstTry: number; avgAttempts: number | null; costUsd: number; tokens: number; reviews: number; usageIncomplete?: boolean; attemptsIncomplete?: boolean };

/** What a CLI uses when an agent leaves model or effort empty, read from the CLI's user config; null when unknown. */
export type CliDefaults = { model: string | null; effort: string | null };
export type RuntimeCapabilities = {
  transport: "batch" | "app-server";
  structuredOutput: boolean;
  resume: boolean;
  steering: boolean;
  childEvents: boolean;
  delegationControl: boolean;
  accounting: "invocation" | "descendants";
};
export type RuntimeEnvironment = {
  sources: { kind: "settings" | "hooks" | "skills" | "agents" | "plugins" | "memory"; scope: "user" | "project"; path: string; count: number }[];
  notices: string[];
};
export type RuntimeInfo = { runtime: Runtime; installed: boolean; version: string | null; defaults: CliDefaults; capabilities?: RuntimeCapabilities; environment?: RuntimeEnvironment };
export type AgentEvent = {
  id: string;
  runId: string;
  taskId: string | null;
  invocationId: string;
  parentId: string | null;
  agentId: string;
  kind: "started" | "completed" | "failed" | "child-started" | "child-completed" | "steering";
  text: string;
  ts: number;
  manifest?: RuntimeManifest;
};
export type RuntimeManifest = { runtime: Runtime; version: string | null; model: string | null; effort: string | null; transport: "batch" | "app-server"; skills: { id: string; revision: string | null }[]; environment: RuntimeEnvironment };

export type AuditAgent = Pick<Agent, "id" | "name" | "role" | "runtime" | "model" | "effort">;
export type AuditSkill = { id: string; revision: string | null };
type AuditBase = { id: string; runId: string; taskId: string | null; ts: number };
type TaskAuditState = { taskId: string; agentId: string; attempt: number; phase: TaskPhase; status: TaskStatus; commit: string | null };
export type AuditRecord = AuditBase & (
  | { kind: "invocation-started"; invocationId: string; agent: AuditAgent; purpose: string; phase: TaskPhase | null; attempt: number | null; inputCommit: string | null; promptDigest: string; guidanceDigest: string; manifest: RuntimeManifest; registeredSkills: AuditSkill[]; selectedSkills: AuditSkill[]; selectionReason?: string; queuedAt?: number; slotAcquiredAt?: number }
  | { kind: "invocation-finished"; invocationId: string; status: "completed" | "failed" | "interrupted"; usage: Usage | null; error: string | null; skillClaims?: string[] }
  | (TaskAuditState & { kind: "task-attempt" })
  | (TaskAuditState & { kind: "task-phase" })
  | (TaskAuditState & { kind: "task-assignment"; previousAgentId: string | null; reason: string })
  | { kind: "task-review"; taskId: string; agentId: string; reviewerId: string; attempt: number; phase: TaskPhase; commit: string | null; verdict: "approve" | "changes"; findings: string }
);
export type AuditInput<T = AuditRecord> = T extends AuditRecord ? Omit<T, "id" | "ts"> & { id?: string; ts?: number } : never;

export const DELIVERY_PROFILES = ["balanced", "quality", "speed", "economy"] as const;
export type DeliveryProfile = (typeof DELIVERY_PROFILES)[number];
export type ExecutionStrategy = "auto" | "single" | "native" | "team";
export type DeliveryPolicy = { profile: DeliveryProfile; strategy: ExecutionStrategy; maxParallel: number };
export const defaultDeliveryPolicy = (profile: DeliveryProfile = "balanced"): DeliveryPolicy => ({
  profile, strategy: "auto", maxParallel: profile === "economy" ? 1 : profile === "quality" ? 2 : profile === "speed" ? 6 : 3,
});
export type RequirementSpec = {
  id: string;
  title: string;
  description: string;
  kind: "command" | "review";
  check: string;
  required: boolean;
  inputs: string[];
  artifacts: string[];
};
export type Requirement = RequirementSpec & { version: number; updatedAt: number };
export type TaskContract = { requirementIds: string[]; inputs: string[]; outputs: string[]; resources: string[]; skillIds?: string[]; ui?: boolean };
export const defaultTaskContract = (): TaskContract => ({ requirementIds: [], inputs: [], outputs: [], resources: [] });
export type Evidence = {
  id: string;
  runId: string;
  taskId: string | null;
  requirementIds: string[];
  requirementVersions: Record<string, number>;
  commit: string;
  scope: "task" | "integration" | "acceptance" | "diagnosis";
  producer: string;
  command: string;
  status: "passed" | "failed" | "unverified";
  output: string;
  durationMs: number;
  artifacts: string[];
  createdAt: number;
};
export type StrategyRecommendation = { strategy: Exclude<ExecutionStrategy, "auto">; reason: string; samples: number };
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
  contract?: TaskContract;
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
export type Plan = { version?: 2; requirements?: RequirementSpec[]; summary: string; stage: PlanStage; verify: string; lessons: string; tasks: PlanTask[] };
/** Cap of a project's memory, which every agent prompt of the project's runs carries. */
export const MAX_MEMORY = 8000;

export type RunLimits = { maxDurationMs: number; maxAgentCalls: number };
export const DEFAULT_RUN_LIMITS: RunLimits = { maxDurationMs: 2 * 60 * 60_000, maxAgentCalls: 40 };
export type RunTimeouts = { agentMs: number; checkMs: number };
export const DEFAULT_RUN_TIMEOUTS: RunTimeouts = { agentMs: 45 * 60_000, checkMs: 15 * 60_000 };
export const RUN_TIMEOUT_BOUNDS = { agentMinutes: { min: 5, max: 240 }, checkMinutes: { min: 1, max: 120 } } as const;
export type MergeCheck = {
  sourceCommit: string;
  targetBranch: string | null;
  targetCommit: string | null;
  status: "clean" | "conflicted" | "unsupported";
  conflicts: string[];
  message: string | null;
};
export type PlanningPurpose = "initial" | "build" | "recover" | "fix" | "improve";
export type CheckEvidence = { command: string; ok: boolean; output: string; commit?: string; producer?: string; durationMs?: number };
export type RunHistory = { cycle: number; createdAt: number; plan: Plan | null; report: string | null };
export type PreviewConfig = { enabled: boolean; command: string };
export type PreviewState = {
  status: "stopped" | "waiting" | "starting" | "ready" | "failed";
  url: string | null;
  commit: string | null;
  draft?: boolean;
  updatedAt: number | null;
  message: string;
  output: string;
};
export type RunMilestone = { at: number; elapsedMs: number; commit: string | null; draft?: boolean };
export type RunControl = {
  configuration: string;
  delivery: DeliveryPolicy;
  requirements: Requirement[];
  acceptedCommit: string | null;
  firstRunnable: RunMilestone | null;
  firstAccepted: RunMilestone | null;
  recommendation: StrategyRecommendation | null;
  preview: PreviewConfig;
  rateLimitPolicy: RateLimitPolicy | null;
  quotaWait: QuotaWait | null;
  capacityLimits: CapacityLimit[];
  autoContinueOnRateLimit: boolean;
  rateLimitResumeAt: number | null;
  rateLimitRetries: number;
  continuous: boolean;
  /** The user's own command for checking the project; the Director uses it as `verify` unless it doesn't fit. */
  checkCommand: string;
  limits: RunLimits | null;
  timeouts: RunTimeouts;
  agentCalls: number;
  /** Explicit side-chat requests have a one-call budget each, separate from autonomous work. */
  chatCalls: number;
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
  configuration: "",
  delivery: defaultDeliveryPolicy(), requirements: [], acceptedCommit: null, firstRunnable: null, firstAccepted: null, recommendation: null,
  preview: { enabled: false, command: "" },
  rateLimitPolicy: null, quotaWait: null, capacityLimits: [],
  autoContinueOnRateLimit: false, rateLimitResumeAt: null, rateLimitRetries: 0,
  continuous: false, checkCommand: "", limits: null, timeouts: { ...DEFAULT_RUN_TIMEOUTS }, agentCalls: 0, chatCalls: 0, activeElapsedMs: 0, activeSince: null,
  cycle: 1, checkpoint: "plan", purpose: null, planningPhase: "check", check: null,
  guidance: "", pauseReason: null, history: [],
});
export type TaskPhase = "work" | "commit" | "check" | "review" | "merge" | "done";
export type Handoff = {
  text: string;
  details?: { decisions: string[]; interfaces: string[]; blockers: string[]; verified: string[]; skillIds: string[] };
  files: string[];
  check: CheckEvidence | null;
  review: { verdict: "approve" | "changes"; findings: string } | null;
  integration?: {
    baselineCommit: string;
    candidateCommit: string;
    check: CheckEvidence | null;
    review: { verdict: "approve" | "changes"; findings: string } | null;
    conflictResolved: boolean;
  };
};
export type TaskCheckpoint = { phase: TaskPhase; cycle: number; attempt: number; startCommit: string | null; handoff: Handoff | null; contract: TaskContract; contextVersions: Record<string, string>; previousAgentIds: string[] };
export const defaultTaskCheckpoint = (): TaskCheckpoint => ({ phase: "work", cycle: 1, attempt: 1, startCommit: null, handoff: null, contract: defaultTaskContract(), contextVersions: {}, previousAgentIds: [] });

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

export type Usage = { costUsd: number | null; tokens: number; tokensReported?: false };
/** A CLI conversation that can be resumed, with the usage it has accumulated so far. */
export type Session = { id: string; costUsd: number; tokens: number; usageUnknown?: { tokens?: true; cost?: true } };

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

/** Values are returned only by the explicit reveal endpoint. */
export type Secret = {
  name: string;
  environment: boolean;
  source: "saved" | "preview";
  commit: string | null;
  updatedAt: number;
};

export type DirectorChatTurn = {
  id: number;
  runId: string;
  text: string;
  reply: string;
  status: "pending" | "completed" | "failed";
  error: string | null;
  createdAt: number;
};

export type ServerEvent =
  | { type: "audit"; runId: string; record: AuditRecord }
  | { type: "director-chat"; runId: string; turn: DirectorChatTurn }
  | { type: "evidence"; runId: string; evidence: Evidence }
  | { type: "agent-event"; runId: string; event: AgentEvent }
  | { type: "preview"; runId: string; preview: PreviewState }
  | { type: "run"; run: Run }
  | { type: "task"; task: Task }
  | { type: "log"; log: LogEntry }
  | { type: "deleted"; runId: string };

export const FINISHED_RUN: RunStatus[] = ["completed", "failed", "cancelled"];
