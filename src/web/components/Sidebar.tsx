import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Run } from "../../shared/types.ts";
import { STATUS_LABEL } from "../pages/Runs.tsx";
import { matchesFilter, projectGroups, projectName, readStorage, writeStorage } from "../model.ts";
import { Mark } from "./UI.tsx";

const readCollapsed = () => {
  try {
    const saved: unknown = JSON.parse(readStorage("orchestra.collapsed") ?? "[]");
    return new Set(Array.isArray(saved) ? saved.filter((v) => typeof v === "string") : []);
  } catch {
    return new Set<string>();
  }
};

/** Projects (one per run folder) with their runs, like a chat list; the current page fills the rest of the window. */
export function Sidebar({
  runs,
  path,
  runId,
  open,
  onClose,
  controls,
}: {
  runs: Run[] | null;
  path: string;
  runId: string | undefined;
  open: boolean;
  onClose: () => void;
  controls: ReactNode;
}) {
  const [collapsed, setCollapsed] = useState(readCollapsed);
  const toggle = (workdir: string) => {
    const next = new Set(collapsed);
    if (!next.delete(workdir)) next.add(workdir);
    setCollapsed(next);
    writeStorage("orchestra.collapsed", next.size ? JSON.stringify([...next]) : null);
  };
  const [rail, setRail] = useState(() => readStorage("orchestra.sidebar") === "rail");
  const toggleRail = () => {
    setRail(!rail);
    writeStorage("orchestra.sidebar", rail ? null : "rail");
  };
  const groups = runs ? projectGroups(runs) : [];
  const root = useRef<HTMLElement>(null);
  // On small screens the sidebar opens over the page; move focus into it.
  useEffect(() => {
    if (open) root.current?.querySelector("a")?.focus();
  }, [open]);
  return (
    <aside
      ref={root}
      className={["sidebar", open && "open", rail && "rail"].filter(Boolean).join(" ")}
      aria-label="Projects and runs"
      onKeyDown={(e) => e.key === "Escape" && open && onClose()}
    >
      <div className="sidebar-head">
        <div className="brand">
          {/* The rail only exists on wide screens; on small ones the sidebar is an overlay the logo closes. */}
          <button
            className="sidebar-toggle"
            aria-label={open ? "Close menu" : rail ? "Expand sidebar" : "Collapse sidebar"}
            aria-expanded={open || !rail}
            title={open ? "Close menu" : rail ? "Expand sidebar" : "Collapse sidebar"}
            onClick={open ? onClose : toggleRail}
          >
            <Mark />
          </button>
          <a href="#/" className="brand-name">
            Orchestra
          </a>
        </div>
        <button className="sidebar-close" aria-label="Close menu" onClick={onClose}>
          ×
        </button>
      </div>
      <nav className="sidebar-nav" aria-label="Main">
        <a href="#/" aria-current={path === "/" ? "page" : undefined} title={rail ? "New run" : undefined}>
          <span className="sidebar-plus" aria-hidden="true">＋</span>
          <span className="sidebar-text">New run</span>
        </a>
        <a href="#/runs" aria-current={path === "/runs" ? "page" : undefined}>
          All runs
        </a>
        <a href="#/teams" aria-current={path === "/teams" ? "page" : undefined}>
          Teams
        </a>
        <a href="#/agents" aria-current={path === "/agents" ? "page" : undefined}>
          Agents
        </a>
        <a href="#/settings" aria-current={path === "/settings" ? "page" : undefined}>
          Settings
        </a>
      </nav>
      <div className="sidebar-projects">
        <h2 className="sidebar-label">Projects</h2>
        {runs?.length === 0 && <p className="sidebar-empty">Projects appear here once you start a run.</p>}
        <ul>
          {groups.map(({ workdir, runs }) => {
            const expanded = !collapsed.has(workdir) || runs.some((r) => r.id === runId);
            const listId = `project-${workdir}`;
            return (
              <li key={workdir} className="sidebar-project">
                <div className="sidebar-project-head">
                  <button aria-expanded={expanded} aria-controls={listId} title={workdir} onClick={() => toggle(workdir)}>
                    <span className="sidebar-caret" aria-hidden="true">
                      ›
                    </span>
                    <span className="sidebar-project-name">{projectName(workdir)}</span>
                  </button>
                  <a
                    className="sidebar-add"
                    href={`#/?project=${encodeURIComponent(workdir)}`}
                    aria-label={`New run in ${projectName(workdir)}`}
                    title={`New run in ${projectName(workdir)}`}
                  >
                    ＋
                  </a>
                </div>
                {expanded && (
                  <ul id={listId}>
                    {runs.map((r) => (
                      <li key={r.id}>
                        <a
                          className="sidebar-run"
                          href={`#/runs/${r.id}`}
                          aria-current={r.id === runId ? "page" : undefined}
                          title={r.prompt.split("\n")[0]}
                        >
                          <span className="sidebar-run-title">{r.prompt.split("\n")[0]}</span>
                          {(matchesFilter(r, "attention") || matchesFilter(r, "active")) && (
                            <span className={`sidebar-run-status status-${r.status}`}>{STATUS_LABEL[r.status]}</span>
                          )}
                        </a>
                      </li>
                    ))}
                  </ul>
                )}
              </li>
            );
          })}
        </ul>
      </div>
      <div className="sidebar-foot">{controls}</div>
    </aside>
  );
}
