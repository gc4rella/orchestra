import type { LogEntry, Plan, Run, Task, TaskPhase, Team, WorkspaceCheck } from "../shared/types.ts";
export type RunFilter = "all" | "attention" | "active" | "finished";
export function matchesFilter(run: Run, filter: RunFilter) {
  return (
    filter === "all" ||
    (filter === "attention"
      ? ["awaiting_approval", "failed", "paused"].includes(run.status)
      : filter === "active"
        ? ["planning", "running", "pausing"].includes(run.status)
        : ["completed", "cancelled"].includes(run.status))
  );
}
export const projectName = (path: string) =>
  path.split(/[\\/]/).filter(Boolean).at(-1) || path;
export const shellQuote = (value: string) =>
  `'${value.replaceAll("'", "'\\''")}'`;
export function mergeLogs(
  fetched: LogEntry[],
  live: LogEntry[],
  stream: string | null,
) {
  const entries = new Map<number, LogEntry>();
  for (const entry of [...fetched, ...live])
    if (entry.taskId === stream) entries.set(entry.id, entry);
  return [...entries.values()].sort((a, b) => a.id - b.id);
}
/**
 * Groups plan tasks into steps: a task's step is one after its latest dependency in the plan, so
 * the tasks within a step don't depend on each other and can run in parallel. Dependencies outside
 * the plan (finished definition work) count as met. Plan order is kept within a step.
 */
export function planSteps<T extends { id: string; dependsOn: string[] }>(tasks: T[]): T[][] {
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const depth = new Map<string, number>();
  const level = (t: T, path: Set<string>): number => {
    const known = depth.get(t.id);
    if (known !== undefined) return known;
    if (path.has(t.id)) return 0; // cycles are rejected server-side; don't loop on bad data
    path.add(t.id);
    const deps = t.dependsOn.flatMap((d) => (byId.has(d) ? [level(byId.get(d)!, path)] : []));
    const d = deps.length ? Math.max(...deps) + 1 : 0;
    depth.set(t.id, d);
    return d;
  };
  const steps: T[][] = [];
  for (const t of tasks) (steps[level(t, new Set())] ??= []).push(t);
  return steps.filter(Boolean);
}
/** Distinct project folders of past runs, most recent first. */
export function recentProjects(runs: Run[], limit = 5) {
  const seen = new Set<string>();
  for (const r of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
    seen.add(r.workdir);
    if (seen.size === limit) break;
  }
  return [...seen];
}
/**
 * The team a new run in `workdir` starts with: the one the project last used, else the one used last anywhere,
 * else the first team. Teams that no longer exist are skipped.
 */
