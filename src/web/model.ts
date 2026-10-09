import type { Agent, LogEntry, Plan, Run, Task, WorkspaceCheck } from "../shared/types.ts";
import { isDirector } from "../shared/types.ts";
export type RunFilter = "all" | "attention" | "active" | "finished";
export function matchesFilter(run: Run, filter: RunFilter) {
  return (
    filter === "all" ||
    (filter === "attention"
      ? ["awaiting_approval", "failed"].includes(run.status)
      : filter === "active"
        ? ["planning", "running"].includes(run.status)
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
export function teamReady(agents: Agent[]) {
  return agents.some(isDirector) && agents.some((a) => !isDirector(a));
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
export function readDraft(): { prompt: string; workdir: string } {
  try {
    const d = JSON.parse(readStorage("orchestra.run-draft", true) || "{}");
    return {
      prompt: typeof d.prompt === "string" ? d.prompt : "",
      workdir: typeof d.workdir === "string" ? d.workdir : "",
    };
  } catch {
    return { prompt: "", workdir: "" };
  }
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
