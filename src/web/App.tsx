import { useEffect, useRef, useState } from "react";
import type { Run, RunStatus } from "../shared/types.ts";
import { api, setTitle, useEvents } from "./api.ts";
import { Agents } from "./pages/Agents.tsx";
import { NewRun } from "./pages/NewRun.tsx";
import { RunPage } from "./pages/Run.tsx";
import { Runs } from "./pages/Runs.tsx";
import { Teams } from "./pages/Teams.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { Empty, Mark } from "./components/UI.tsx";
import { matchesFilter, projectName, readStorage, writeStorage } from "./model.ts";

const canNotify = typeof Notification !== "undefined";
const NOTIFY: Partial<Record<RunStatus, string>> = {
  awaiting_approval: "has a plan for you to review",
  failed: "needs your attention",
  completed: "is ready for your review",
  paused: "is paused and needs your attention",
};

/**
 * Follows every run for the sidebar: the tab title counts the runs that need the user, and with notifications on,
 * a run that starts needing the user while this tab is in the background raises a notification.
 */
function useRunList(notify: boolean) {
  const [runs, setRuns] = useState<Run[] | null>(null);
  const known = useRef(new Map<string, Run>());
  const update = (map: Map<string, Run>) => {
    known.current = map;
    const list = [...map.values()];
    setRuns(list);
    setTitle({ attention: list.filter((r) => matchesFilter(r, "attention")).length });
  };
  const load = () =>
    api<Run[]>("/api/runs")
      .then((list) => update(new Map(list.map((r) => [r.id, r]))))
      .catch(() => {});
  useEffect(() => {
    void load();
  }, []);
  useEvents(
    "runs",
    (ev) => {
      if (ev.type === "deleted") {
        const next = new Map(known.current);
        next.delete(ev.runId);
        return update(next);
      }
      if (ev.type !== "run") return;
      const { run } = ev;
      const previous = known.current.get(run.id)?.status;
      update(new Map(known.current).set(run.id, run));
      const what = NOTIFY[run.status];
      if (!notify || !what || previous === run.status || !document.hidden) return;
      const n = new Notification(`Orchestra · ${projectName(run.workdir)}`, {
        body: `“${run.prompt.split("\n")[0]!.slice(0, 80)}” ${what}.`,
        tag: run.id,
      });
      n.onclick = () => {
        focus();
        location.hash = `/runs/${run.id}`;
        n.close();
      };
    },
    load,
  );
  return runs;
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
  const [route = "", query = ""] = hash.replace(/^#/, "").split("?");
  const path = route || "/";
  const runId = path.match(/^\/runs\/([\w-]+)$/)?.[1];
  const project = new URLSearchParams(query).get("project") ?? undefined;
  const runs = useRunList(notify);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuButton = useRef<HTMLButtonElement>(null);
  const closeMenu = () => {
    setMenuOpen(false);
    menuButton.current?.focus();
  };
  useEffect(() => {
    setMenuOpen(false);
    setTitle({ base: `${path === "/agents" ? "Agents" : path === "/teams" ? "Teams" : path === "/" || path === "/runs/new" ? "New run" : runId ? "Run workspace" : path === "/runs" ? "Runs" : "Page not found"} · Orchestra` });
    if (first.current) first.current = false;
    else {
      main.current?.focus();
      window.scrollTo({ top: 0 });
    }
  }, [path, runId, project]);
  const page =
    path === "/agents" ? (
      <Agents />
    ) : path === "/teams" ? (
      <Teams />
    ) : path === "/" || path === "/runs/new" ? (
      <NewRun key={project} project={project} />
    ) : runId ? (
      <RunPage key={runId} id={runId} />
    ) : path === "/runs" ? (
      <Runs />
    ) : (
      <section className="page">
        <Empty
          title="This page is off the score"
          action={
            <a className="button primary" href="#/">
              Back home
            </a>
          }
        >
          The page you requested doesn’t exist. Your workspace is just one click
          away.
        </Empty>
      </section>
    );
  const controls = (
    <>
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
        <select aria-label="Appearance" value={theme} onChange={(e) => setTheme(e.target.value)}>
          <option value="system">◐ System</option>
          <option value="light">☼ Light</option>
          <option value="dark">☾ Dark</option>
        </select>
      </label>
    </>
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
      <div className="app-shell">
        <Sidebar runs={runs} path={path} runId={runId} open={menuOpen} onClose={closeMenu} controls={controls} />
        {menuOpen && <div className="sidebar-backdrop" aria-hidden="true" onClick={closeMenu} />}
        <div className="app-content">
          <header className="mobile-bar">
            <button
              ref={menuButton}
              className="button small ghost"
              aria-expanded={menuOpen}
              onClick={() => setMenuOpen(true)}
            >
              ☰ Menu
            </button>
            <a href="#/" className="brand" aria-label="Orchestra home">
              <Mark />
              <span>Orchestra</span>
            </a>
            <a className="button primary small" href="#/">
              New run
            </a>
          </header>
          <main id="main" ref={main} tabIndex={-1}>
            {page}
          </main>
        </div>
      </div>
    </>
  );
}
