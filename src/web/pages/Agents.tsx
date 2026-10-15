import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, AgentStats, ProbeResult, Runtime, RuntimeInfo, Skill, Team } from "../../shared/types.ts";
import { DIRECTOR_ROLE, EFFORTS, isDirector } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ROLE_PRESETS, type RolePreset } from "../roles.ts";
import { SkillPicker } from "../components/SkillPicker.tsx";
import { Button, Drawer, Empty, ErrorDetails, Loading, Notice } from "../components/UI.tsx";
import { agentSetup, formatUsage } from "../model.ts";

type Draft = {
  name: string;
  runtime: Runtime;
  model: string;
  effort: string;
  role: string;
  expertise: string;
  skills: Skill[];
  instructions: string;
};
export const RUNTIME_LABEL: Record<Runtime, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
};
/** A small team that can run anything: one Director, one builder, one checker. */
const STARTER_ROLES = [DIRECTOR_ROLE, "Full-stack Engineer", "QA Engineer"];
/** "9 tasks done · 7 first time · avg 1.3 attempts · 1 failed · $2.10 · 4 reviews". */
function statsLine(s: AgentStats | undefined) {
  if (!s || (!s.done && !s.failed && !s.reviews)) return "No tasks yet";
  const usage = formatUsage(s);
  return [
    s.done || s.failed ? `${s.done} task${s.done === 1 ? "" : "s"} done` : null,
    s.done ? `${s.firstTry} first time` : null,
    s.avgAttempts !== null && s.done ? `avg ${s.avgAttempts.toFixed(1)} attempts` : null,
    s.failed ? `${s.failed} failed` : null,
    usage,
    s.reviews ? `${s.reviews} review${s.reviews === 1 ? "" : "s"}` : null,
  ].filter(Boolean).join(" · ");
}
const toDraft = (a: Agent): Draft => ({
  name: a.name,
  runtime: a.runtime,
  model: a.model ?? "",
  effort: a.effort ?? "",
  role: a.role,
  expertise: a.expertise,
  skills: a.skills,
  instructions: a.instructions ?? "",
});
export function Agents() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [stats, setStats] = useState<Record<string, AgentStats>>({});
  const [editing, setEditing] = useState<{
    id: string | null;
    draft: Draft;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [formError, setFormError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [notice, setNotice] = useState("");
  const [search, setSearch] = useState("");
  const [probes, setProbes] = useState<Record<string, ProbeResult | "testing">>({});
  // Probes run independently of the edit/remove lock: they only read the agent.
  const test = async (a: Agent) => {
    setProbes((p) => ({ ...p, [a.id]: "testing" }));
    try {
      const result = await api<ProbeResult>(`/api/agents/${a.id}/test`, { body: {} });
      setProbes((p) => ({ ...p, [a.id]: result }));
    } catch (e) {
      setProbes((p) => ({ ...p, [a.id]: { ok: false, ms: 0, error: (e as Error).message, usage: null } }));
    }
  };
  const load = async () => {
    const [a, r, st] = await Promise.all([
      api<Agent[]>("/api/agents"),
      api<RuntimeInfo[]>("/api/runtimes"),
      // A track record is a nice-to-have; the team page works without it.
      api<Record<string, AgentStats>>("/api/agents/stats").catch(() => ({})),
    ]);
    setAgents(a);
    setRuntimes(r);
    setStats(st);
  };
  const refresh = () => {
    setError(null);
    void load().catch((e) => setError(e.message));
  };
  useEffect(refresh, []);
  const installed = runtimes.filter((r) => r.installed).map((r) => r.runtime);
  const runtimeFor = (p: RolePreset) =>
    installed.includes(p.runtime) ? p.runtime : installed[0];
  const missing = ROLE_PRESETS.filter(
    (p) =>
      !agents?.some(
        (a) => a.role.trim().toLowerCase() === p.role.toLowerCase(),
      ),
  );
  const edit = (agent?: Agent) => {
    setFormError(null);
    setEditing({
      id: agent?.id ?? null,
      draft: agent
        ? toDraft(agent)
        : {
            name: "",
            runtime: installed[0] ?? "claude-code",
            model: "",
            effort: "",
            role: "",
            expertise: "",
            skills: [],
            instructions: "",
          },
    });
  };
  const save = async (draft: Draft) => {
    if (lock.current || !editing) return;
    lock.current = true;
    setBusy("save");
    setFormError(null);
    try {
      await api(editing.id ? `/api/agents/${editing.id}` : "/api/agents", {
        method: editing.id ? "PUT" : "POST",
        body: { ...draft, skills: draft.skills.map((s) => s.id) },
      });
      setEditing(null);
      setNotice(`${draft.name} is ready to join a team.`);
      try {
        await load();
      } catch (e) {
        setError(
          `Saved, but couldn't refresh the team. ${(e as Error).message}`,
        );
      }
    } catch (e) {
      setFormError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  /** Hires the presets; a starter hire also forms them into a first team, so a run can start right away. */
  const hire = async (presets: RolePreset[], starter = false) => {
    if (lock.current) return;
    lock.current = true;
    setBusy("hire");
    setError(null);
    const hired: Agent[] = [];
    try {
      for (const p of presets) {
        const runtime = runtimeFor(p);
        if (!runtime)
          throw new Error("Install a runtime before adding presets.");
        hired.push(await api<Agent>("/api/agents", {
          body: {
            name: p.name,
            runtime,
            model: "",
            effort: "",
            role: p.role,
            expertise: p.expertise,
            skills: p.skills,
            instructions: p.instructions,
          },
        }));
      }
      const lead = hired.find(isDirector);
      const members = hired.filter((a) => a !== lead);
      if (starter && lead && members.length) {
        await api<Team>("/api/teams", { body: { name: "My team", directorId: lead.id, memberIds: members.map((a) => a.id) } });
      }
    } catch (e) {
      setError((e as Error).message);
    }
    try {
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
    const count = hired.length;
    if (count)
      setNotice(`Hired ${count} agent${count === 1 ? "" : "s"}.${starter ? " They’re ready as My team." : ""}`);
    lock.current = false;
    setBusy(null);
  };
  const remove = async (a: Agent) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(a.id);
    setError(null);
    try {
      await api(`/api/agents/${a.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      setNotice(`${a.name} was removed.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const directors = agents?.filter(isDirector) ?? [];
  const members = agents?.filter(
    (a) =>
      !isDirector(a) &&
      `${a.name} ${a.role} ${a.expertise} ${a.skills.map((s) => s.name).join(" ")}`
        .toLowerCase()
        .includes(search.toLowerCase()),
  );
  const probeLine = (a: Agent) => {
    const probe = probes[a.id];
    if (!probe) return null;
    if (probe === "testing") return <p className="probe-result" role="status">Testing {a.name}…</p>;
    if (probe.ok) {
      const usage = probe.usage && formatUsage({ costUsd: probe.usage.costUsd ?? 0, tokens: probe.usage.tokens, costEstimated: probe.usage.estimated });
      return (
        <p className="probe-result probe-ok" role="status">
          ✓ Signed in · answered in {(probe.ms / 1000).toFixed(1)}s{usage ? ` · ${usage}` : ""}
        </p>
      );
    }
    return (
      <div className="probe-result" role="status">
        <ErrorDetails text={`Test failed: ${probe.error ?? "no answer"}`} />
      </div>
    );
  };
  /** The name opens the editor; its hit area covers the whole card (see `.card-open`). */
  const cardOpen = (a: Agent) => (
    <button type="button" className="card-open" disabled={!!busy} aria-label={`Edit ${a.name}`} onClick={() => edit(a)}>
      {a.name}
    </button>
  );
  const controls = (a: Agent) => (
    <div className="agent-actions">
      <Button
        variant="small ghost"
        disabled={probes[a.id] === "testing" || !installed.includes(a.runtime)}
        title="Makes one small read-only call to check that the CLI is signed in"
        onClick={() => void test(a)}
      >
        {probes[a.id] === "testing" ? "Testing…" : "Test"}
      </Button>
      {confirmDelete === a.id ? (
        <div className="delete-confirm">
          <span>Remove {a.name}?</span>
          <Button
            variant="small danger"
            disabled={!!busy}
            onClick={() => remove(a)}
          >
            {busy === a.id ? "Removing…" : "Remove"}
          </Button>
          <Button
            variant="small ghost"
            disabled={!!busy}
            onClick={() => setConfirmDelete(null)}
          >
            Keep
          </Button>
        </div>
      ) : (
        <Button
          variant="small ghost"
          disabled={!!busy}
          onClick={() => setConfirmDelete(a.id)}
          aria-label={`Remove ${a.name}`}
        >
          Remove
        </Button>
      )}
    </div>
  );
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Better together</p>
          <h1>A team for every possibility.</h1>
          <p className="lede">
            Hire agents with a specialty, then <a href="#/teams">form them into teams</a>. Each team’s Director brings
            them together.
          </p>
        </div>
        <Button
          variant="primary"
          disabled={!agents || !!busy}
          onClick={() => edit()}
        >
          ＋ Add agent
        </Button>
      </div>
      {error && <Notice retry={refresh}>{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!agents && !error && <Loading label="Loading your team" />}
      {agents && (
        <>
          <div className="runtime-strip">
            <span className="runtime-label">Local runtimes</span>
            {runtimes.map((r) => (
              <div
                key={r.runtime}
                className={`runtime ${r.installed ? "found" : "missing"}`}
              >
                <span className="status-dot" />
                <strong>{RUNTIME_LABEL[r.runtime]}</strong>
                <span title={r.version ?? undefined}>
                  {r.installed ? "Installed" : "Not installed"}
                </span>
              </div>
            ))}
            <span className="runtime-note">CLI sign-in required</span>
            <Button variant="small ghost" disabled={!!busy} onClick={refresh}>
              Refresh ↻
            </Button>
          </div>
          {!installed.length && (
            <Notice kind="warn">
              Install Claude Code or Codex and sign in through its CLI, then
              refresh runtimes to start assembling your team.
            </Notice>
          )}
          {directors.length ? directors.map((director) => (
            <article key={director.id} className="director-card clickable-card">
              <div className="director-intro">
                <span className="avatar director-avatar">
                  {director.name.slice(0, 1)}
                </span>
                <div>
                  <p className="eyebrow">The conductor</p>
                  <h2>{cardOpen(director)}</h2>
                  <span className="runtime-badge">
                    {RUNTIME_LABEL[director.runtime]} · {agentSetup(director, runtimes)}
                  </span>
                </div>
              </div>
              <div className="director-description">
                <h3>A shared direction. Every task in sync.</h3>
                <p>
                  {director.expertise ||
                    "Plans your work, staffs the team, and sequences tasks by dependency."}
                </p>
                <SkillChips skills={director.skills} />
                <span className="hint">
                  Directs the runs of the teams it leads · You approve before execution
                </span>
              </div>
              {controls(director)}
              {probeLine(director)}
            </article>
          )) : (
            <Empty
              title="Every team needs a Director"
              action={
                installed.length ? (
                  <div className="actions">
                    {agents.length === 0 && (
                      <Button
                        variant="primary"
                        disabled={!!busy}
                        onClick={() => hire(ROLE_PRESETS.filter((p) => STARTER_ROLES.includes(p.role)), true)}
                      >
                        {busy === "hire" ? "Hiring…" : "Hire a starter team"}
                      </Button>
                    )}
                    <Button
                      variant={agents.length === 0 ? "ghost" : "primary"}
                      disabled={!!busy}
                      onClick={() =>
                        hire(ROLE_PRESETS.filter((p) => p.role === DIRECTOR_ROLE))
                      }
                    >
                      {busy === "hire" && agents.length > 0 ? "Adding Director…" : "Add a Director only"}
                    </Button>
                  </div>
                ) : undefined
              }
            >
              Your Director turns an idea into a plan and assigns work to your
              team.
              {agents.length === 0 && " A starter team is a Director, a Full-stack Engineer and a QA Engineer, on the CLIs you have installed."}
            </Empty>
          )}
          <div className="section-head">
            <div>
              <p className="eyebrow">The ensemble</p>
              <h2>
                Your specialists{" "}
                <span className="count-label">
                  {agents.filter((a) => !isDirector(a)).length}
                </span>
              </h2>
            </div>
            <label className="search-field">
              <span aria-hidden="true">⌕</span>
              <input
                type="search"
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                aria-label="Search team"
                placeholder="Find a name or skill…"
              />
            </label>
          </div>
          <ul className="agent-grid">
            {members?.map((a, i) => (
              <li key={a.id} className="agent-card clickable-card">
                <div className="agent-head">
                  <span className={`avatar avatar-${i % 3}`}>
                    {a.name.slice(0, 2)}
                  </span>
                  <span className="runtime-badge">
                    {RUNTIME_LABEL[a.runtime]}
                  </span>
                </div>
                <h3>{cardOpen(a)}</h3>
                <p className="agent-role">{a.role}</p>
                <p className="agent-skills">
                  {a.expertise ||
                    "Describe this agent’s expertise to help your Director assign the right work."}
                </p>
                <SkillChips skills={a.skills} />
                <p className="hint mono wrap">{agentSetup(a, runtimes)}</p>
                <div className="agent-meta">
                  {a.instructions
                    ? "Custom instructions"
                    : "Standard instructions"}
                  {!installed.includes(a.runtime) && (
                    <span className="field-error">Runtime unavailable</span>
                  )}
                </div>
                <p className="agent-stats">{statsLine(stats[a.id])}</p>
                {controls(a)}
                {probeLine(a)}
              </li>
            ))}
          </ul>
          {members?.length === 0 && (
            <div className="inline-empty">
              {search
                ? "No teammates match that search."
                : "Add your first specialist below, or create a custom agent."}
            </div>
          )}
          {missing.length > 0 && (
            <details
              className="presets"
              open={agents.length < 2 ? true : undefined}
            >
              <summary>
                <div>
                  <span className="eyebrow">Grow your team</span>
                  <h2>A little more expertise</h2>
                </div>
                <span>
                  {missing.length} role presets{" "}
                  <span aria-hidden="true">＋</span>
                </span>
              </summary>
              <div className="presets-content">
                <div className="section-head">
                  <p className="muted">
                    Start with a specialist’s role and instructions. Adjust them
                    to make the team your own.
                  </p>
                  <Button
                    disabled={!!busy || !installed.length}
                    onClick={() => hire(missing)}
                  >
                    {busy === "hire"
                      ? "Adding specialists…"
                      : `Add all ${missing.length} roles`}
                  </Button>
                </div>
                <ul className="preset-grid">
                  {missing.map((p) => (
                    <li key={p.role} className="preset">
                      <h3>{p.role}</h3>
                      <p>{p.expertise}</p>
                      {p.skills.length > 0 && (
                        <p className="hint">
                          Skills: {p.skills.map((id) => id.split("/").at(-1)).join(", ")}
                        </p>
                      )}
                      <div>
                        <span className="hint">
                          {runtimeFor(p)
                            ? RUNTIME_LABEL[runtimeFor(p)!]
                            : "Runtime needed"}
                        </span>
                        <Button
                          variant="small"
                          disabled={!!busy || !installed.length}
                          onClick={() => hire([p])}
                        >
                          ＋ Add
                        </Button>
                      </div>
                    </li>
                  ))}
                </ul>
              </div>
            </details>
          )}
        </>
      )}
      {editing && (
        <Drawer
          title={editing.id ? `Edit ${editing.draft.name}` : "Add an agent"}
          busy={busy === "save"}
          onClose={() => setEditing(null)}
        >
          <AgentForm
            key={editing.id ?? "new"}
            initial={editing.draft}
            runtimes={runtimes}
            busy={busy === "save"}
            error={formError}
            onSave={save}
            onCancel={() => setEditing(null)}
          />
        </Drawer>
      )}
    </section>
  );
}
/** Marketplace skills on a card; names only, the drawer shows the rest. */
function SkillChips({ skills }: { skills: Skill[] }) {
  if (!skills.length) return null;
  return (
    <ul className="skill-chips" aria-label="Skills">
      {skills.map((s) => (
        <li key={s.id} title={s.description || s.id}>{s.name}</li>
      ))}
    </ul>
  );
}
function AgentForm({
  initial,
  runtimes,
  busy,
  error,
  onSave,
  onCancel,
}: {
  initial: Draft;
  runtimes: RuntimeInfo[];
  busy: boolean;
  error: string | null;
  onSave: (draft: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(initial);
  const set = (k: Exclude<keyof Draft, "skills">) => (e: { target: { value: string } }) =>
    setD({ ...d, [k]: e.target.value });
  const defaults = runtimes.find((r) => r.runtime === d.runtime)?.defaults;
  // Effort levels differ per CLI; switching keeps the choice only if the new CLI has it.
  const setRuntime = (e: { target: { value: string } }) => {
    const runtime = e.target.value as Runtime;
    setD({ ...d, runtime, effort: EFFORTS[runtime].includes(d.effort) ? d.effort : "" });
  };
  // New skills are fetched from GitHub on save, which takes a few seconds.
  const fetching = d.skills.some((s) => !initial.skills.some((i) => i.id === s.id));
  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (!busy) onSave(d);
  };
  return (
    <form className="form" onSubmit={submit}>
      <p className="muted">
        A clear role, expertise and skills help your Director choose the right
        agent.
      </p>
      <fieldset disabled={busy}>
        <label>
          Name
          <input
            autoFocus
            required
            maxLength={80}
            value={d.name}
            onChange={set("name")}
            placeholder="e.g. Frontend"
          />
        </label>
        <label>
          Role
          <input
            required
            maxLength={200}
            value={d.role}
            onChange={set("role")}
            placeholder="e.g. Frontend Engineer"
          />
          <span className="hint">
            Use “{DIRECTOR_ROLE}” for agents who can direct a team.
          </span>
        </label>
        <label>
          Runtime
          <select value={d.runtime} onChange={setRuntime}>
            {runtimes.map((r) => (
              <option key={r.runtime} value={r.runtime}>
                {RUNTIME_LABEL[r.runtime]}
                {r.installed ? "" : " (not installed)"}
              </option>
            ))}
          </select>
        </label>
        <div className="grid-2">
          <label>
            <span>
              Model <span className="optional">Optional</span>
            </span>
            <input
              maxLength={100}
              value={d.model}
              onChange={set("model")}
              placeholder={defaults?.model ? `Default: ${defaults.model}` : "CLI default"}
            />
          </label>
          <label>
            Reasoning effort
            <select value={d.effort} onChange={set("effort")}>
              <option value="">Default{defaults?.effort ? ` (${defaults.effort})` : ""}</option>
              {EFFORTS[d.runtime].map((level) => (
                <option key={level} value={level}>{level}</option>
              ))}
            </select>
          </label>
        </div>
        <label>
          Expertise
          <textarea
            rows={3}
            maxLength={2000}
            value={d.expertise}
            onChange={set("expertise")}
            placeholder="What is this agent especially good at?"
          />
          <span className="hint">
            Used by the Director when assigning tasks.
          </span>
        </label>
        <SkillPicker value={d.skills} onChange={(skills) => setD({ ...d, skills })} />
        <label>
          <span>
            Instructions <span className="optional">Optional</span>
          </span>
          <textarea
            rows={6}
            maxLength={10000}
            value={d.instructions}
            onChange={set("instructions")}
            placeholder="Guidance to include in every task this agent receives."
          />
        </label>
      </fieldset>
      {error && <Notice>{error}</Notice>}
      <div className="drawer-footer">
        <Button type="submit" variant="primary" disabled={busy}>
          {busy ? (fetching ? "Fetching skills…" : "Saving…") : "Save agent"}
        </Button>
        <Button
          type="button"
          variant="ghost"
          disabled={busy}
          onClick={onCancel}
        >
          Cancel
        </Button>
      </div>
    </form>
  );
}
