import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, LogEntry, Run, Task } from "../../shared/types.ts";
import { FINISHED_RUN } from "../../shared/types.ts";
import { api, timeAgo, useEvents } from "../api.ts";
import { Status } from "./Runs.tsx";

type Stream = string | null; // task id, or null for the director

export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [tasks, setTasks] = useState<Task[]>([]);
  const [agents, setAgents] = useState<Map<string, Agent>>(new Map());
  const [picked, setPicked] = useState<Stream | undefined>(undefined);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = () =>
    api<{ run: Run; tasks: Task[] }>(`/api/runs/${id}`)
      .then((d) => {
        setRun(d.run);
        setTasks(d.tasks);
      })
      .catch((e) => setError(e.message));

  useEffect(() => {
    load();
    api<Agent[]>("/api/agents").then((list) => setAgents(new Map(list.map((a) => [a.id, a]))));
  }, [id]);

  // Show the director while planning; otherwise follow the first running task until the user picks a stream.
  const directing = run?.status === "planning" || run?.status === "awaiting_approval";
  const stream: Stream =
    picked !== undefined ? picked : directing ? null : (tasks.find((t) => t.status === "running") ?? tasks[0])?.id ?? null;

  const loadLogs = () => {
    const q = stream ? `?taskId=${encodeURIComponent(stream)}` : "";
    api<LogEntry[]>(`/api/runs/${id}/logs${q}`).then((fetched) =>
      setLogs((live) => {
        const last = fetched.at(-1)?.id ?? 0;
        return [...fetched, ...live.filter((l) => l.taskId === stream && l.id > last)];
      }),
    );
  };
  useEffect(() => {
    setLogs([]);
    loadLogs();
  }, [id, stream]);

  useEvents(
    `run:${id}`,
    (ev) => {
      if (ev.type === "run") setRun(ev.run);
      if (ev.type === "task") {
        setTasks((prev) =>
          prev.some((t) => t.id === ev.task.id) ? prev.map((t) => (t.id === ev.task.id ? ev.task : t)) : [...prev, ev.task],
        );
      }
      if (ev.type === "log" && ev.log.taskId === stream) setLogs((prev) => [...prev, ev.log]);
    },
    () => {
      load();
      loadLogs();
    },
  );

  const act = async (path: string, body: unknown = {}) => {
    setError(null);
    try {
      await api(path, { body });
    } catch (e) {
      setError((e as Error).message);
    }
  };

  if (!run) return <section className="page">{error ? <p className="alert error">{error}</p> : <p className="muted">Loading…</p>}</section>;

  const agentName = (agentId: string) => agents.get(agentId)?.name ?? "unknown agent";
  const active = !FINISHED_RUN.includes(run.status);
  const streamLabel = stream ? tasks.find((t) => t.id === stream)?.title ?? "Task" : "Director";

  return (
    <section className="page">
      <div className="page-head">
        <div className="run-title">
          <p className="eyebrow">
            Run {run.id} · {timeAgo(run.createdAt)} · director {agentName(run.directorAgentId)}
          </p>
          <h1 className="prompt-heading">{run.prompt}</h1>
          <p className="muted small mono">
            {run.workdir} → <strong>{run.branch}</strong>
          </p>
        </div>
        <div className="head-side">
          <Status status={run.status} />
          {active && <CancelButton onCancel={() => act(`/api/runs/${id}/cancel`)} />}
        </div>
      </div>

      {error && <p className="alert error" role="alert">{error}</p>}
      {run.warning && <p className="alert warn">{run.warning}</p>}
      {run.error && <p className="alert error">{run.error}</p>}
      {run.status === "completed" && (
        <div className="alert success">
          All tasks are merged into <code>{run.branch}</code>. Review it, then merge it into your branch:
          <pre className="mono">git -C {run.workdir} log --oneline --graph {run.branch}{"\n"}git -C {run.workdir} merge {run.branch}</pre>
        </div>
      )}

      {run.status === "awaiting_approval" && run.plan && (
        <PlanReview run={run} buildStage={tasks.length > 0} agentName={agentName} onApprove={() => act(`/api/runs/${id}/approve`)} onRevise={(f) => act(`/api/runs/${id}/revise`, { feedback: f })} />
      )}
      {run.status === "failed" && tasks.every((t) => t.status === "done") && (
        <ReviseForm label="Ask the director to try again" initial={run.plan ? "" : "Please try again."} onRevise={(f) => act(`/api/runs/${id}/revise`, { feedback: f })} />
      )}

      <div className="run-body">
        <div className="board">
          <button className={`stream-pick director ${stream === null ? "selected" : ""}`} onClick={() => setPicked(null)} aria-pressed={stream === null}>
            <span className="task-title">Director</span>
            <span className="muted small">
              {run.status === "planning" ? (tasks.length ? "planning the build…" : "planning…") : "planning log"}
            </span>
          </button>
          {tasks.length > 0 && <h2 className="section-title">Tasks</h2>}
          <ol className="task-list">
            {tasks.map((t) => (
              <li key={t.id} className={`card task task-${t.status} ${stream === t.id ? "selected" : ""}`}>
                <button className="stream-pick" onClick={() => setPicked(t.id)} aria-pressed={stream === t.id}>
                  <span className="task-title">{t.title}</span>
                  <Status status={t.status} />
                </button>
                <p className="muted small">
                  <span className="mono">{t.key}</span> · {agentName(t.agentId)}
                  {t.dependsOn.length > 0 && <> · after {t.dependsOn.join(", ")}</>}
                </p>
                {t.error && <p className="task-error">{t.error}</p>}
                {t.summary && (
                  <details>
                    <summary>Summary</summary>
                    <p className="pre-wrap">{t.summary}</p>
                  </details>
                )}
                {t.status === "failed" && (
                  <button className="button small" onClick={() => act(`/api/tasks/${t.id}/retry`)}>Retry</button>
                )}
              </li>
            ))}
          </ol>
        </div>
        <LogPanel title={streamLabel} logs={logs} />
      </div>
    </section>
  );
}