export function defaultTeamId(teams: Pick<Team, "id">[], runs: Pick<Run, "teamId" | "workdir" | "createdAt">[], workdir: string) {
  const exists = (id: string | null): id is string => teams.some((t) => t.id === id);
  const latest = [...runs].sort((a, b) => b.createdAt - a.createdAt);
  return latest.find((r) => r.workdir === workdir && exists(r.teamId))?.teamId
    ?? latest.find((r) => exists(r.teamId))?.teamId
    ?? teams[0]?.id
    ?? null;
}
/** Runs grouped by project folder: projects by their latest run, runs newest first. */
export function projectGroups(runs: Run[]) {
  const groups = new Map<string, Run[]>();
  for (const r of [...runs].sort((a, b) => b.createdAt - a.createdAt)) {
    const list = groups.get(r.workdir);
    if (list) list.push(r);
    else groups.set(r.workdir, [r]);
  }
  return [...groups].map(([workdir, runs]) => ({ workdir, runs }));
}
/** One-line explanation of what a run will do with the chosen folder. */
export function describeWorkspace(check: WorkspaceCheck): { tone: "info" | "ok" | "warn" | "bad"; text: string } {
  switch (check.kind) {
    case "new":
      return { tone: "info", text: "New folder. Orchestra creates it and starts a git repository." };
    case "empty":
      return { tone: "info", text: "Empty folder. It becomes a new git repository." };
    case "invalid":
      return { tone: "bad", text: check.reason };
    case "repo": {
      const on = `Git repository on ${check.branch ?? "a detached HEAD"}.`;
      return check.dirty
        ? {
            tone: "warn",
            text: `${on} ${check.dirty} uncommitted change${check.dirty === 1 ? "" : "s"} won't be included; commit first to include them.`,
          }
        : { tone: "ok", text: `${on} Work starts from its latest commit.` };
    }
  }
}
/** Whether some team can take a run: a Director with at least one member to staff. */
export function teamReady(teams: Pick<Team, "directorId" | "memberIds">[]) {
  return teams.some((t) => t.memberIds.some((id) => id !== t.directorId));
}
export function readStorage(key: string, session = false) {
  try {
    return (session ? sessionStorage : localStorage).getItem(key);
  } catch {
    return null;
  }
}
export function writeStorage(
  key: string,
  value: string | null,
  session = false,
) {
  try {
    const storage = session ? sessionStorage : localStorage;
    if (value === null) storage.removeItem(key);
    else storage.setItem(key, value);
  } catch {
    /* Storage can be disabled. The UI remains usable. */
  }
}
export type RunDraft = { prompt: string; workdir: string; nonGoals: string };
export function readDraft(): RunDraft {
  try {
    const d = JSON.parse(readStorage("orchestra.run-draft", true) || "{}");
    const text = (v: unknown) => (typeof v === "string" ? v : "");
    return { prompt: text(d.prompt), workdir: text(d.workdir), nonGoals: text(d.nonGoals) };
  } catch {
    return { prompt: "", workdir: "", nonGoals: "" };
  }
}
/** The brief the Director reads: non-goals go last, where the Director and continuous mode look for them. */
export function composeBrief(draft: Pick<RunDraft, "prompt" | "nonGoals">) {
  const nonGoals = draft.nonGoals.trim();
  return nonGoals ? `${draft.prompt.trim()}\n\nNon-goals:\n${nonGoals}` : draft.prompt.trim();
}

