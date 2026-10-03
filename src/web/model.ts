import type { Agent, LogEntry, Run } from "../shared/types.ts";
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
