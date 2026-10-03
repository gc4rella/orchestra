import { useEffect, useState } from "react";
import { Agents } from "./pages/Agents.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { RunPage } from "./pages/Run.tsx";
import { Runs } from "./pages/Runs.tsx";

function useHash() {
  const [hash, setHash] = useState(location.hash);
  useEffect(() => {
    const onChange = () => setHash(location.hash);
    addEventListener("hashchange", onChange);
    return () => removeEventListener("hashchange", onChange);
  }, []);
  return hash.replace(/^#/, "") || "/runs";
}

export function App() {
  const path = useHash();
  const runId = path.match(/^\/runs\/([\w-]+)$/)?.[1];
  const page =
    path === "/agents" ? <Agents />
    : path === "/runs/new" ? <NewRun />
    : runId ? <RunPage key={runId} id={runId} />
    : <Runs />;

  const link = (href: string, label: string, active: boolean) => (
    <a href={`#${href}`} aria-current={active ? "page" : undefined}>{label}</a>
  );

  return (
    <>
      <header className="topbar">
        <a href="#/runs" className="brand">
          <span aria-hidden="true">𝄞</span> Orchestra
        </a>
        <nav aria-label="Main">
          {link("/runs", "Runs", path.startsWith("/runs") && path !== "/runs/new")}
          {link("/agents", "Agents", path === "/agents")}
        </nav>
        <a className="button primary" href="#/runs/new">New run</a>
      </header>
      <main>{page}</main>
    </>
  );
}