/** "45s", "3m 05s", "1h 12m". */
export function formatDuration(ms: number) {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, "0")}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, "0")}m`;
}

const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });

/** "$1.23 · 450K tokens"; cost is left out when no CLI reported one (Codex reports tokens only). Null before any usage. */
export function formatUsage(u: { costUsd: number; tokens: number }) {
  if (!u.tokens && !u.costUsd) return null;
  const tokens = `${compact.format(u.tokens)} tokens`;
  return u.costUsd ? `$${u.costUsd.toFixed(2)} · ${tokens}` : tokens;
}

/** What the plan awaiting approval is for, from the tasks the run already has. */
export function planLabel(plan: Plan, tasks: Task[], fixRounds: number) {
  if (tasks.some((t) => t.status === "failed" || t.status === "blocked")) return "Recovery plan";
  if (plan.stage === "fix") return `Verification · fix round ${fixRounds + 1}`;
  if (plan.stage === "definition") return "Stage 1 of 2 · Definition";
  return tasks.length ? "Stage 2 of 2 · Build" : "Build plan";
}

export type DiffRow =
  | { kind: "hunk"; text: string }
  | { kind: "add" | "del" | "ctx"; text: string; oldLine: number | null; newLine: number | null };

/** Unified-diff hunks as rows with old and new line numbers. */
export function diffRows(patch: string): DiffRow[] {
  const rows: DiffRow[] = [];
  let oldLine = 0;
  let newLine = 0;
  for (const line of patch.split("\n")) {
    const hunk = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      rows.push({ kind: "hunk", text: line });
    } else if (line.startsWith("+")) {
      rows.push({ kind: "add", text: line.slice(1), oldLine: null, newLine: newLine++ });
    } else if (line.startsWith("-")) {
      rows.push({ kind: "del", text: line.slice(1), oldLine: oldLine++, newLine: null });
    } else if (line.startsWith(" ")) {
      rows.push({ kind: "ctx", text: line.slice(1), oldLine: oldLine++, newLine: newLine++ });
    }
    // "\ No newline at end of file" and empty trailing lines carry no content.
  }
  return rows;
}

export function activeRunTime(run: Pick<Run, "activeElapsedMs" | "activeSince">, now = Date.now()) {
  return run.activeElapsedMs + (run.activeSince === null ? 0 : Math.max(0, now - run.activeSince));
}

export type NextAction = {
  tone: "info" | "ok" | "warn" | "bad";
  title: string;
  detail: string;
  /** The control the action button leads to; null when nothing is needed from the user. */
  target: "plan" | "resume" | "retry" | "replan" | "changes" | null;
  label: string;
};

/** What the run needs from the user right now, if anything. */
export function nextAction(run: Run, tasks: Task[]): NextAction {
  const failed = tasks.filter((t) => t.status === "failed").length;
  const needRetry: NextAction = {
    tone: run.status === "failed" ? "bad" : "warn",
    title: `${failed} task${failed === 1 ? "" : "s"} failed`,
    detail: "Retry with instructions or another assignee, or ask the Director to re-plan the remaining work.",
    target: "retry",
    label: "Go to the failed task",
  };
  switch (run.status) {
    case "planning":
      return { tone: "info", title: "The Director is planning", detail: "Shaping the work and choosing the right teammate for each task.", target: null, label: "" };
    case "awaiting_approval":
      return { tone: "warn", title: "A plan is ready for your review", detail: "Read it, adjust it or ask for changes, then approve it to start the team.", target: "plan", label: "Review the plan" };
    case "running": {
      if (failed && !run.autonomous) return needRetry;
      const live = tasks.filter((t) => t.status !== "superseded");
      const running = live.filter((t) => t.status === "running").length;
      const done = live.filter((t) => t.status === "done").length;
      return { tone: "info", title: "Your team is working", detail: `${running} running · ${done} of ${live.length} done. Each task is checked before it merges.`, target: null, label: "" };
    }
    case "pausing":
      return { tone: "info", title: "Saving a checkpoint", detail: "Current operations are settling; the team preserves its work before pausing.", target: null, label: "" };
    case "paused":
      return { tone: "warn", title: `Paused: ${run.pauseReason ?? "waiting for you"}`, detail: "Work, handoffs and sessions are preserved. Add guidance or extend the budget, then resume.", target: "resume", label: "Resume options" };
    case "failed":
      if (run.pauseReason === "Interrupted by server restart")
        return { tone: "warn", title: "Interrupted by a server restart", detail: "Checkpoints are preserved. Resume to continue where the team stopped.", target: "resume", label: "Resume options" };
      if (failed) return needRetry;
      return { tone: "bad", title: "The Director couldn’t finish planning", detail: "Check the error above, then ask the Director to try again.", target: "replan", label: "Ask the Director" };
    case "completed":
      return { tone: "ok", title: "Ready for your review", detail: `All work is merged into ${run.branch}. Read the report, review the changes, then merge it yourself.`, target: "changes", label: "Review the changes" };
    case "cancelled":
      return { tone: "info", title: "This run was stopped", detail: "Tasks, summaries and output remain available below.", target: null, label: "" };
  }
}

const STEP_LABEL: Record<Exclude<TaskPhase, "done">, string> = { work: "Work", commit: "Commit", check: "Check", review: "Review", merge: "Merge" };

/** A task's pass through Work → Commit → Check → Review → Merge; Check and Review only when they apply. */
export function taskSteps(task: Pick<Task, "phase" | "status" | "reviewerId">, hasVerify: boolean) {
  const phases = (Object.keys(STEP_LABEL) as (keyof typeof STEP_LABEL)[]).filter(
    (p) => (p !== "check" || hasVerify) && (p !== "review" || !!task.reviewerId),
  );
  const at = task.status === "done" || task.phase === "done" ? phases.length : task.status === "pending" ? -1 : Math.max(0, phases.indexOf(task.phase));
  return phases.map((phase, i) => ({
    phase,
    label: STEP_LABEL[phase],
    state: (i < at ? "done" : i === at ? "current" : "todo") as "done" | "current" | "todo",
  }));
}

const lastLine = (text: string) => text.trim().split("\n").map((l) => l.trim()).filter(Boolean).at(-1) ?? "";
const firstLine = (text: string) => text.trim().split("\n").map((l) => l.trim()).find(Boolean) ?? "";

/** Why the latest pass went back to the agent, from the recorded check and review evidence. */
export function bounceReason(task: Pick<Task, "handoff">) {
  const { check, review } = task.handoff ?? {};
  if (check && !check.ok) return `Check failed: ${lastLine(check.output) || check.command}`;
  if (review?.verdict === "changes") return `Review asked for changes: ${firstLine(review.findings) || "see findings"}`;
  return null;
}

/** Plain-language cause and next step for the errors agents and Orchestra commonly report. */
export function explainError(text: string): { cause: string; next: string } | null {
  // Orchestra's own failures come first: their text embeds check output, which may mention anything.
  const rules: [RegExp, string, string][] = [
    [/interrupted by server restart/i, "Orchestra restarted while this work was in progress.", "Resume the run; finished phases are kept."],
    [/could not resolve merge conflict/i, "This task’s changes overlapped with work merged in parallel.", "Retry the task to rebuild it on the latest branch, or ask the Director to re-plan."],
    [/command not found|^sh: .*: not found$/im, "The verify command needs a tool that isn’t installed.", "Install the tool, or edit the plan’s verify command, then retry."],
    [/still failing after/i, "Checks or review kept finding problems.", "Read the latest check output and review, then retry with instructions or another assignee."],
    [/timed out after|no answer within/i, "The agent ran out of time.", "Retry with narrower instructions, or ask the Director to split the task."],
    [/not logged in|\/login|login required|authenticat|unauthori[sz]ed|\b401\b|api key/i,
      "The agent’s CLI isn’t signed in.", "Run `claude` (then /login) or `codex login` in a terminal, test the agent on the Team page, then retry."],
    [/exited with code/i, "The agent’s CLI stopped with an error.", "Open the task output for details, test the agent on the Team page, then retry."],
  ];
  const hit = rules.find(([pattern]) => pattern.test(text));
  return hit ? { cause: hit[1], next: hit[2] } : null;
}

export type LogItem = { kind: "entry"; entry: LogEntry } | { kind: "tools"; entries: LogEntry[] };

/** Collapses runs of `min` or more consecutive tool calls, so an agent's messages stay readable between them. */
export function groupLogs(entries: LogEntry[], min = 3): LogItem[] {
  const items: LogItem[] = [];
  let run: LogEntry[] = [];
  const flush = () => {
    if (run.length >= min) items.push({ kind: "tools", entries: run });
    else items.push(...run.map((entry) => ({ kind: "entry" as const, entry })));
    run = [];
  };
  for (const entry of entries) {
    if (entry.kind === "tool") run.push(entry);
    else {
      flush();
      items.push({ kind: "entry", entry });
    }
  }
  flush();
  return items;
}

/** Plain-text log for download: one "HH:MM:SS kind text" line per entry. */
export const logText = (entries: LogEntry[]) =>
  entries.map((e) => `${new Date(e.ts).toLocaleTimeString([], { hour12: false })} ${e.kind.padEnd(6)} ${e.text}`).join("\n") + "\n";

/** Fewest agent calls a plan can take: one per task, one per review, and the Director's verification. Retries add more. */
export const minimumCalls = (plan: Pick<Plan, "tasks">) =>
  plan.tasks.length + plan.tasks.filter((t) => t.reviewerId).length + 1;
