import { useEffect, useState, type FormEvent } from "react";
import type { Agent, Runtime, RuntimeInfo } from "../../shared/types.ts";
import { DIRECTOR_ROLE, isDirector } from "../../shared/types.ts";
import { api } from "../api.ts";
import { ROLE_PRESETS, type RolePreset } from "../roles.ts";

type Draft = { name: string; runtime: Runtime; model: string; role: string; skills: string; instructions: string };

export const RUNTIME_LABEL: Record<Runtime, string> = { "claude-code": "Claude Code", codex: "Codex" };

const toPresetDraft = (p: RolePreset, runtime: Runtime): Draft => ({
  name: p.name, runtime, model: "", role: p.role, skills: p.skills, instructions: p.instructions,
});

const toDraft = (a: Agent): Draft => ({
  name: a.name, runtime: a.runtime, model: a.model ?? "", role: a.role, skills: a.skills, instructions: a.instructions ?? "",
});

export function Agents() {
  const [agents, setAgents] = useState<Agent[]>([]);
  const [runtimes, setRuntimes] = useState<RuntimeInfo[]>([]);
  const [editing, setEditing] = useState<{ id: string | null; draft: Draft } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [hiring, setHiring] = useState(false);

  // The director leads the list.
  const load = () =>
    api<Agent[]>("/api/agents")
      .then((list) => setAgents([...list.filter(isDirector), ...list.filter((a) => !isDirector(a))]))
      .catch((e) => setError(e.message));
  useEffect(() => {
    load();
    api<RuntimeInfo[]>("/api/runtimes").then(setRuntimes).catch((e) => setError(e.message));
  }, []);

  const save = async (id: string | null, draft: Draft) => {
    setError(null);
    try {
      await api(id ? `/api/agents/${id}` : "/api/agents", { method: id ? "PUT" : "POST", body: draft });
      setEditing(null);
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  const installed = runtimes.filter((r) => r.installed).map((r) => r.runtime);
  /** The preset's runtime when installed, otherwise any installed one. */
  const runtimeFor = (p: RolePreset) => (installed.includes(p.runtime) ? p.runtime : installed[0]);
  const missing = ROLE_PRESETS.filter((p) => !agents.some((a) => a.role === p.role));

  const hire = async (presets: RolePreset[]) => {
    setError(null);
    setHiring(true);
    try {
      for (const p of presets) await api("/api/agents", { body: toPresetDraft(p, runtimeFor(p)!) });
    } catch (e) {
      setError((e as Error).message);
    }
    await load();
    setHiring(false);
  };

  const remove = async (id: string) => {
    setError(null);
    setConfirmDelete(null);
    try {
      await api(`/api/agents/${id}`, { method: "DELETE" });
      await load();
    } catch (e) {
      setError((e as Error).message);
    }
  };

  return (
    <section className="page">
      <div className="page-head">
        <div>
          <h1>Agents</h1>
          <p className="lede">Your product team. Each agent is a local CLI with a role; the director staffs every task by role and skills. Register the same CLI as many roles as you like.</p>
        </div>
        {!editing && (
          <button
            className="button"
            onClick={() => setEditing({ id: null, draft: { name: "", runtime: installed[0] ?? "claude-code", model: "", role: "", skills: "", instructions: "" } })}
          >
            Register custom agent
          </button>
        )}
      </div>

      {error && <p className="alert error" role="alert">{error}</p>}

      <div className="runtime-strip" aria-label="Local runtimes">
        {runtimes.map((r) => (
          <div key={r.runtime} className={`runtime ${r.installed ? "found" : "missing"}`}>
            <strong>{RUNTIME_LABEL[r.runtime]}</strong>
            <span>{r.installed ? r.version ?? "installed" : "not found on PATH"}</span>
          </div>
        ))}
      </div>

      {editing && (
        <AgentForm
          initial={editing.draft}
          isNew={editing.id === null}
          runtimes={runtimes}
          onCancel={() => setEditing(null)}
          onSave={(d) => save(editing.id, d)}
        />
      )}

      {agents.length === 0 && !editing ? (
        <p className="empty">No agents yet. Hire the team below, or register a custom agent.</p>
      ) : (
        <ul className="agent-grid">
          {agents.map((a) => (
            <li key={a.id} className={`card agent ${isDirector(a) ? "director" : ""}`}>
              <div className="agent-head">
                <h2>{a.name}</h2>
                <span className="badge">{RUNTIME_LABEL[a.runtime]}{a.model ? ` · ${a.model}` : ""}</span>
              </div>
              <p className="role">{a.role}</p>
              {isDirector(a) && <p className="small">Plans and staffs every run.</p>}
              {a.skills && <p className="muted">{a.skills}</p>}
              {a.instructions && <p className="muted small">Has custom instructions</p>}
              <div className="actions">
                <button className="button small" onClick={() => setEditing({ id: a.id, draft: toDraft(a) })}>Edit</button>
                {confirmDelete === a.id ? (
                  <>
                    <button className="button small danger" onClick={() => remove(a.id)}>Confirm delete</button>
                    <button className="button small ghost" onClick={() => setConfirmDelete(null)}>Keep</button>
                  </>
                ) : (
                  <button className="button small ghost" onClick={() => setConfirmDelete(a.id)}>Delete</button>
                )}
              </div>
            </li>
          ))}
        </ul>
      )}

      {missing.length > 0 && installed.length > 0 && (
        <div className="presets">
          <div className="page-head">
            <div>
              <h2>Hire from presets</h2>
              <p className="lede">A team like a real product company: leadership on Claude Code, builders on Codex by default. Edit any of them after hiring.</p>
            </div>
            <button className="button primary" disabled={hiring} onClick={() => hire(missing)}>
              Hire the whole team ({missing.length})
            </button>
          </div>
          <ul className="preset-grid">
            {missing.map((p) => (
              <li key={p.role} className="card preset">
                <div className="agent-head">
                  <strong>{p.role}</strong>
                  <span className="badge">{RUNTIME_LABEL[runtimeFor(p)!]}</span>
                </div>
                <p className="muted small">{p.skills}</p>
                <button className="button small" disabled={hiring} onClick={() => hire([p])}>Hire</button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}

function AgentForm(props: {
  initial: Draft;
  isNew: boolean;
  runtimes: RuntimeInfo[];
  onSave: (d: Draft) => void;
  onCancel: () => void;
}) {
  const [d, setD] = useState(props.initial);
  const set = <K extends keyof Draft>(k: K) => (e: { target: { value: string } }) => setD({ ...d, [k]: e.target.value });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onSave(d);
  };

  return (
    <form className="card form" onSubmit={submit}>
      <h2>{props.isNew ? "Register agent" : `Edit ${props.initial.name}`}</h2>
      <div className="grid-2">
        <label>
          Name
          <input required value={d.name} onChange={set("name")} placeholder="e.g. Ada" />
        </label>
        <label>
          Runtime
          <select value={d.runtime} onChange={set("runtime")}>
            {props.runtimes.map((r) => (
              <option key={r.runtime} value={r.runtime}>
                {RUNTIME_LABEL[r.runtime]}{r.installed ? "" : " (not installed)"}
              </option>
            ))}
          </select>
        </label>
        <label>
          Role
          <input required value={d.role} onChange={set("role")} placeholder="e.g. QA engineer" />
          <span className="hint">The agent with role “{DIRECTOR_ROLE}” is the team’s director; there is one.</span>
        </label>
        <label>
          Model <span className="hint">optional — CLI default if empty</span>
          <input value={d.model} onChange={set("model")} placeholder={d.runtime === "codex" ? "e.g. gpt-5-codex" : "e.g. opus, sonnet"} />
        </label>
      </div>
      <label>
        Skills
        <textarea rows={2} value={d.skills} onChange={set("skills")} placeholder="What this agent is good at; the director uses it to assign tasks" />
      </label>
      <label>
        Instructions <span className="hint">optional — added to every prompt this agent receives</span>
        <textarea rows={3} value={d.instructions} onChange={set("instructions")} />
      </label>
      <div className="actions">
        <button className="button primary" type="submit">Save</button>
        <button className="button ghost" type="button" onClick={props.onCancel}>Cancel</button>
      </div>
    </form>
  );
}
