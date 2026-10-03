import { useEffect, useState, type FormEvent } from "react";
import type { Agent, Run } from "../../shared/types.ts";
import { isDirector } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { RUNTIME_LABEL } from "./Agents.tsx";

export function NewRun() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [prompt, setPrompt] = useState("");
  const [workdir, setWorkdir] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api<Agent[]>("/api/agents").then(setAgents).catch((e) => setError(e.message));
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>("/api/runs", { body: { prompt, workdir } });
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const director = agents?.find(isDirector);
  const team = agents?.filter((a) => a !== director) ?? [];
  if (agents && (!director || team.length === 0)) {
    return (
      <section className="page narrow">
        <h1>New run</h1>
        <p className="empty">
          {director ? "The Director has no team to staff yet." : "Every run is planned by the team's Director, and you have none yet."}{" "}
          <a href="#/agents">Hire your team</a> first.
        </p>
      </section>
    );
  }

  return (
    <section className="page narrow">
      <h1>New run</h1>
      <p className="lede">Describe what to build. The Director plans the work and staffs it from your team; nothing runs until you approve the plan.</p>
      <form className="card form" onSubmit={submit}>
        <label>
          What should be built?
          <textarea
            required
            rows={7}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            placeholder="e.g. A REST API for a todo list with SQLite storage, a React frontend, and tests"
          />
        </label>
        <label>
          Project directory
          <span className="hint">
            Absolute path. An empty or missing folder becomes a new git repo; an existing repo is used from its current commit. Your checkout is never modified: work lands on a new <code>orchestra/…</code> branch.
          </span>
          <input required className="mono" value={workdir} onChange={(e) => setWorkdir(e.target.value)} placeholder="/Users/you/projects/my-app" />
        </label>
        {director && (
          <p className="muted small">
            Directed by <strong>{director.name}</strong> ({RUNTIME_LABEL[director.runtime]}{director.model ? ` · ${director.model}` : ""}), staffing from{" "}
            {team.length} team member{team.length === 1 ? "" : "s"}.
          </p>
        )}
        {error && <p className="alert error" role="alert">{error}</p>}
        <div className="actions">
          <button className="button primary" type="submit" disabled={busy || !agents}>
            {busy ? "Preparing workspace…" : "Ask the Director for a plan"}
          </button>
        </div>
      </form>
    </section>
  );
}
