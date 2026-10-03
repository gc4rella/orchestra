import { useEffect, useState } from "react";
import type { Run } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";

export const STATUS_LABEL: Record<string, string> = {
  planning: "Planning",
  awaiting_approval: "Awaiting approval",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Cancelled",
  pending: "Pending",
  done: "Done",
  blocked: "Blocked",
};

export const Status = ({ status }: { status: string }) => (
  <span className={`status status-${status}`}>{STATUS_LABEL[status] ?? status}</span>
);

export function Runs() {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const load = () => api<Run[]>("/api/runs").then(setRuns).catch((e) => setError(e.message));

  useEffect(() => {
    load();
  }, []);
  useEvents(
    "runs",
    (ev) => {
      if (ev.type !== "run") return;
      setRuns((prev) => {
        if (!prev) return prev;
        const rest = prev.filter((r) => r.id !== ev.run.id);
        return [ev.run, ...rest].sort((a, b) => b.createdAt - a.createdAt);
      });
    },
    load,
  );

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Runs</h1>
          <p className="lede">Each run is one piece of work: the director writes the score, you approve it, the agents play it.</p>
        </div>
      </div>
      {error && <p className="alert error" role="alert">{error}</p>}
      {runs?.length === 0 && (
        <p className="empty">
          No runs yet. <a href="#/agents">Register your agents</a>, then <a href="#/runs/new">start a run</a>.
        </p>
      )}
      <ul className="run-list">
        {runs?.map((r) => (
          <li key={r.id}>
            <a className="card run-row" href={`#/runs/${r.id}`}>
              <span className="run-prompt">{r.prompt.split("\n")[0]}</span>
              <Status status={r.status} />
              <span className="muted small mono">{r.workdir}</span>
              <span className="muted small">{timeAgo(r.createdAt)}</span>
            </a>
          </li>
        ))}
      </ul>
    </section>
  );
}
