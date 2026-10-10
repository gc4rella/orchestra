import { DemoLauncher } from "../components/DemoLauncher.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, Run, RuntimeInfo, WorkspaceCheck } from "../../shared/types.ts";
import { isDirector } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { FolderPicker } from "../components/FolderPicker.tsx";
import { Button, FolderIcon, FolderPlusIcon, Loading, Notice } from "../components/UI.tsx";
import { describeWorkspace, projectName, readDraft, readStorage, recentProjects, writeStorage } from "../model.ts";
import { RUNTIME_LABEL } from "./Agents.tsx";

export function NewRun() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [draft, setDraft] = useState(readDraft);
  // Autonomous unless the user last chose to approve plans themselves.
  const [autonomous, setAutonomous] = useState(() => readStorage("orchestra.autonomous") !== "false");
  const [continuous, setContinuous] = useState(() => readStorage("orchestra.continuous") !== "false");
  useEffect(() => { writeStorage("orchestra.continuous", String(continuous)); }, [continuous]);
  useEffect(() => { writeStorage("orchestra.autonomous", String(autonomous)); }, [autonomous]);
  const [minutes, setMinutes] = useState(120);
  const [calls, setCalls] = useState(40);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [invalid, setInvalid] = useState<Record<string, string>>({});
  const [recent, setRecent] = useState<string[]>([]);
  const [picking, setPicking] = useState(false);
  // The check that belongs to the current path; a check for an older path is ignored.
  const [check, setCheck] = useState<{ path: string; result: WorkspaceCheck } | null>(null);
  const load = async () => {
    try {
      const [a, r, runs] = await Promise.all([
        api<Agent[]>("/api/agents"),
        api<RuntimeInfo[]>("/api/runtimes"),
        api<Run[]>("/api/runs"),
      ]);
      setAgents(a);
      setRuntimes(r);
      setRecent(recentProjects(runs));
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
  const workdir = draft.workdir.trim();
  useEffect(() => {
    if (!workdir.startsWith("/")) return;
    let live = true;
    const timer = setTimeout(async () => {
      try {
        const result = await api<WorkspaceCheck>(`/api/workspace?path=${encodeURIComponent(workdir)}`);
        if (live) setCheck({ path: workdir, result });
      } catch {
        /* The check is advisory; creating the run validates again. */
      }
    }, 300);
    return () => {
      live = false;
      clearTimeout(timer);
    };
  }, [workdir]);
  const workspace = check?.path === workdir ? check.result : null;
  const hasFolder = workdir.startsWith("/");
  const setWorkdir = (value: string) => {
    setDraft({ ...draft, workdir: value });
    setInvalid(({ workdir: _, ...rest }) => rest);
  };
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
    if (!hasFolder) errors.workdir = "Add a project folder.";
    else if (workspace?.kind === "invalid") errors.workdir = workspace.reason;
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
        body: { prompt: draft.prompt.trim(), workdir: draft.workdir.trim(), autonomous, continuous: autonomous && continuous, limits: { maxDurationMs: minutes * 60_000, maxAgentCalls: calls } },
      });
      writeStorage("orchestra.run-draft", null, true);
      writeStorage("orchestra.autonomous", String(autonomous));
      writeStorage("orchestra.continuous", String(continuous));
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
            <span className="field-heading" id="project-heading">
              <span className="field-number">02</span> The project
            </span>
            <div
              className={`folder-zone ${hasFolder ? "has-folder" : ""}`}
              role="group"
              aria-labelledby="project-heading"
              aria-describedby={invalid.workdir ? "workdir-error" : undefined}
            >
              {!hasFolder ? (
                <div className="folder-empty">
                  <p>
                    Add a folder on <strong>this computer</strong>
                  </p>
                  <Button id="workdir" type="button" variant="pill" disabled={busy} onClick={() => setPicking(true)}>
                    <FolderPlusIcon /> Add
                  </Button>
                  {recent.length > 0 && (
                    <div className="recent-projects">
                      <span className="hint">Recent</span>
                      {recent.map((path) => (
                        <button key={path} type="button" className="chip" title={path} disabled={busy} onClick={() => setWorkdir(path)}>
                          {projectName(path)}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <div className="folder-selected">
                  <span className="folder-selected-icon">
                    <FolderIcon />
                  </span>
                  <div className="folder-selected-meta">
                    <strong>{projectName(workdir)}</strong>
                    <span className="mono" title={workdir}>
                      {workdir}
                    </span>
                    <p className={`path-status ${workspace ? describeWorkspace(workspace).tone : "checking"}`} role="status">
                      <span>{workspace ? describeWorkspace(workspace).text : "Checking folder…"}</span>
                      {workspace?.kind === "invalid" && workspace.root && (
                        <Button type="button" variant="small" onClick={() => setWorkdir(workspace.root!)}>
                          Use {projectName(workspace.root)}
                        </Button>
                      )}
                    </p>
                  </div>
                  <div className="folder-selected-actions">
                    <Button id="workdir" type="button" variant="small" disabled={busy} onClick={() => setPicking(true)}>
                      Change
                    </Button>
                    <Button type="button" variant="icon ghost" aria-label="Remove project folder" disabled={busy} onClick={() => setWorkdir("")}>
                      ×
                    </Button>
                  </div>
                </div>
              )}
            </div>
            {invalid.workdir && (
              <p id="workdir-error" className="field-error">
                {invalid.workdir}
              </p>
            )}
            <details className="workspace-details">
              <summary>How your project is used</summary>
              <p>
                A missing or empty directory becomes a Git repository. An
                existing repository starts from its current commit; uncommitted
                changes are not included. Work is collected on a separate{" "}
                <code>orchestra/…</code> branch for you to review.
              </p>
            </details>
            <label className="autonomy-option">
              <input type="checkbox" checked={autonomous} onChange={(e) => setAutonomous(e.target.checked)} />
              <span>
                <strong>Run autonomously</strong>
                <span className="hint">
                  The Director approves its own plans, re-plans work that fails and fixes what its verification finds.
                  You review the finished branch. Turn this off to approve every plan yourself.
                </span>
              </span>
            </label>
            {autonomous && <label className="autonomy-option">
              <input type="checkbox" checked={continuous} onChange={(e) => setContinuous(e.target.checked)} />
              <span><strong>Keep improving within the brief</strong><span className="hint">After verification, the Director chooses the next useful improvement. The team pauses at your budget, or finishes when no worthwhile work remains.</span></span>
            </label>}
            <fieldset className="run-limits"><legend>Run budget</legend>
              <label>Active minutes<input type="number" required min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
              <label>Agent calls<input type="number" required min={1} max={500} value={calls} onChange={(e) => setCalls(Number(e.target.value))} /></label>
              <p className="hint">Calls include planning, work, reviews and fixes. Paused time does not use your budget.</p>
            </fieldset>
            <div className="composer-submit">
              <Button variant="primary" type="submit" disabled={busy || !ready || workspace?.kind === "invalid"}>
                {busy ? "Preparing your plan…" : autonomous ? "Start the run" : "Create a plan"}
                <span aria-hidden="true">↗</span>
              </Button>
              <span>{autonomous ? "The team starts as soon as the plan is ready." : "The team starts after your approval."}</span>
            </div>
          </div>
          <aside className="composer-aside">
            <DemoLauncher agents={agents} />
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
                {autonomous ? (
                  <li>
                    <strong>Your team builds and checks</strong>
                    <span>Every task is verified before it merges; failures are re-planned.</span>
                  </li>
                ) : (
                  <li>
                    <strong>You review</strong>
                    <span>Approve the direction or ask for changes.</span>
                  </li>
                )}
                <li>
                  <strong>{autonomous ? "You review the result" : "Your team builds"}</strong>
                  <span>
                    {autonomous
                      ? "Read the Director’s verification, comment on the changes, merge the branch."
                      : "Follow progress and review the finished branch."}
                  </span>
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
      {picking && (
        <FolderPicker
          start={workdir}
          onClose={() => setPicking(false)}
          onPick={(path) => {
            setWorkdir(path);
            setPicking(false);
          }}
        />
      )}
    </section>
  );
}
