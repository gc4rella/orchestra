import { useRef, useState, type FormEvent } from "react";
import type { Agent, Team } from "../../shared/types.ts";
import { isDirector } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button, Drawer, Notice } from "./UI.tsx";

/**
 * Forms a team from the hired agents, or edits one: a name, the Director who plans and staffs its runs, and the
 * members it can staff. Saves through the API and hands the saved team back.
 */
export function TeamEditor({
  agents,
  team,
  onSaved,
  onClose,
}: {
  agents: Agent[];
  team?: Team;
  onSaved: (team: Team) => void;
  onClose: () => void;
}) {
  // Agents hired as Directors are the natural choice, so they come first.
  const leads = [...agents].sort((a, b) => Number(isDirector(b)) - Number(isDirector(a)));
  const [name, setName] = useState(team?.name ?? "");
  const [directorId, setDirectorId] = useState(team?.directorId ?? leads[0]?.id ?? "");
  const [memberIds, setMemberIds] = useState<string[]>(
    () => team?.memberIds ?? agents.filter((a) => !isDirector(a)).map((a) => a.id),
  );
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const members = memberIds.filter((id) => id !== directorId);
  const toggle = (id: string, on: boolean) =>
    setMemberIds((ids) => (on ? [...ids.filter((x) => x !== id), id] : ids.filter((x) => x !== id)));
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (lock.current) return;
    if (!members.length) return setError("Choose at least one member for the Director to staff.");
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const saved = await api<Team>(team ? `/api/teams/${team.id}` : "/api/teams", {
        method: team ? "PUT" : "POST",
        body: { name: name.trim(), directorId, memberIds: members },
      });
      onSaved(saved);
    } catch (err) {
      setError((err as Error).message);
      lock.current = false;
      setBusy(false);
    }
  };
  return (
    <Drawer title={team ? `Edit ${team.name}` : "Form a team"} eyebrow="Teams" busy={busy} onClose={onClose}>
      <form className="form" onSubmit={submit}>
        <p className="muted">
          The Director plans each run and assigns tasks only to the members you choose here. An agent can be on
          several teams.
        </p>
        <fieldset disabled={busy}>
          <label>
            Team name
            <input required maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="e.g. Web app crew" />
          </label>
          <label>
            Director
            <select required value={directorId} onChange={(e) => setDirectorId(e.target.value)}>
              {leads.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.role}
                </option>
              ))}
            </select>
            <span className="hint">Plans and staffs the team’s runs, and never takes a task itself.</span>
          </label>
          <fieldset className="member-options">
            <legend>Members</legend>
            {agents
              .filter((a) => a.id !== directorId)
              .map((a) => (
                <label key={a.id} className="autonomy-option">
                  <input type="checkbox" checked={memberIds.includes(a.id)} onChange={(e) => toggle(a.id, e.target.checked)} />
                  <span>
                    <strong>{a.name}</strong>
                    <span className="hint">{a.role}</span>
                  </span>
                </label>
              ))}
            {agents.length < 2 && <p className="hint">Hire at least two agents on the Agents page: a Director and someone to staff.</p>}
          </fieldset>
        </fieldset>
        {error && <Notice>{error}</Notice>}
        <div className="drawer-footer">
          <Button type="submit" variant="primary" disabled={busy || agents.length < 2}>
            {busy ? "Saving…" : team ? "Save team" : "Form team"}
          </Button>
          <Button type="button" variant="ghost" disabled={busy} onClick={onClose}>
            Cancel
          </Button>
        </div>
      </form>
    </Drawer>
  );
}