function PlanReview(props: {
  run: Run;
  buildStage: boolean;
  agentName: (id: string) => string;
  onApprove: () => void;
  onRevise: (f: string) => void;
}) {
  const plan = props.run.plan!;
  const [title, note] =
    plan.stage === "definition"
      ? ["Stage 1 · Definition", "Spec and design first. When this is done the director reads the documents and plans the build for your approval."]
      : props.buildStage
        ? ["Stage 2 · Build", "Planned from the team’s spec and design, which are now in the project."]
        : ["The director’s plan", "A small goal, so the director planned the build directly."];
  return (
    <div className="card plan">
      <div>
        <p className="eyebrow">{title}</p>
        <h2>The director’s plan</h2>
        <p className="muted small">{note}</p>
      </div>
      <p className="pre-wrap">{plan.summary}</p>
      <table>
        <thead>
          <tr>
            <th scope="col">Task</th>
            <th scope="col">Agent</th>
            <th scope="col">After</th>
            <th scope="col">Done when</th>
          </tr>
        </thead>
        <tbody>
          {plan.tasks.map((t) => (
            <tr key={t.id}>
              <td>
                <details>
                  <summary>
                    <strong>{t.title}</strong> <span className="muted mono small">{t.id}</span>
                  </summary>
                  <p className="pre-wrap small">{t.description}</p>
                </details>
              </td>
              <td>{props.agentName(t.agentId)}</td>
              <td className="mono small">{t.dependsOn.join(", ") || "—"}</td>
              <td className="small pre-wrap">{t.acceptanceCriteria}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="actions">
        <button className="button primary" onClick={props.onApprove}>Approve and start</button>
      </div>
      <ReviseForm label="Request changes" initial="" onRevise={props.onRevise} />
    </div>
  );
}

function ReviseForm(props: { label: string; initial: string; onRevise: (feedback: string) => void }) {
  const [feedback, setFeedback] = useState(props.initial);
  const submit = (e: FormEvent) => {
    e.preventDefault();
    props.onRevise(feedback);
  };
  return (
    <form className="revise" onSubmit={submit}>
      <label>
        {props.label}
        <textarea required rows={2} value={feedback} onChange={(e) => setFeedback(e.target.value)} placeholder="e.g. Use Postgres instead of SQLite, and give the tests to the QA agent" />
      </label>
      <button className="button" type="submit">Send to director</button>
    </form>
  );
}

function CancelButton({ onCancel }: { onCancel: () => void }) {
  const [confirming, setConfirming] = useState(false);
  return confirming ? (
    <span className="actions">
      <button className="button small danger" onClick={onCancel}>Stop all agents</button>
      <button className="button small ghost" onClick={() => setConfirming(false)}>Keep going</button>
    </span>
  ) : (
    <button className="button small ghost" onClick={() => setConfirming(true)}>Cancel run</button>
  );
}

function LogPanel({ title, logs }: { title: string; logs: LogEntry[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useLayoutEffect(() => {
    if (stick.current && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs]);
  return (
    <aside className="log-panel" aria-label={`${title} log`}>
      <h2 className="section-title">{title}</h2>
      <div
        ref={ref}
        className="log"
        role="log"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {logs.length === 0 && <p className="muted">No output yet.</p>}
        {logs.map((l) => (
          <div key={l.id} className={`log-line log-${l.kind}`}>
            <time className="muted">{new Date(l.ts).toLocaleTimeString()}</time>
            <span className="pre-wrap">{l.text}</span>
          </div>
        ))}
      </div>
    </aside>
  );
}
