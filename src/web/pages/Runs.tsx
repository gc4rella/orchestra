import { useEffect, useState } from "react";
import type { Run } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";
import { Connection, Empty, Loading, Notice } from "../components/UI.tsx";
import {
  activeRunTime,
  formatDuration,
  formatUsage,
  matchesFilter,
  projectName,
  type RunFilter,
} from "../model.ts";
export const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  awaiting_approval: "Needs approval",
  running: "In progress",
  completed: "Completed",
  paused: "Paused",
  pausing: "Pausing",
  failed: "Needs attention",
  cancelled: "Cancelled",
  pending: "Queued",
  done: "Done",
  blocked: "Blocked",
  superseded: "Replaced by revised plan",
};
export const Status = ({ status }: { status: string }) => (
  <span className={`status status-${status}`}>
    {STATUS_LABEL[status] ?? status}
  </span>
);
const filters: { id: RunFilter; label: string }[] = [
  { id: "all", label: "All runs" },
  { id: "attention", label: "Needs attention" },
  { id: "active", label: "Active" },
  { id: "finished", label: "Finished" },
];

/** "Continuous · cycle 3 · 42m 10s active · $1.20 · 300K tokens". */
function runFacts(r: Run) {
  const active = activeRunTime(r);
  return [
    r.continuous ? `Continuous · cycle ${r.cycle}` : r.autonomous ? "Autonomous" : "Supervised",
    active >= 1000 ? `${formatDuration(active)} active` : null,
    formatUsage(r),
  ].filter(Boolean).join(" · ");
}

export function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const load = async () => {
    try {
      setRuns(await api<Run[]>("/api/runs"));
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  const connection = useEvents(
    "runs",
    (ev) => {
      if (ev.type === "deleted") setRuns((prev) => prev?.filter((r) => r.id !== ev.runId) ?? prev);
      if (ev.type === "run")
        setRuns((prev) =>
          prev
            ? [ev.run, ...prev.filter((r) => r.id !== ev.run.id)].sort(
                (a, b) => b.createdAt - a.createdAt,
              )
            : prev,
        );
    },
    load,
  );
  const visible = runs?.filter(
    (r) =>
      matchesFilter(r, filter) &&
      `${r.prompt} ${r.workdir}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="page">
      <div className="page-head">
        <h1>Runs</h1>
        <Connection state={connection} />
      </div>
      {error && <Notice retry={load}>{error}</Notice>}
      {!runs && !error && <Loading label="Loading runs" />}
      {runs?.length === 0 && (
        <Empty
          title="No runs yet"
          action={
            <a className="button primary" href="#/">
              Start a run
            </a>
          }
        >
          Describe what you want built, and your team’s Director will plan it.
        </Empty>
      )}
      {!!runs?.length && (
        <>
          <div className="list-toolbar">
            <div className="filter-tabs" aria-label="Filter runs">
              {filters.map((f) => (
                <button
                  key={f.id}
                  aria-pressed={filter === f.id}
                  onClick={() => setFilter(f.id)}
                >
                  {f.label}
                  <span>
                    {runs.filter((r) => matchesFilter(r, f.id)).length}
                  </span>
                </button>
              ))}
            </div>
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input
                aria-label="Search runs"
                type="search"
                placeholder="Search runs or projects…"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
              />
            </label>
          </div>
          <ul className="run-list">
            {visible?.map((r) => (
              <li key={r.id}>
                <a className="run-row" href={`#/runs/${r.id}`}>
                  <span className="project-icon" aria-hidden="true">
                    {projectName(r.workdir).slice(0, 1).toUpperCase()}
                  </span>
                  <div className="run-row-content">
                    <span className="run-project" title={r.workdir}>
                      {projectName(r.workdir)}
                      <span> / {timeAgo(r.createdAt)}</span>
                    </span>
                    <h2>{r.prompt.split("\n")[0]}</h2>
                    <span className="run-path mono" title={r.workdir}>
                      {r.workdir}
                    </span>
                    <span className="run-facts">{runFacts(r)}</span>
                  </div>
                  <div className="run-row-end">
                    <Status status={r.status} />
                    <span className="row-action">
                      {r.status === "awaiting_approval"
                        ? "Review plan"
                        : r.status === "failed"
                          ? "Resolve issue"
                          : r.status === "paused"
                            ? "Resume or extend"
                          : r.status === "completed"
                            ? "Review work"
                            : "Open run"}{" "}
                      <span aria-hidden="true">↗</span>
                    </span>
                  </div>
                </a>
              </li>
            ))}
          </ul>
          {visible?.length === 0 && (
            <Empty
              title="No runs match"
              action={
                <button
                  className="button"
                  onClick={() => {
                    setSearch("");
                    setFilter("all");
                  }}
                >
                  Clear filters
                </button>
              }
            >
              Try another search or view all runs.
            </Empty>
          )}
        </>
      )}
    </section>
  );
}
