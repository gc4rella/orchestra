import type { Agent, LogEntry, Run, WorkspaceCheck } from "../shared/types.ts";
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
