import { useEffect, useRef, useState } from "react";
import { demoReadiness } from "../../shared/demo.ts";
import type { Agent, Run, RuntimeInfo } from "../../shared/types.ts";
import { api, navigate } from "../api.ts";
import { Button, Notice } from "./UI.tsx";

export function DemoLauncher({ agents }: { agents: Agent[] }) {
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
  const reason = runtimes ? demoReadiness(agents, runtimes) : "Checking your team’s runtimes…";
  const start = async () => {
    if (lock.current || reason) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    try {
      const run = await api<Run>("/api/demo", { body: {} });
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
      <p className="hint">Uses your configured team and models: real agent calls may cost money. Budget: 5 active minutes and 12 calls. A separate scratch project and the run stay in your history for review.</p>
      {reason && <p className="hint" role="status">{reason} {runtimes && <a href="#/agents">Manage team →</a>}</p>}
      {error && <Notice retry={!runtimes ? load : undefined}>{error}</Notice>}
    </div>
    <Button type="button" disabled={busy || !!reason} onClick={start}>{busy ? "Starting demo…" : "Start demo"}<span aria-hidden="true">↗</span></Button>
  </div>;
}
