import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, LogEntry, Plan, ReviewComment, Run, Task } from "../../shared/types.ts";
import { FINISHED_RUN, isDirector } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";
import { DiffView } from "../components/DiffView.tsx";
import { PlanReview, ReviseForm } from "../components/PlanReview.tsx";
import {
  Button,
  Connection,
  CopyButton,
  Loading,
  Notice,
} from "../components/UI.tsx";
import { formatDuration, formatUsage, mergeLogs, projectName, shellQuote } from "../model.ts";
import { Status } from "./Runs.tsx";
type Stream = string | null;
// No banner while a plan awaits approval: the plan review leads instead.
const statusCopy: Record<Exclude<Run["status"], "awaiting_approval">, [string, string]> = {
  planning: [
    "A good plan starts here.",
    "Your Director is shaping the work and choosing the right team.",
  ],
  running: [
    "Your team is on it.",
    "Tasks start as their dependencies finish, and each is checked before it merges. Select any task to follow its output.",
  ],
  completed: [
    "Ready for your final touch.",
    "The team’s work is collected on one branch. Review the Director’s report and any open items below.",
  ],
  failed: [
    "Let’s get this moving again.",
    "Review the issue below and retry the work that needs attention.",
  ],
  cancelled: [
    "This run has been stopped.",
    "You can still explore the tasks, summaries, and output below.",
  ],
};
export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [picked, setPicked] = useState<Stream | undefined>(undefined);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsLoading, setLogsLoading] = useState(true);
  const [logError, setLogError] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const lock = useRef(false);
  const [mobileView, setMobileView] = useState("tasks");
  const [tab, setTab] = useState<"work" | "changes">("work");
  const requestVersion = useRef(0);
  const directing =
    run?.status === "planning" || run?.status === "awaiting_approval";
  const stream: Stream =
    picked !== undefined
      ? picked
      : directing
        ? null
        : ((tasks.find((t) => t.status === "running") ?? tasks[0])?.id ?? null);
  const currentStream = useRef(stream);
  currentStream.current = stream;
  const load = async () => {
    try {
      const d = await api<{ run: Run; tasks: Task[] }>(`/api/runs/${id}`);
      setRun(d.run);
      setTasks(d.tasks);
      setError(null);
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const loadAgents = async () => {
    try {
      const list = await api<Agent[]>("/api/agents");
      setAgents(new Map(list.map((a) => [a.id, a])));
      setAgentError(null);
    } catch (e) {
      setAgentError((e as Error).message);
    }
  };
  useEffect(() => {
    void load();
    void loadAgents();
  }, [id]);
  useEffect(() => {
    if (run) document.title = `${projectName(run.workdir)} · Orchestra`;
  }, [run?.workdir]);
  const loadLogs = async () => {
    const version = ++requestVersion.current;
    const target = stream;
    setLogError(null);
    setLogsLoading(true);
    try {
      const fetched = await api<LogEntry[]>(
        `/api/runs/${id}/logs${target ? `?taskId=${encodeURIComponent(target)}` : ""}`,
      );
      if (
        version !== requestVersion.current ||
        currentStream.current !== target
      )
        return;
      setLogs((live) => mergeLogs(fetched, live, target));
    } catch (e) {
      if (
        version === requestVersion.current &&
        currentStream.current === target
      )
        setLogError((e as Error).message);
    } finally {
      if (
        version === requestVersion.current &&
        currentStream.current === target
      )
        setLogsLoading(false);
    }
  };
  useEffect(() => {
    setLogs([]);
    void loadLogs();
    return () => {
      requestVersion.current++;
    };
  }, [id, stream]);
  const connection = useEvents(
    `run:${id}`,
    (ev) => {
      if (ev.type === "run") setRun(ev.run);
      if (ev.type === "task")
        setTasks((prev) =>
          prev.some((t) => t.id === ev.task.id)
            ? prev.map((t) => (t.id === ev.task.id ? ev.task : t))
            : [...prev, ev.task],
        );
      if (ev.type === "log" && ev.log.taskId === currentStream.current)
        setLogs((prev) =>
          mergeLogs([], [...prev, ev.log], currentStream.current),
        );
    },
    () => {
      void load();
      void loadLogs();
    },
  );
  /** Runs one action at a time; resolves to whether it succeeded. */
  const act = async (path: string, body: unknown = {}, method = "POST") => {
    if (lock.current) return false;
    lock.current = true;
    setBusy(path);
    setError(null);
    try {
      await api(path, { body, method });
      await load();
      return true;
    } catch (e) {
      setError((e as Error).message);
      return false;
    } finally {
      lock.current = false;
      setBusy(null);
    }
  };
  if (!run)
    return (
      <section className="page">
        <a className="back-link" href="#/runs">
          ← All runs
        </a>
        {error ? (
          <Notice retry={load}>{error}</Notice>
        ) : (
          <Loading label="Loading run" />
        )}
      </section>
    );
  const agentName = (agentId: string) =>
    agents.get(agentId)?.name ?? "Unavailable agent";
  const active = !FINISHED_RUN.includes(run.status);
  const streamLabel = stream
    ? (tasks.find((t) => t.id === stream)?.title ?? "Task")
    : "Director";
  // Superseded tasks were replaced by a recovery plan; they no longer count toward progress.
  const live = tasks.filter((t) => t.status !== "superseded");
  const done = live.filter((t) => t.status === "done").length;
  const team = [...agents.values()].filter((a) => !isDirector(a));
  const usage = formatUsage(run);
  const stuck = tasks.some((t) => t.status === "failed" || t.status === "blocked");
  const canComment = ["awaiting_approval", "failed", "completed"].includes(run.status);
  const sendReview = (comments: ReviewComment[], feedback: string) =>
    act(`/api/runs/${id}/revise`, { feedback, comments });
  const reviewCommand = `git -C ${shellQuote(run.workdir)} log --oneline --graph ${shellQuote(run.branch)}`;
  const mergeCommand = `git -C ${shellQuote(run.workdir)} merge ${shellQuote(run.branch)}`;
  const choose = (s: Stream) => {
    setPicked(s);
    setMobileView("output");
  };
  return (
    <section className="page run-page">
      <div className="run-breadcrumb">
        <a className="back-link" href="#/runs">
          ← All runs
        </a>
        <Connection state={connection} />
      </div>
      <div className="page-head">
        <div className="run-title">
          <p className="eyebrow">
            {projectName(run.workdir)}{" "}
            <span className="muted">/ {timeAgo(run.createdAt)}</span>
          </p>
          <h1 className="prompt-heading">{run.prompt.split("\n")[0]}</h1>
          <details className="brief-details">
            <summary>View full brief & project details</summary>
            <p className="pre-wrap">{run.prompt}</p>
            <dl>
              <dt>Project</dt>
              <dd className="mono">{run.workdir}</dd>
              <dt>Output branch</dt>
              <dd className="mono">{run.branch}</dd>
              <dt>Director</dt>
              <dd>{agentName(run.directorAgentId)}</dd>
              <dt>Run</dt>
              <dd className="mono">{run.id}</dd>
              <dt>Approvals</dt>
              <dd>{run.autonomous ? "Autonomous: the Director approves its own plans" : "You approve every plan"}</dd>
            </dl>
          </details>
        </div>
        <div className="head-side">
          <Status status={run.status} />
          <span className="run-mode">{run.autonomous ? "Autonomous" : "Supervised"}</span>
          {usage && (
            <span className="run-usage" title="Cost is reported by Claude Code; Codex reports tokens only.">
              {usage}
            </span>
          )}
          {active && (
            <CancelButton
              busy={!!busy}
              onCancel={() => act(`/api/runs/${id}/cancel`)}
            />
          )}
        </div>
      </div>
      {error && <Notice retry={load}>{error}</Notice>}
      {agentError && (
        <Notice retry={loadAgents}>
          Team names could not be loaded. {agentError}
        </Notice>
      )}
      {run.warning && <Notice kind="warn">{run.warning}</Notice>}
      {run.error && <Notice>{run.error}</Notice>}
      {run.status !== "awaiting_approval" && (
      <div className={`run-status-banner banner-${run.status}`}>
        <div>
          <p className="eyebrow">
            {run.status === "planning"
              ? "Planning"
              : run.plan?.stage === "definition"
                  ? "Definition"
                  : run.plan?.stage === "build"
                    ? "Build"
                    : run.plan?.stage === "fix"
                      ? `Fix round ${run.fixRounds}`
                      : "Run status"}
          </p>
          <h2>{statusCopy[run.status][0]}</h2>
          <p>{statusCopy[run.status][1]}</p>
        </div>
        <span className="banner-symbol" aria-hidden="true">
          {run.status === "completed"
            ? "✓"
            : run.status === "failed"
                ? "!"
                : "∿"}
        </span>
      </div>
      )}
      {run.status === "awaiting_approval" && run.plan && (
        <PlanReview
          run={run}
          finished={tasks}
          team={team}
          busy={busy}
          agentName={agentName}
          onApprove={() => act(`/api/runs/${id}/approve`)}
          onRevise={(feedback) => act(`/api/runs/${id}/revise`, { feedback })}
          onSave={(plan: Plan) => act(`/api/runs/${id}/plan`, plan, "PUT")}
        >
          {/* Before any task exists the board below is hidden, so the planning log lives here. */}
          {tasks.length === 0 && (
            <details className="director-notes">
              <summary>How the Director planned this</summary>
              <LogPanel
                visible
                title="Director"
                logs={logs.filter((l) => l.taskId === null)}
                loading={logsLoading}
                error={logError}
                retry={loadLogs}
              />
            </details>
          )}
        </PlanReview>
      )}
      {run.status === "failed" && (
        <div className="panel">
          <ReviseForm
            key={String(stuck)}
            label={stuck ? "Or ask the Director to re-plan the remaining work" : "Ask the Director to try again"}
            initial={stuck ? "Re-plan the work that failed." : "Please try again."}
            busy={!!busy}
            onRevise={(feedback) => act(`/api/runs/${id}/revise`, { feedback })}
          />
        </div>
      )}
      {run.status === "completed" && (
        <div className="completion-panel">
          <div className="section-head">
            <div>
              <p className="eyebrow">The handoff</p>
              <h2>Made together. Ready to review.</h2>
            </div>
            <CopyButton text={run.branch} label="Copy branch" />
          </div>
          <p>
            All tasks are merged into <code className="wrap">{run.branch}</code>
            . Review the changes before merging into your own branch, and comment on them to send the team back for fixes.
          </p>
          {run.report && (
            <div className="verification-report">
              <h3>The Director’s verification</h3>
              <p className="pre-wrap">{run.report}</p>
            </div>
          )}
          <div className="command-row">
            <code>{reviewCommand}</code>
            <CopyButton text={reviewCommand} label="Copy review command" />
          </div>
          <details>
            <summary>Merge after reviewing</summary>
            <div className="command-row">
              <code>{mergeCommand}</code>
              <CopyButton text={mergeCommand} label="Copy merge command" />
            </div>
          </details>
          {tasks.some((t) => t.summary) && (
            <div className="summary-grid">
              {tasks
                .filter((t) => t.summary)
                .map((t) => (
                  <details key={t.id}>
                    <summary>{t.title}</summary>
                    <p className="pre-wrap">{t.summary}</p>
                  </details>
                ))}
            </div>
          )}
        </div>
      )}
      {live.length > 0 && (
        <div className="progress-overview">
          <div className="progress-label">
            <strong>
              {done}
              <span> / {live.length}</span>
            </strong>
            <span>tasks completed</span>
          </div>
          <progress
            value={done}
            max={live.length}
            aria-label="Completed tasks"
          />
          <div className="progress-counts">
            {(["running", "pending", "failed", "blocked"] as const).map(
              (status) => {
                const count = tasks.filter((t) => t.status === status).length;
                return count ? (
                  <span key={status}>
                    <i className={`count-dot dot-${status}`} />
                    {count} {status === "pending" ? "waiting" : status}
                  </span>
                ) : null;
              },
            )}
          </div>
        </div>
      )}
      {!(run.status === "awaiting_approval" && tasks.length === 0) && (
      <>
      <div className="view-tabs" role="group" aria-label="Workspace section">
        <button aria-pressed={tab === "work"} onClick={() => setTab("work")}>
          Tasks & output
        </button>
        <button aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
        </button>
      </div>
      {tab === "changes" ? (
        <DiffView run={run} tasks={tasks} canComment={canComment} busy={!!busy} onSend={sendReview} />
      ) : (
      <>
      <div className="mobile-view-switch" aria-label="Workspace view">
        <button
          aria-pressed={mobileView === "tasks"}
          onClick={() => setMobileView("tasks")}
        >
          Tasks
        </button>
        <button
          aria-pressed={mobileView === "output"}
          onClick={() => setMobileView("output")}
        >
          Output
        </button>
      </div>
      <div className={`run-body view-${mobileView}`}>
        <div className="board">
          <div className="section-head">
            <h2>Work in motion</h2>
            <span className="hint">{tasks.length} tasks</span>
          </div>
          <button
            className={`director-stream ${stream === null ? "selected" : ""}`}
            onClick={() => choose(null)}
            aria-pressed={stream === null}
          >
            <span className="avatar small-avatar">D</span>
            <span>
              <strong>Director</strong>
              <small>
                {run.status === "planning"
                  ? "Shaping the plan…"
                  : "Planning output"}
              </small>
            </span>
            <span aria-hidden="true">↗</span>
          </button>
          <ol className="task-list">
            {tasks.map((t) => (
              <li
                key={t.id}
                className={`task task-${t.status} ${stream === t.id ? "selected" : ""}`}
              >
                <button
                  className="task-select"
                  onClick={() => choose(t.id)}
                  aria-pressed={stream === t.id}
                >
                  <span className="task-key mono">{t.key}</span>
                  <span className="task-title">{t.title}</span>
                  <span aria-hidden="true">↗</span>
                </button>
                <div className="task-byline">
                  <span>
                    {agentName(t.agentId)}
                    {t.reviewerId && <span className="muted"> · reviewed by {agentName(t.reviewerId)}</span>}
                  </span>
                  <Status status={t.status} />
                </div>
                <TaskFacts task={t} />
                {t.dependsOn.length > 0 && (
                  <p className="task-dependencies">
                    {t.status === "blocked" ? "Blocked by" : "After"}{" "}
                    {t.dependsOn
                      .map(
                        (key) =>
                          tasks.find((task) => task.key === key)?.title ?? key,
                      )
                      .join(", ")}
                  </p>
                )}
                {t.error && <p className="field-error pre-wrap">{t.error}</p>}
                <details>
                  <summary>Task details{t.summary ? " & summary" : ""}</summary>
                  <p className="pre-wrap">{t.description}</p>
                  <h4>Done when</h4>
                  <p className="pre-wrap">{t.acceptance}</p>
                  {t.summary && (
                    <>
                      <h4>Summary</h4>
                      <p className="pre-wrap">{t.summary}</p>
                    </>
                  )}
                </details>
                {t.status === "failed" && ["running", "failed"].includes(run.status) && (
                  <RetryControl
                    task={t}
                    team={team}
                    busy={busy}
                    onRetry={(body) => act(`/api/tasks/${t.id}/retry`, body)}
                  />
                )}
              </li>
            ))}
          </ol>
          {!tasks.length && (
            <div className="task-placeholder">
              <p>Your tasks will appear here.</p>
              <span>
                Once you approve a plan, follow each assignment as it moves
                forward.
              </span>
            </div>
          )}
        </div>
        <LogPanel
          key={stream ?? "director"}
          visible={mobileView === "output"}
          title={streamLabel}
          logs={logs.filter((l) => l.taskId === stream)}
          loading={logsLoading}
          error={logError}
          retry={loadLogs}
        />
      </div>
      </>
      )}
      </>
      )}
    </section>
  );
}
function TaskFacts({ task }: { task: Task }) {
  const usage = formatUsage(task);
  const facts = [
    task.startedAt && task.finishedAt
      ? formatDuration(task.finishedAt - task.startedAt)
      : task.startedAt && task.status === "running"
        ? `started ${timeAgo(task.startedAt)}`
        : null,
    task.iterations > 1 ? `attempt ${task.iterations}` : null,
    usage,
  ].filter(Boolean);
  return facts.length ? <p className="task-facts">{facts.join(" · ")}</p> : null;
}
/** Retry as is, or with instructions for the agent and optionally another assignee. */
function RetryControl({
  task,
  team,
  busy,
  onRetry,
}: {
  task: Task;
  team: Agent[];
  busy: string | null;
  onRetry: (body: { instructions?: string; agentId?: string }) => Promise<boolean>;
}) {
  const [open, setOpen] = useState(false);
  const [instructions, setInstructions] = useState("");
  const [agentId, setAgentId] = useState(task.agentId);
  const retrying = !!busy?.includes(task.id);
  if (!open)
    return (
      <div className="retry-actions">
        <Button variant="small" disabled={!!busy} onClick={() => void onRetry({})}>
          {retrying ? "Retrying…" : "Retry task ↻"}
        </Button>
        <Button variant="small ghost" disabled={!!busy} onClick={() => setOpen(true)}>
          Retry with instructions…
        </Button>
      </div>
    );
  return (
    <form
      className="revise retry-form"
      onSubmit={async (e: FormEvent) => {
        e.preventDefault();
        const body = { ...(instructions.trim() && { instructions: instructions.trim() }), ...(agentId !== task.agentId && { agentId }) };
        if (await onRetry(body)) setOpen(false);
      }}
    >
      <label>
        Instructions for the agent
        <textarea
          rows={3}
          maxLength={10000}
          autoFocus
          value={instructions}
          onChange={(e) => setInstructions(e.target.value)}
          placeholder="What should it do differently?"
        />
      </label>
      <label>
        Assignee
        <span className="hint">A new assignee starts over; the same one continues its conversation.</span>
        <select value={agentId} onChange={(e) => setAgentId(e.target.value)}>
          {team
            .filter((a) => a.id !== task.reviewerId)
            .map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} · {a.role}
              </option>
            ))}
        </select>
      </label>
      <div className="revise-actions">
        <Button type="button" variant="small ghost" disabled={!!busy} onClick={() => setOpen(false)}>
          Cancel
        </Button>
        <Button type="submit" variant="small" disabled={!!busy}>
          {retrying ? "Retrying…" : "Retry task ↻"}
        </Button>
      </div>
    </form>
  );
}
function CancelButton({
  onCancel,
  busy,
}: {
  onCancel: () => void;
  busy: boolean;
}) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <div className="cancel-confirm">
      <span>Stop this run and its agents?</span>
      <div className="actions">
        <Button variant="small danger" disabled={busy} onClick={onCancel}>
          Stop all agents
        </Button>
        <Button
          variant="small ghost"
          disabled={busy}
          onClick={() => setConfirming(false)}
        >
          Keep going
        </Button>
      </div>
    </div>
  ) : (
    <Button
      variant="small ghost"
      disabled={busy}
      onClick={() => setConfirming(true)}
    >
      Cancel run
    </Button>
  );
}
function LogPanel({
  title,
  logs,
  loading,
  error,
  retry,
  visible: shown,
}: {
  visible: boolean;
  title: string;
  logs: LogEntry[];
  loading: boolean;
  error: string | null;
  retry: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [follow, setFollow] = useState(true);
  const [filter, setFilter] = useState("all");
  const visible = logs.filter((l) => filter === "all" || l.kind === filter);
  const latest = () => {
    setFollow(true);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };
  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs, follow, filter, shown]);
  return (
    <aside className="log-panel" aria-label={`${title} output`}>
      <div className="log-header">
        <div>
          <p className="eyebrow">Live output</p>
          <h2>{title}</h2>
        </div>
        <span className="count-label">{logs.length} entries</span>
      </div>
      <div className="log-toolbar">
        <label>
          <span className="sr-only">Filter output</span>
          <select
            aria-label="Filter output"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          >
            <option value="all">All output</option>
            <option value="text">Messages</option>
            <option value="tool">Tools</option>
            <option value="result">Results</option>
            <option value="error">Errors</option>
            <option value="system">System</option>
          </select>
        </label>
        <label className="follow-control">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow output
        </label>
      </div>
      {error && <Notice retry={retry}>{error}</Notice>}
      <div
        ref={ref}
        className="log"
        role="log"
        aria-live="off"
        tabIndex={0}
        aria-label={`${title} log entries`}
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollHeight - el.scrollTop - el.clientHeight > 40 && follow)
            setFollow(false);
        }}
      >
        {loading && !logs.length ? (
          <Loading label="Loading output" />
        ) : !visible.length ? (
          <div className="log-empty">
            <span aria-hidden="true">_</span>
            <strong>
              {logs.length
                ? "No matching output"
                : "Waiting for the first note."}
            </strong>
            <p>
              {logs.length
                ? "Choose another output filter."
                : "Agent messages and tool activity will appear here."}
            </p>
          </div>
        ) : (
          visible.map((l) => (
            <div key={l.id} className={`log-line log-${l.kind}`}>
              <time>
                {new Date(l.ts).toLocaleTimeString([], { hour12: false })}
              </time>
              <span className="pre-wrap">{l.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="log-footer">
        <span>{follow ? "Following latest output" : "Auto-scroll paused"}</span>
        {!follow && (
          <Button variant="small ghost" onClick={latest}>
            Jump to latest ↓
          </Button>
        )}
      </div>
    </aside>
  );
}
