import { useEffect, useRef, useState } from "react";
import type { Run, RunStatus } from "../shared/types.ts";
import { api, useEvents } from "./api.ts";
import { Agents } from "./pages/Agents.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { RunPage } from "./pages/Run.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Empty, Mark } from "./components/UI.tsx";
import { projectName, readStorage, writeStorage } from "./model.ts";

const canNotify = typeof Notification !== "undefined";
const NOTIFY: Partial<Record<RunStatus, string>> = {
  awaiting_approval: "has a plan for you to review",
  failed: "needs your attention",
  completed: "is ready for your review",
};

/** Notifies when a run needs the user while this tab is in the background. Mounted only while notifications are on. */
function RunNotifier() {
  const last = useRef(new Map<string, RunStatus>());
  useEffect(() => {
    api<Run[]>("/api/runs")
      .then((runs) => runs.forEach((r) => last.current.has(r.id) || last.current.set(r.id, r.status)))
      .catch(() => {});
  }, []);
  useEvents("runs", (ev) => {
    if (ev.type !== "run") return;
    const { run } = ev;
    const previous = last.current.get(run.id);
    last.current.set(run.id, run.status);
    const what = NOTIFY[run.status];
    if (!what || previous === run.status || !document.hidden) return;
    const n = new Notification(`Orchestra · ${projectName(run.workdir)}`, {
      body: `“${run.prompt.split("\n")[0]!.slice(0, 80)}” ${what}.`,
      tag: run.id,
    });
    n.onclick = () => {
      focus();
      location.hash = `/runs/${run.id}`;
      n.close();
    };
  });
  return null;
}

export function App() {
  const [hash, setHash] = useState(location.hash);
  const [theme, setTheme] = useState(() => {
    const saved = readStorage("orchestra.theme");
    return saved === "light" || saved === "dark" ? saved : "system";
  });
  const [notify, setNotify] = useState(
    () => canNotify && Notification.permission === "granted" && readStorage("orchestra.notify") === "on",
  );
  const toggleNotify = async () => {
    const on = !notify && (Notification.permission === "granted" || (await Notification.requestPermission()) === "granted");
    setNotify(on);
    writeStorage("orchestra.notify", on ? "on" : null);
  };
  const main = useRef<HTMLElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const changed = () => setHash(location.hash);
    addEventListener("hashchange", changed);
    return () => removeEventListener("hashchange", changed);
  }, []);
  useEffect(() => {
    const media = matchMedia("(prefers-color-scheme: dark)");
    const apply = () => {
      document.documentElement.dataset.theme =
        theme === "system" ? (media.matches ? "dark" : "light") : theme;
    };
    apply();
    writeStorage("orchestra.theme", theme);
    media.addEventListener("change", apply);
    return () => media.removeEventListener("change", apply);
  }, [theme]);
  const path = hash.replace(/^#/, "") || "/runs";
  const runId = path.match(/^\/runs\/([\w-]+)$/)?.[1];
  useEffect(() => {
    document.title = `${path === "/agents" ? "Team" : path === "/runs/new" ? "New run" : runId ? "Run workspace" : path === "/runs" ? "Runs" : "Page not found"} · Orchestra`;
    if (first.current) first.current = false;
    else {
      main.current?.focus();
      window.scrollTo({ top: 0 });
    }
  }, [path, runId]);
  const page =
    path === "/agents" ? (
      <Agents />
    ) : path === "/runs/new" ? (
      <NewRun />
    ) : runId ? (
      <RunPage key={runId} id={runId} />
    ) : path === "/runs" ? (
      <Runs />
    ) : (
      <section className="page">
        <Empty
          title="This page is off the score"
          action={
            <a className="button primary" href="#/runs">
              Back to runs
            </a>
          }
        >
          The page you requested doesn’t exist. Your workspace is just one click
          away.
        </Empty>
      </section>
    );
  return (
    <>
      <a
        className="skip-link"
        href="#main"
        onClick={(e) => {
          e.preventDefault();
          main.current?.focus();
        }}
      >
        Skip to content
      </a>
      <header className="topbar">
        <div className="topbar-inner">
          <a href="#/runs" className="brand" aria-label="Orchestra home">
            <Mark />
            <span>
              Orchestra
              <span className="brand-caption">Your ideas, in concert.</span>
            </span>
          </a>
          <nav aria-label="Main">
            <a
              href="#/runs"
              aria-current={
                path.startsWith("/runs") && path !== "/runs/new"
                  ? "page"
                  : undefined
              }
            >
              Runs
            </a>
            <a
              href="#/agents"
              aria-current={path === "/agents" ? "page" : undefined}
            >
              Team
            </a>
          </nav>
          <div className="topbar-actions">
            {canNotify && (
              <button
                className="button small ghost notify-toggle"
                aria-pressed={notify}
                title="Notify me when a run needs me while Orchestra is in the background"
                onClick={() => void toggleNotify()}
              >
                {notify ? "Notifications on" : "Notify me"}
              </button>
            )}
            <label className="theme-control">
              <span className="sr-only">Appearance</span>
              <select
                aria-label="Appearance"
                value={theme}
                onChange={(e) => setTheme(e.target.value)}
              >
                <option value="system">◐ System</option>
                <option value="light">☼ Light</option>
                <option value="dark">☾ Dark</option>
              </select>
            </label>
            <a className="button primary new-run-link" href="#/runs/new">
              <span aria-hidden="true">＋</span> New run
            </a>
          </div>
        </div>
      </header>
      {notify && <RunNotifier />}
      <main id="main" ref={main} tabIndex={-1}>
        {page}
      </main>
      <footer className="app-footer">
        <span>
          <Mark small /> Orchestra
        </span>
        <span>A little direction. Extraordinary work.</span>
        <span>Local workspace</span>
      </footer>
    </>
  );
}
