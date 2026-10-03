import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
} from "react";
import type { Agent, LogEntry, Run, Task } from "../../shared/types.ts";
import { FINISHED_RUN } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";
import {
  Button,
  Connection,
  CopyButton,
  Loading,
  Notice,
} from "../components/UI.tsx";
import { mergeLogs, projectName, shellQuote } from "../model.ts";
import { Status } from "./Runs.tsx";
type Stream = string | null;
const statusCopy: Record<Run["status"], [string, string]> = {
  planning: [
    "A good plan starts here.",
    "Your Director is shaping the work and choosing the right team.",
  ],
  awaiting_approval: [
    "Your direction makes the difference.",
    "Review the plan below. Approve it to start, or tell your Director what to change.",
  ],
  running: [
    "Your team is on it.",
    "Tasks start as their dependencies finish. Select any task to follow its output.",
  ],
  completed: [
    "Ready for your final touch.",
    "The team’s work is collected on one branch, ready for you to review.",
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
  const act = async (path: string, body: unknown = {}) => {
    if (lock.current) return;
    lock.current = true;
    setBusy(path);
    setError(null);
    try {
      await api(path, { body });
      await load();
    } catch (e) {
      setError((e as Error).message);
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
  const done = tasks.filter((t) => t.status === "done").length;
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
            </dl>
          </details>
        </div>
        <div className="head-side">
          <Status status={run.status} />
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
      <div className={`run-status-banner banner-${run.status}`}>
        <div>
          <p className="eyebrow">
            {run.status === "planning"
              ? "Planning"
              : run.status === "awaiting_approval"
                ? "Your review"
                : run.plan?.stage === "definition"
                  ? "Definition"
                  : run.plan?.stage === "build"
                    ? "Build"
                    : "Run status"}
          </p>
          <h2>{statusCopy[run.status][0]}</h2>
          <p>{statusCopy[run.status][1]}</p>
        </div>
        <span className="banner-symbol" aria-hidden="true">
          {run.status === "completed"
            ? "✓"
            : run.status === "awaiting_approval"
              ? "↗"
              : run.status === "failed"
                ? "!"
                : "∿"}
        </span>
      </div>
      {run.status === "awaiting_approval" && run.plan && (
        <PlanReview
          run={run}
          busy={busy}
          agentName={agentName}
          onApprove={() => act(`/api/runs/${id}/approve`)}
          onRevise={(feedback) => act(`/api/runs/${id}/revise`, { feedback })}
        />
      )}
      {run.status === "failed" && tasks.every((t) => t.status === "done") && (
        <div className="panel">
          <ReviseForm
            label="Ask the Director to try again"
            initial="Please try again."
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
            . Review the commits before merging into your own branch.
          </p>
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
      {tasks.length > 0 && (
        <div className="progress-overview">
          <div className="progress-label">
            <strong>
              {done}
              <span> / {tasks.length}</span>
            </strong>
            <span>tasks completed</span>
          </div>
          <progress
            value={done}
            max={tasks.length}
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
                  <span>{agentName(t.agentId)}</span>
                  <Status status={t.status} />
                </div>
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
                {t.status === "failed" && (
                  <Button
                    variant="small"
                    disabled={!!busy}
                    onClick={() => act(`/api/tasks/${t.id}/retry`)}
                  >
                    {busy?.includes(t.id) ? "Retrying…" : "Retry task ↻"}
                  </Button>
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
    </section>
  );
}
function PlanReview({
  run,
  agentName,
  busy,
  onApprove,
  onRevise,
}: {
  run: Run;
  agentName: (id: string) => string;
  busy: string | null;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
}) {
  const plan = run.plan!;
  return (
    <section className="plan panel">
      <div className="section-head">
        <div>
          <p className="eyebrow">
            {plan.stage === "definition" ? "Definition plan" : "Build plan"}
          </p>
          <h2>The plan, ready for your input.</h2>
        </div>
        <span className="count-label">{plan.tasks.length} tasks</span>
      </div>
      <p className="pre-wrap plan-summary">{plan.summary}</p>
      {plan.stage === "definition" && (
        <p className="quiet-note">
          This stage defines the product and design. You’ll review a separate
          build plan once the groundwork is complete.
        </p>
      )}
      <div className="plan-columns" aria-hidden="true">
        <span>Task & outcome</span>
        <span>Assigned to</span>
        <span>Depends on</span>
      </div>
      <ol className="plan-tasks">
        {plan.tasks.map((t, index) => (
          <li key={t.id}>
            <div className="plan-task-main">
              <span className="plan-number">
                {String(index + 1).padStart(2, "0")}
              </span>
              <div>
                <h3>{t.title}</h3>
                <p className="acceptance pre-wrap">{t.acceptanceCriteria}</p>
                <details>
                  <summary>
                    Read task brief <span className="mono">{t.id}</span>
                  </summary>
                  <p className="pre-wrap">{t.description}</p>
                </details>
              </div>
            </div>
            <div className="plan-assignee">
              <span className="mobile-label">Assigned to</span>
              <span className="mini-avatar">
                {agentName(t.agentId).slice(0, 1)}
              </span>
              {agentName(t.agentId)}
            </div>
            <div className="plan-dependency">
              <span className="mobile-label">Depends on</span>
              {t.dependsOn.length ? (
                t.dependsOn.map((dep) => (
                  <span
                    key={dep}
                    title={plan.tasks.find((task) => task.id === dep)?.title}
                  >
                    {dep}
                  </span>
                ))
              ) : (
                <span className="muted">Ready to start</span>
              )}
            </div>
          </li>
        ))}
      </ol>
      <div className="approval-bar">
        <p>Your approval starts this stage’s tasks.</p>
        <Button variant="primary" disabled={!!busy} onClick={onApprove}>
          {busy?.endsWith("approve") ? "Starting the team…" : "Approve & start"}
          <span aria-hidden="true">→</span>
        </Button>
      </div>
      <details className="revision-disclosure">
        <summary>Request changes to the plan</summary>
        <ReviseForm
          label="What would you like to change?"
          initial=""
          busy={!!busy}
          onRevise={onRevise}
        />
      </details>
    </section>
  );
}
function ReviseForm({
  label,
  initial,
  busy,
  onRevise,
}: {
  label: string;
  initial: string;
  busy: boolean;
  onRevise: (feedback: string) => void;
}) {
  const [feedback, setFeedback] = useState(initial);
  return (
    <form
      className="revise"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy && feedback.trim()) onRevise(feedback.trim());
      }}
    >
      <label>
        {label}
        <textarea
          required
          rows={3}
          maxLength={10000}
          disabled={busy}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Describe what to adjust, add, or simplify…"
        />
      </label>
      <Button disabled={busy || !feedback.trim()} type="submit">
        {busy ? "Sending…" : "Send to Director"}
      </Button>
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
