import { useEffect, useRef, useState } from "react";
import { demoReadiness } from "../../shared/demo.ts";
import type { Agent, Run, RuntimeInfo, Team } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { Button, Notice } from "./UI.tsx";

/** Starts the demo with `team`, the team a new run would use. */
export function DemoLauncher({ agents, team }: { agents: Agent[]; team: Team | undefined }) {
  const [runtimes, setRuntimes] = useState<RuntimeInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const lock = useRef(false);
  const load = async () => {
    try {
      setRuntimes(await api<RuntimeInfo[]>("/api/runtimes"));
      setError(null);
    } catch (e) { setError((e as Error).message); }
  };
  useEffect(() => { void load(); }, []);
  const agent = (id: string) => agents.find((a) => a.id === id);
  const members = team?.memberIds.flatMap((id) => agent(id) ?? []) ?? [];
  const reason = runtimes ? demoReadiness(team && agent(team.directorId), members, runtimes) : "Checking your team’s runtimes…";
  const start = async () => {
    if (lock.current || reason || !team) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>("/api/demo", { body: { teamId: team.id } });
      navigate(`/runs/${run.id}`);
    } catch (e) {
      setError((e as Error).message);
      lock.current = false;
      setBusy(false);
    }
  };
  return <div className="demo-launcher">
    <div>
      <p className="eyebrow">Watch the team work</p>
      <h3>Try the autonomy demo</h3>
      <p>A tiny TypeScript utility, tests and documentation. Watch one agent’s work pass to another, then follow the Director’s improvements.</p>
      <p className="hint">Uses {team ? team.name : "your team"} and its models: real agent calls may cost money. Budget: 5 active minutes and 12 calls. A separate scratch project and the run stay in your history for review.</p>
      {reason && <p className="hint" role="status">{reason} {runtimes && <a href="#/teams">Manage teams →</a>}</p>}
      {error && <Notice retry={!runtimes ? load : undefined}>{error}</Notice>}
    </div>
    <Button type="button" disabled={busy || !!reason} onClick={start}>{busy ? "Starting demo…" : "Start demo"}<span aria-hidden="true">↗</span></Button>
  </div>;
}
