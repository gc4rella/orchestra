import { useEffect, useRef, useState } from "react";
import type { Agent, Run, Team } from "../../shared/types.ts";
import { api } from "../api.ts";
import { TeamEditor } from "../components/TeamEditor.tsx";
import { Button, Empty, Loading, Notice } from "../components/UI.tsx";
import { RUNTIME_LABEL } from "./Agents.tsx";

export function Teams() {
  const [agents, setAgents] = useState<Agent[] | null>(null);
  const [teams, setTeams] = useState<Team[] | null>(null);
  const [runs, setRuns] = useState<Run[]>([]);
  const [editing, setEditing] = useState<{ team?: Team } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState("");
  const load = async () => {
    const [a, t, r] = await Promise.all([api<Agent[]>("/api/agents"), api<Team[]>("/api/teams"), api<Run[]>("/api/runs")]);
    setAgents(a);
    setTeams(t);
    setRuns(r);
  };
  const refresh = () => {
    setError(null);
    void load().catch((e) => setError(e.message));
  };
  useEffect(refresh, []);
  const agent = (id: string) => agents?.find((a) => a.id === id);
  const remove = async (t: Team) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(t.id);
    setError(null);
    try {
      await api(`/api/teams/${t.id}`, { method: "DELETE" });
      setConfirmDelete(null);
      setNotice(`${t.name} was disbanded.`);
      await load();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  const saved = (t: Team) => {
    setEditing(null);
    setNotice(`${t.name} is ready to take on a run.`);
    refresh();
  };
  return (
    <section className="page">
      <div className="page-head">
        <div>
          <p className="eyebrow">Teams</p>
          <h1>The right people for each run.</h1>
          <p className="lede">
            Pick a Director and the agents it can staff. Each project starts with the team it last used.
          </p>
        </div>
        <Button variant="primary" disabled={!agents || !!busy} onClick={() => setEditing({})}>
          ＋ Form team
        </Button>
      </div>
      {error && <Notice retry={refresh}>{error}</Notice>}
      {notice && <Notice kind="success">{notice}</Notice>}
      {!teams && !error && <Loading label="Loading your teams" />}
      {teams && agents && teams.length === 0 && (
        <Empty
          title="No teams yet"
          action={
            agents.length >= 2 ? (
              <Button variant="primary" onClick={() => setEditing({})}>Form your first team</Button>
            ) : (
              <a className="button primary" href="#/agents">Hire agents</a>
            )
          }
        >
          A team is a Director plus the agents it assigns work to.
          {agents.length < 2 && " Hire a Director and at least one specialist first."}
        </Empty>
      )}
      {teams && agents && teams.length > 0 && (
        <ul className="agent-grid">
          {teams.map((t) => {
            const director = agent(t.directorId);
            const members = t.memberIds.flatMap((id) => agent(id) ?? []);
            const used = runs.filter((r) => r.teamId === t.id).length;
            return (
              <li key={t.id} className="agent-card clickable-card">
                <h3>
                  <button type="button" className="card-open" disabled={!!busy} aria-label={`Edit ${t.name}`} onClick={() => setEditing({ team: t })}>
                    {t.name}
                  </button>
                </h3>
                <p className="agent-role">
                  Directed by {director ? `${director.name} · ${RUNTIME_LABEL[director.runtime]}` : "a removed agent"}
                </p>
                <p className="agent-skills">
                  {members.length ? members.map((m) => m.name).join(", ") : "No members yet"}
                </p>
                <p className="agent-stats">
                  {members.length} member{members.length === 1 ? "" : "s"} · {used ? `${used} run${used === 1 ? "" : "s"}` : "No runs yet"}
                </p>
                <div className="agent-actions">
                  {confirmDelete === t.id ? (
                    <div className="delete-confirm">
                      <span>Disband {t.name}?</span>
                      <Button variant="small danger" disabled={!!busy} onClick={() => remove(t)}>
                        {busy === t.id ? "Disbanding…" : "Disband"}
                      </Button>
                      <Button variant="small ghost" disabled={!!busy} onClick={() => setConfirmDelete(null)}>
                        Keep
                      </Button>
                    </div>
                  ) : (
                    <Button
                      variant="small ghost"
                      disabled={!!busy || used > 0}
                      title={used ? "Teams with runs are kept with their history" : undefined}
                      onClick={() => setConfirmDelete(t.id)}
                      aria-label={`Disband ${t.name}`}
                    >
                      Disband
                    </Button>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {editing && agents && (
        <TeamEditor agents={agents} team={editing.team} onSaved={saved} onClose={() => setEditing(null)} />
      )}
    </section>
  );
}
