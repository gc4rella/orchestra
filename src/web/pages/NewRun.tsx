import { RateLimitFields } from "../components/RateLimitFields.tsx";
import type { DeliveryPolicy, RateLimitPolicy, RunTimeouts } from "../../shared/types.ts";
import { DEFAULT_RUN_TIMEOUTS, defaultDeliveryPolicy } from "../../shared/types.ts";
import { DeliveryFields } from "../components/DeliveryFields.tsx";
import { RunTimeoutFields } from "../components/RunTimeoutFields.tsx";
import { DemoLauncher } from "../components/DemoLauncher.tsx";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, Run, RuntimeInfo, Team, WorkspaceCheck } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { FolderPicker } from "../components/FolderPicker.tsx";
import { MemoryEditor } from "../components/ProjectMemory.tsx";
import { TeamEditor } from "../components/TeamEditor.tsx";
import { Button, FolderIcon, Loading, Notice } from "../components/UI.tsx";
import { composeBrief, defaultTeamId, describeWorkspace, projectName, readDraft, readStorage, recentProjects, writeStorage } from "../model.ts";

const EXAMPLES: [string, string][] = [
  ["A CLI tool with tests", "Build a small command-line tool in TypeScript that converts CSV files to JSON. Include tests for quoting and empty fields, and a README with usage examples."],
  ["Add a feature to this repo", "Add <feature> to this project. Follow the existing structure and conventions, cover it with tests, and update the docs where users would look for it."],
  ["Improve test coverage", "Find the least-tested important behavior in this project and add focused tests for it. Fix any real bugs the tests uncover; don't change behavior otherwise."],
  ["A small web app", "Build a single-page web app for tracking reading habits: add books, log pages read per day, and show a weekly chart. Keep it dependency-light, with tests for the data logic."],
];
type Mode = "continuous" | "autonomous" | "supervised";
const MODES: { id: Mode; label: string; hint: string }[] = [
  { id: "continuous", label: "Keep improving", hint: "The team starts as soon as the plan is ready, then the Director keeps improving within the brief until your budget runs out or no worthwhile work remains." },
  { id: "autonomous", label: "Autonomous", hint: "The Director approves its own plans, re-plans work that fails and fixes what its verification finds. You review the finished branch." },
  { id: "supervised", label: "Approve plans", hint: "The team starts after you approve the Director’s plan." },
];
const checkKey = (path: string) => `orchestra.check.${path}`;

