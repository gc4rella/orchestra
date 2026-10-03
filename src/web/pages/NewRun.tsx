import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, Run, RuntimeInfo } from "../../shared/types.ts";
import { isDirector } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { Button, Loading, Notice } from "../components/UI.tsx";
import { readDraft, writeStorage } from "../model.ts";
import { RUNTIME_LABEL } from "./Agents.tsx";

export function NewRun() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [draft, setDraft] = useState(readDraft);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const load = async () => {
    try {
      const [a, r] = await Promise.all([
        api<Agent[]>("/api/agents"),
        api<RuntimeInfo[]>("/api/runtimes"),
      ]);
      setAgents(a);
      setRuntimes(r);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
  }, []);
  useEffect(() => {
    writeStorage("orchestra.run-draft", JSON.stringify(draft), true);
  }, [draft]);
  const director = agents?.find(isDirector);
  const team = agents?.filter((a) => !isDirector(a)) ?? [];
  const installed = (a: Agent) =>
    runtimes.some((r) => r.runtime === a.runtime && r.installed);
  const ready = director && installed(director) && team.some(installed);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current || !ready) return;
    const errors: Record<string, string> = {};
    if (!draft.prompt.trim())
      errors.prompt = "Describe what you want the team to build.";
    if (!draft.workdir.trim().startsWith("/"))
      errors.workdir = "Enter an absolute project path, starting with /.";
    setInvalid(errors);
    if (Object.keys(errors).length) {
      document.getElementById(Object.keys(errors)[0]!)?.focus();
      return;
    }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>("/api/runs", {
        body: { prompt: draft.prompt.trim(), workdir: draft.workdir.trim() },
      });
      writeStorage("orchestra.run-draft", null, true);
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <section className="page composer-page">
      <a className="back-link" href="#/runs">
        ← All runs
      </a>
      <div className="page-head">
        <div>
          <p className="eyebrow">A new beginning</p>
          <h1>What shall we build?</h1>
          <p className="lede">
            Start with an idea. Your Director will help work out the details.
          </p>
        </div>
        <span className="draft-label">Draft saved in this session</span>
      </div>
      {!agents && !error && <Loading label="Checking your team" />}
      {error && <Notice retry={!agents ? load : undefined}>{error}</Notice>}
      {agents && (
        <form onSubmit={submit} className="composer-grid">
          <div className="composer-card">
            <label htmlFor="prompt">
              <span className="field-heading">
                <span className="field-number">01</span> The brief
              </span>
              <span className="hint" id="brief-help">
                What’s the outcome? Include any requirements or constraints that
                matter.
              </span>
            </label>
            <textarea
              id="prompt"
              className="brief-input"
              rows={9}
              maxLength={20000}
              value={draft.prompt}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              placeholder="I want to build…"
              aria-describedby={`brief-help${invalid.prompt ? " prompt-error" : ""}`}
              aria-invalid={!!invalid.prompt}
            />
            {invalid.prompt && (
              <p id="prompt-error" className="field-error">
                {invalid.prompt}
              </p>
            )}
            <div className="field-divider" />
            <label htmlFor="workdir">
              <span className="field-heading">
                <span className="field-number">02</span> The project
              </span>
            </label>
            <input
              id="workdir"
              className="mono"
              maxLength={1000}
              value={draft.workdir}
              disabled={busy}
              onChange={(e) => setDraft({ ...draft, workdir: e.target.value })}
              placeholder="/Users/you/projects/my-app"
              aria-describedby={`directory-help${invalid.workdir ? " workdir-error" : ""}`}
              aria-invalid={!!invalid.workdir}
            />
            {invalid.workdir && (
              <p id="workdir-error" className="field-error">
                {invalid.workdir}
              </p>
            )}
            <p className="hint" id="directory-help">
              Use an absolute path to an existing repository or a new, empty
              folder.
            </p>
            <details className="workspace-details">
              <summary>How your project is used</summary>
              <p>
                A missing or empty directory becomes a Git repository. An
                existing repository starts from its current commit; uncommitted
                changes are not included. Work is collected on a separate{" "}
                <code>orchestra/…</code> branch for you to review.
              </p>
            </details>
            <div className="composer-submit">
              <Button variant="primary" type="submit" disabled={busy || !ready}>
                {busy ? "Preparing your plan…" : "Create a plan"}
                <span aria-hidden="true">↗</span>
              </Button>
              <span>The team starts after your approval.</span>
            </div>
          </div>
          <aside className="composer-aside">
            <div className="team-summary">
              <p className="eyebrow">Your creative partners</p>
              {director ? (
                <>
                  <div className="director-identity">
                    <span className="avatar director-avatar">
                      {director.name.slice(0, 1)}
                    </span>
                    <div>
                      <h3>{director.name}</h3>
                      <p>Director · {RUNTIME_LABEL[director.runtime]}</p>
                    </div>
                  </div>
                  <p className="muted small">
                    Plans the work and assigns the right people for each task.
                  </p>
                  <div className="team-count">
                    <strong>{team.length}</strong>
                    <span>
                      team member{team.length === 1 ? "" : "s"} available to
                      staff
                    </span>
                  </div>
                </>
              ) : (
                <p>Add a Director to plan your work.</p>
              )}
              <a className="text-link" href="#/agents">
                View your team <span aria-hidden="true">↗</span>
              </a>
            </div>
            {!ready && (
              <Notice kind="warn">
                {!director || !team.length
                  ? "You need a Director and at least one team member before creating a plan."
                  : "Install the Director’s runtime and at least one team member’s runtime, then refresh this page."}
                <a href="#/agents">Manage team →</a>
              </Notice>
            )}
            <div className="next-steps">
              <h3>What happens next</h3>
              <ol>
                <li>
                  <strong>Your Director plans</strong>
                  <span>
                    Tasks, assignments, and clear acceptance criteria.
                  </span>
                </li>
                <li>
                  <strong>You review</strong>
                  <span>Approve the direction or ask for changes.</span>
                </li>
                <li>
                  <strong>Your team builds</strong>
                  <span>Follow progress and review the finished branch.</span>
                </li>
              </ol>
            </div>
            <p className="hint">
              Runtime detection confirms installation. Your CLI must also be
              signed in.
            </p>
          </aside>
        </form>
      )}
    </section>
  );
}
