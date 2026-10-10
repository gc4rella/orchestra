import { DemoLauncher } from "../components/DemoLauncher.tsx";
import { useEffect, useState } from "react";
import type { Agent, Run } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";
import { Connection, Empty, Loading, Notice } from "../components/UI.tsx";
import {
  activeRunTime,
  formatDuration,
  formatUsage,
  matchesFilter,
  projectName,
  teamReady,
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
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  const [filter, setFilter] = useState<RunFilter>("all");
  const load = async () => {
    try {
      const [r, a] = await Promise.all([
        api<Run[]>("/api/runs"),
        api<Agent[]>("/api/agents"),
      ]);
      setRuns(r);
      setAgents(a);
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
  const ready = agents ? teamReady(agents) : false;
  const visible = runs?.filter(
    (r) =>
      matchesFilter(r, filter) &&
      `${r.prompt} ${r.workdir}`.toLowerCase().includes(search.toLowerCase()),
  );
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">The workspace</p>
          <h1>Make room for your next idea.</h1>
          <p className="lede">
            Give your team a direction. Follow the work from first plan to final
            review.
          </p>
        </div>
        <Connection state={connection} />
      </div>
      {error && <Notice retry={load}>{error}</Notice>}
      {!runs && !error && <Loading label="Loading runs" />}
      {agents && <DemoLauncher agents={agents} />}
      {runs?.length === 0 && (
        <div className="welcome-grid">
          <div className="welcome-main">
            <span className="overline">01 / Your next project</span>
            <h2>
              Big ideas.
              <br />
              <em>A team to build them.</em>
            </h2>
            <p>
              {ready
                ? "Your team is assembled. Describe what you have in mind, and your Director will turn it into a plan you can review."
                : "Start by assembling your team. Your Director will plan the work and bring in the right agents for each task."}
            </p>
            <a
              className="button primary"
              href={ready ? "#/runs/new" : "#/agents"}
            >
              {ready ? "Create your first run" : "Set up your team"}
              <span aria-hidden="true">↗</span>
            </a>
            <div className="welcome-foot">
              <span className="status-dot" />
              {ready
                ? `${agents!.length} agents on your team`
                : "Your workspace starts here"}
            </div>
          </div>
          <aside className="welcome-guide">
            <p className="eyebrow">From idea to done</p>
            {[
              [
                "01",
                "Set the direction",
                "Describe the outcome and choose your project.",
              ],
              [
                "02",
                "Make the plan yours",
                "Review tasks, assignments, and what done looks like.",
              ],
              [
                "03",
                "Watch it come together",
                "Follow your agents, then review their work on one branch.",
              ],
            ].map(([n, title, description]) => (
              <div className="guide-step" key={n}>
                <span>{n}</span>
                <div>
                  <h3>{title}</h3>
                  <p>{description}</p>
                </div>
              </div>
            ))}
            <div className="quiet-note">
              You approve the plan before the team starts building.
            </div>
          </aside>
        </div>
      )}
      {!!runs?.length && (
        <>
          <div className="stats-strip">
            <div>
              <span className="stat-number">
                {runs.filter((r) => matchesFilter(r, "active")).length}
              </span>
              <span>In motion</span>
            </div>
            <div>
              <span className="stat-number attention-number">
                {runs.filter((r) => matchesFilter(r, "attention")).length}
              </span>
              <span>Need your attention</span>
            </div>
            <div>
              <span className="stat-number">
                {runs.filter((r) => r.status === "completed").length}
              </span>
              <span>Completed</span>
            </div>
            <div className="stats-caption">
              One idea at a time.
              <br />A little more possible.
            </div>
          </div>
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