/** The home page: one brief, the project and team, and the rest tucked under Options. `project` preselects the folder. */
export function NewRun({ project }: { project?: string }) {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [teams, setTeams] = useState<Team[]>([]);
  const [runs, setRuns] = useState<Run[]>([]);
  // The team the user chose; until then, the project's default (see `defaultTeamId`).
  const [picked, setPicked] = useState<string | null>(null);
  const [forming, setForming] = useState(false);
  const [draft, setDraft] = useState(() => (project ? { ...readDraft(), workdir: project } : readDraft()));
  // Autonomous unless the user last chose to approve plans themselves.
  const [autonomous, setAutonomous] = useState(() => readStorage("orchestra.autonomous") !== "false");
  const [continuous, setContinuous] = useState(() => readStorage("orchestra.continuous") === "true");
  useEffect(() => { writeStorage("orchestra.continuous", String(continuous)); }, [continuous]);
  useEffect(() => { writeStorage("orchestra.autonomous", String(autonomous)); }, [autonomous]);
  const mode: Mode = !autonomous ? "supervised" : continuous ? "continuous" : "autonomous";
  const setMode = (m: Mode) => {
    setAutonomous(m !== "supervised");
    if (m !== "supervised") setContinuous(m === "continuous");
  };
  // The check command belongs to a project, so it follows the chosen folder.
  const [checkCommand, setCheckCommand] = useState("");
  const [livePreview, setLivePreview] = useState(() => readStorage("orchestra.preview") !== "false");
  const [policy, setPolicy] = useState<RateLimitPolicy | null>(null);
  const [policyPath, setPolicyPath] = useState("");
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [delivery, setDelivery] = useState<DeliveryPolicy>(defaultDeliveryPolicy);
  const [deliveryPath, setDeliveryPath] = useState("");
  const [deliveryError, setDeliveryError] = useState<string | null>(null);
  const [autoContinueOnRateLimit, setAutoContinueOnRateLimit] = useState(false);
  const [minutes, setMinutes] = useState(120);
  const [calls, setCalls] = useState(40);
  const [timeouts, setTimeouts] = useState<RunTimeouts>({ ...DEFAULT_RUN_TIMEOUTS });
  const [options, setOptions] = useState(() => !!draft.nonGoals);
  const [demo, setDemo] = useState(false);
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
      const [a, r, list, t] = await Promise.all([
        api<Agent[]>("/api/agents"),
        api<RuntimeInfo[]>("/api/runtimes"),
        api<Run[]>("/api/runs"),
        api<Team[]>("/api/teams"),
      ]);
      setAgents(a);
      setRuntimes(r);
      setRuns(list);
      setTeams(t);
      setRecent(recentProjects(list));
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
  useEffect(() => {
    let live = true;
    setPolicyPath("");
    setPolicyError(null);
    if (!workdir.startsWith("/")) { setPolicy(null); return; }
    api<{ rateLimitPolicy: RateLimitPolicy | null }>(`/api/projects/rate-limit?workdir=${encodeURIComponent(workdir)}`)
      .then((result) => { if (live) { setPolicy(result.rateLimitPolicy); setPolicyPath(workdir); } })
      .catch((e) => { if (live) setPolicyError((e as Error).message); });
    return () => { live = false; };
  }, [workdir]);
  useEffect(() => setAutoContinueOnRateLimit(readStorage(`orchestra.rate-limit.${workdir}`) === "true"), [workdir]);
  useEffect(() => {
    let live = true;
    setDelivery(defaultDeliveryPolicy());
    setDeliveryPath("");
    setDeliveryError(null);
    if (!workdir.startsWith("/")) return;
    api<{ delivery: DeliveryPolicy }>(`/api/projects/delivery?workdir=${encodeURIComponent(workdir)}`)
      .then((result) => { if (live) { setDelivery(result.delivery); setDeliveryPath(workdir); } })
      .catch((e) => { if (live) setDeliveryError((e as Error).message); });
    return () => { live = false; };
  }, [workdir]);
  useEffect(() => setCheckCommand(workdir ? (readStorage(checkKey(workdir)) ?? "") : ""), [workdir]);
  const workspace = check?.path === workdir ? check.result : null;
  const hasFolder = workdir.startsWith("/");
  const setWorkdir = (value: string) => {
    setDraft({ ...draft, workdir: value });
    setInvalid(({ workdir: _, ...rest }) => rest);
  };
  const selected = teams.find((t) => t.id === (picked ?? defaultTeamId(teams, runs, workdir)));
  const agent = (id: string) => agents?.find((a) => a.id === id);
  const director = selected && agent(selected.directorId);
  const team = selected?.memberIds.filter((id) => id !== selected.directorId).flatMap((id) => agent(id) ?? []) ?? [];
  const installed = (a: Agent) =>
    runtimes.some((r) => r.runtime === a.runtime && r.installed);
  const ready = selected && director && installed(director) && team.some(installed);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current || !ready) return;
    const errors: Record<string, string> = {};
    if (!draft.prompt.trim())
      errors.prompt = "Describe what you want the team to build.";
    if (!hasFolder) errors.workdir = "Choose a project folder.";
    else if (workspace?.kind === "invalid") errors.workdir = workspace.reason;
    setInvalid(errors);
    if (Object.keys(errors).length) {
      document.getElementById(Object.keys(errors)[0]!)?.focus();
      return;
    }
    if (policyPath !== workdir) { setError(policyError ?? "Project safeguard settings are still loading."); return; }
    if (deliveryPath !== workdir) { setError(deliveryError ?? "Project delivery preferences are still loading."); return; }
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      await api("/api/projects/rate-limit", { method: "PUT", body: { workdir: draft.workdir.trim(), rateLimitPolicy: policy } });
      await api("/api/projects/delivery", { method: "PUT", body: { workdir, delivery } });
      const run = await api<Run>("/api/runs", {
        body: { teamId: selected!.id, prompt: composeBrief(draft), workdir: draft.workdir.trim(), delivery, preview: { enabled: livePreview, command: "" }, checkCommand: checkCommand.trim(), autonomous, autoContinueOnRateLimit, rateLimitPolicy: policy, continuous: autonomous && continuous, limits: { maxDurationMs: minutes * 60_000, maxAgentCalls: calls }, ...((timeouts.agentMs !== DEFAULT_RUN_TIMEOUTS.agentMs || timeouts.checkMs !== DEFAULT_RUN_TIMEOUTS.checkMs) && { timeouts }) },
      });
      writeStorage(`orchestra.rate-limit.${workdir}`, String(autoContinueOnRateLimit));
      writeStorage("orchestra.preview", String(livePreview));
      writeStorage("orchestra.run-draft", null, true);
      writeStorage(checkKey(draft.workdir.trim()), checkCommand.trim() || null);
      writeStorage("orchestra.autonomous", String(autonomous));
      writeStorage("orchestra.continuous", String(continuous));
      navigate(`/runs/${run.id}`);
    } catch (err) {
      setError((err as Error).message);
      lock.current = false;
      setBusy(false);
    }
  };
  const status = workspace && describeWorkspace(workspace);
  return (
    <section className="page home">
      <h1>What shall we build?</h1>
      {!agents && !error && <Loading label="Checking your team" />}
      {error && <Notice retry={!agents ? load : undefined}>{error}</Notice>}
      {agents && (
        <form onSubmit={submit} className="home-form">
          <div className="prompt-box">
            <label htmlFor="prompt" className="sr-only">The brief</label>
            <textarea
              id="prompt"
              rows={3}
              maxLength={20000}
              value={draft.prompt}
              disabled={busy}
              autoFocus
              onChange={(e) => setDraft({ ...draft, prompt: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) e.currentTarget.form?.requestSubmit();
              }}
              placeholder="Describe the outcome you want, with any requirements that matter…"
              aria-describedby={`mode-hint${invalid.prompt ? " prompt-error" : ""}`}
              aria-invalid={!!invalid.prompt}
            />
            <div className="prompt-bar">
              <button
                id="workdir"
                type="button"
                className="prompt-chip"
                title={hasFolder ? workdir : "Choose a folder on this computer"}
                aria-describedby={invalid.workdir ? "workdir-error" : undefined}
                disabled={busy}
                onClick={() => setPicking(true)}
              >
                <FolderIcon />
                <span>{hasFolder ? projectName(workdir) : "Choose project"}</span>
              </button>
              {teams.length > 0 ? (
                <label className="prompt-chip" title={director ? `Directed by ${director.name}` : undefined}>
                  <span className="sr-only">Team</span>
                  <select value={selected?.id ?? ""} disabled={busy} onChange={(e) => setPicked(e.target.value)}>
                    {teams.map((t) => (
                      <option key={t.id} value={t.id}>{t.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <button type="button" className="prompt-chip" onClick={() => setForming(true)}>
                  ＋ Form a team
                </button>
              )}
              <label className="prompt-chip">
                <span className="sr-only">Mode</span>
                <select aria-label="Mode" value={mode} disabled={busy} onChange={(e) => setMode(e.target.value as Mode)}>
                  {MODES.map((m) => (
                    <option key={m.id} value={m.id}>{m.label}</option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="prompt-chip"
                aria-expanded={options}
                aria-controls="run-options"
                onClick={() => setOptions(!options)}
              >
                Options
              </button>
              <button
                type="submit"
                className="prompt-send"
                aria-label={autonomous ? "Start the run" : "Create a plan"}
                title={`${autonomous ? "Start the run" : "Create a plan"} (⌘↵)`}
                aria-busy={busy}
                disabled={busy || !ready || workspace?.kind === "invalid"}
              >
                {busy ? "…" : "↑"}
              </button>
            </div>
          </div>
          {invalid.prompt && <p id="prompt-error" className="field-error">{invalid.prompt}</p>}
          {invalid.workdir && <p id="workdir-error" className="field-error">{invalid.workdir}</p>}
          <div className="prompt-meta">
            {hasFolder ? (
              <p className={`path-status ${status?.tone ?? "checking"}`} role="status">
                <span>{status?.text ?? "Checking folder…"}</span>
                {workspace?.kind === "invalid" && workspace.root && (
                  <Button type="button" variant="small" onClick={() => setWorkdir(workspace.root!)}>
                    Use {projectName(workspace.root)}
                  </Button>
                )}
              </p>
            ) : (
              recent.length > 0 && (
                <p className="recent-projects">
                  <span className="hint">Recent projects</span>
                  {recent.map((path) => (
                    <button key={path} type="button" className="chip" title={path} disabled={busy} onClick={() => setWorkdir(path)}>
                      {projectName(path)}
                    </button>
                  ))}
                </p>
              )
            )}
            <p id="mode-hint" className="hint">{MODES.find((m) => m.id === mode)!.hint}</p>
          </div>
          {!ready && (
            <Notice kind="warn">
              {!director || !team.length
                ? "Choose a team with a Director and at least one member before you start."
                : "Install the Director’s runtime and at least one team member’s runtime, then refresh this page."}
              <a href={agents.length < 2 ? "#/agents" : "#/teams"}>{agents.length < 2 ? "Hire agents →" : "Manage teams →"}</a>
            </Notice>
          )}
          <div id="run-options" className="prompt-options" hidden={!options}>
            <DeliveryFields value={delivery} onChange={setDelivery} disabled={busy || deliveryPath !== workdir} />
            {deliveryError && <Notice>{deliveryError}</Notice>}
            <label className="autonomy-option">
              <input type="checkbox" checked={livePreview} disabled={busy} onChange={(e) => setLivePreview(e.target.checked)} />
              <span>Keep a live preview running<span className="hint">Watch runnable changes as your team works, with automatic updates before and after checks. Detects Vite, Next.js, Astro and plain HTML; customize the start command in the run. Dependencies are installed in a separate worktree and the server runs with your user permissions.</span></span>
            </label>
            <label>
              Non-goals
              <span className="hint">What the team should not do. The Director keeps every plan, including continuous improvements, inside these limits.</span>
              <textarea
                rows={3}
                maxLength={4000}
                value={draft.nonGoals}
                disabled={busy}
                onChange={(e) => setDraft({ ...draft, nonGoals: e.target.value })}
                placeholder="e.g. No authentication. Don't change the public API."
              />
            </label>
            {hasFolder && (
              <label>
                How to check this project
                <span className="hint">
                  One command that installs and runs your checks. The Director uses it after every task unless it doesn’t fit. It runs through your shell, unsandboxed, like the agents.
                </span>
                <input
                  className="mono"
                  maxLength={500}
                  value={checkCommand}
                  disabled={busy}
                  onChange={(e) => setCheckCommand(e.target.value.replace(/[\r\n]/g, " "))}
                  placeholder="bun install && bun test && bun run typecheck"
                />
              </label>
            )}
            {hasFolder && <MemoryEditor key={workdir} workdir={workdir} />}
            <RateLimitFields value={policy} onChange={setPolicy} scope="project" disabled={busy || policyPath !== workdir} />
            {policyError && <Notice>{policyError}</Notice>}
            <label className="autonomy-option">
              <input type="checkbox" checked={autoContinueOnRateLimit} disabled={busy} onChange={(e) => setAutoContinueOnRateLimit(e.target.checked)} />
              <span>Continue automatically after rate limits reset
              <span className="hint">Waits until the provider’s reset time, or retries after 15 minutes if none is given. Up to 5 automatic retries within the existing run budget. Keep Orchestra running; a server restart requires manual resume. Remembered for this project.</span></span>
            </label>
            <fieldset className="run-limits"><legend>Run budget</legend>
              <label>Active minutes<input type="number" required min={1} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label>
              <label>Agent calls<input type="number" required min={1} max={500} value={calls} onChange={(e) => setCalls(Number(e.target.value))} /></label>
              <p className="hint">Calls include planning, work, reviews and fixes. Paused time does not use your budget.</p>
            </fieldset>
            <details>
              <summary>Agent &amp; check timeouts</summary>
              <RunTimeoutFields value={timeouts} onChange={setTimeouts} disabled={busy} />
            </details>
            <p className="hint">
              A missing or empty folder becomes a Git repository. An existing repository starts from its current commit;
              uncommitted changes are not included. Work is collected on a separate <code>orchestra/…</code> branch for you to review.
            </p>
            <p className="actions">
              <Button type="button" variant="small" onClick={() => setForming(true)}>＋ Form a new team</Button>
              <a className="button small ghost" href="#/teams">Manage teams</a>
              <a className="button small ghost" href="#/agents">Test your agents</a>
            </p>
          </div>
          {!draft.prompt.trim() && (
            <ul className="suggestions" aria-label="Start from an example">
              {EXAMPLES.map(([label, text]) => (
                <li key={label}>
                  <button type="button" disabled={busy} onClick={() => setDraft({ ...draft, prompt: text })}>
                    <span aria-hidden="true">↳</span> {label}
                  </button>
                </li>
              ))}
              <li>
                <button type="button" aria-expanded={demo} aria-controls="demo" onClick={() => setDemo(!demo)}>
                  <span aria-hidden="true">↳</span> Watch the team work: the autonomy demo
                </button>
              </li>
            </ul>
          )}
          {demo && !draft.prompt.trim() && (
            <div id="demo">
              <DemoLauncher agents={agents} team={selected} />
            </div>
          )}
        </form>
      )}
      {forming && agents && (
        <TeamEditor
          agents={agents}
          onClose={() => setForming(false)}
          onSaved={(t) => {
            setTeams((list) => [...list, t]);
            setPicked(t.id);
            setForming(false);
          }}
        />
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
