import { useEffect, useLayoutEffect, useRef, useState, type FormEvent } from "react";
import type { Agent, LogEntry, Plan, ReviewComment, Run, Task } from "../../shared/types.ts";
import { FINISHED_RUN, isDirector } from "../../shared/types.ts";
import { api, navigate, setTitle, timeAgo, useEvents } from "../api.ts";
import { DiffView, emptyReview, type ReviewDraft } from "../components/DiffView.tsx";
import { PlanReview, ReviseForm } from "../components/PlanReview.tsx";
import { LessonsPicker } from "../components/ProjectMemory.tsx";
import {
  Button,
  Connection,
  CopyButton,
  ErrorDetails,
  Loading,
  Notice,
} from "../components/UI.tsx";
import {
  activeRunTime,
  bounceReason,
  formatDuration,
  formatUsage,
  groupLogs,
  logText,
  mergeLogs,
  nextAction,
  projectName,
  proposedLessons,
  runPhase,
  shellQuote,
  taskSteps,
  verifiedResult,
  type NextAction,
} from "../model.ts";
import { Status } from "./Runs.tsx";
type Stream = string | null;
export function RunPage({ id }: { id: string }) {
  const [run, setRun] = useState<Run | null>(null);
  const [activity, setActivity] = useState<LogEntry[]>([]);
  const [clock, setClock] = useState(Date.now());
  useEffect(() => { const timer = setInterval(() => setClock(Date.now()), 1000); return () => clearInterval(timer); }, []);
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
  const [showFinished, setShowFinished] = useState(false);
  const [review, setReview] = useState<ReviewDraft>(emptyReview);
  const requestVersion = useRef(0);
  const directing =
    run?.status === "planning" || run?.status === "awaiting_approval";
  const stream: Stream =
    picked !== undefined
      ? picked
      : directing
        ? null
        : ((tasks.find((t) => t.status === "running") ?? tasks.find((t) => t.status === "pending"))?.id ?? null);
  const currentStream = useRef(stream);
  currentStream.current = stream;
  const load = async () => {
    try {
      const d = await api<{ run: Run; tasks: Task[] }>(`/api/runs/${id}`);
      setRun(d.run);
      setTasks(d.tasks);
      const entries = await api<LogEntry[]>(`/api/runs/${id}/activity`);
      setActivity((previous) => [...new Map([...entries, ...previous].map((e) => [e.id, e])).values()].sort((a, b) => a.id - b.id).slice(-300));
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
    if (run) setTitle({ base: `${projectName(run.workdir)} · Orchestra` });
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
      if (ev.type === "log" && ["system", "error"].includes(ev.log.kind)) setActivity((previous) => [...new Map([...previous, ev.log].map((entry) => [entry.id, entry])).values()].sort((a, b) => a.id - b.id).slice(-300));
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
  const remove = async (deleteBranch: boolean) => {
    if (lock.current) return;
    lock.current = true;
    setBusy("delete");
    setError(null);
    try {
      const { remaining } = await api<{ remaining: string[] }>(`/api/runs/${id}`, { method: "DELETE", body: { deleteBranch } });
      if (!remaining.length) return navigate("/runs");
      setError(`The run was deleted, but git kept ${remaining.join(", ")}. It may be checked out somewhere; delete it yourself when you're done.`);
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
  const progressTasks = run.continuous && run.cycle > 1 ? live.filter((t) => t.cycle === run.cycle) : live;
  const done = progressTasks.filter((t) => t.status === "done").length;
  const unfinished = tasks.filter((t) => !["done", "superseded", "cancelled"].includes(t.status));
  const finished = tasks.filter((t) => ["done", "superseded", "cancelled"].includes(t.status));
  const visibleTasks = [...unfinished, ...(showFinished ? finished : [])];
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
  const action = nextAction(run, tasks);
  const canResume = run.status === "paused" || run.status === "failed" && run.pauseReason === "Interrupted by server restart";
  const phase = runPhase(run);
  const phases = ["plan", "build", "check", "ready"] as const;
  const improving = run.continuous && run.cycle > 1;
  const phaseLabel = { plan: "Plan", build: improving ? "Improve" : "Build", check: "Final checks", ready: "Ready" };
  const stageLabel = `${improving ? `Round ${run.cycle} · ` : ""}${phaseLabel[phase]}`;
  const verified = verifiedResult(run);
  /** Brings the control the action bar points at into view and focus; it never acts by itself. */
  const go = (target: NonNullable<NextAction["target"]>) => {
    if (target === "changes") setTab("changes");
    if (target === "retry") {
      setTab("work");
      setMobileView("tasks");
    }
    const failedKey = tasks.find((t) => t.status === "failed")?.key;
    const [id, focus] = {
      plan: ["plan-review", null],
      resume: ["resume", "button[type=submit]"],
      replan: ["replan", "textarea"],
      retry: [`task-${failedKey}`, ".retry-actions button"],
      changes: ["workspace-tabs", "button[aria-pressed=true]"],
    }[target];
    // After React commits the tab switch; requestAnimationFrame would stall in a background tab.
    setTimeout(() => {
      const el = document.getElementById(id!);
      const reduce = matchMedia("(prefers-reduced-motion: reduce)").matches;
      el?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "start" });
      (focus ? el?.querySelector<HTMLElement>(focus) : el)?.focus({ preventScroll: true });
    }, 0);
  };
  return (
    <section className="page run-page">
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
          <Connection state={connection} />
          <Status status={run.status} />
          <span className="run-mode">{run.continuous ? "Continuous" : run.autonomous ? "Autonomous" : "Supervised"}</span>
          {run.limits && (
            <span className="run-budget" aria-label="Run budget">
              Cycle {run.cycle} · {run.agentCalls}/{run.limits.maxAgentCalls} calls ·{" "}
              {formatDuration(Math.max(0, run.limits.maxDurationMs - activeRunTime(run, clock)))} left
            </span>
          )}
          {usage && (
            <span className="run-usage" title="Cost is reported by Claude Code; Codex reports tokens only.">
              {usage}
            </span>
          )}
          <div className="head-actions">
          {["running", "planning", "awaiting_approval"].includes(run.status) && <Button variant="small ghost" disabled={!!busy} onClick={() => void act(`/api/runs/${id}/pause`)}>{improving ? "Pause improvements" : "Pause"}</Button>}
          {active && (
            <CancelButton
              busy={!!busy}
              onCancel={() => act(`/api/runs/${id}/cancel`)}
            />
          )}
          {(!active || run.status === "paused") && <DeleteRun branch={run.branch} busy={!!busy} onDelete={remove} />}
          </div>
        </div>
      </div>
      {error && <Notice retry={load}>{error}</Notice>}
      {agentError && (
        <Notice retry={loadAgents}>
          Team names could not be loaded. {agentError}
        </Notice>
      )}
      {run.warning && <Notice kind="warn">{run.warning}</Notice>}
      {run.error && !canResume && <Notice><ErrorDetails text={run.error} /></Notice>}
      {canResume
        ? <ResumeControl key={`${run.id}-${run.activeElapsedMs}`} run={run} action={action} busy={!!busy} onResume={(body) => act(`/api/runs/${id}/resume`, body)} />
        : <ActionBar action={action} stage={stageLabel} context={improving && verified ? `${verified.cycle === 1 ? "The initial build" : `Round ${verified.cycle}`} is verified. Continuous improvement is on, so the team is working on round ${run.cycle}.` : undefined} onGo={go} />}
      {!canResume && run.status !== "cancelled" && <ol className="run-phases" aria-label="Run progress">
        {phases.map((step, index) => <li key={step} aria-current={step === phase ? "step" : undefined} className={index < phases.indexOf(phase) ? "phase-complete" : ""}><span aria-hidden="true">{index < phases.indexOf(phase) ? "✓" : index + 1}</span>{phaseLabel[step]}</li>)}
      </ol>}
      <div className="autonomy-monitor">
      {verified && run.status !== "completed" && <details className="panel verified-result"><summary>{verified.cycle === 1 ? "Initial build verified" : `Round ${verified.cycle} verified`} · view report</summary><p className="pre-wrap">{verified.report}</p></details>}
      {run.plan && !canResume && <details className="panel"><summary>Current plan · {run.plan.tasks.length} tasks</summary><p className="pre-wrap">{run.plan.summary}</p></details>}
      {["planning", "running", "awaiting_approval"].includes(run.status) && (
        <GuidanceNote busy={!!busy} onSend={(text) => act(`/api/runs/${id}/guidance`, { text })} />
      )}
      {canResume && <details className="panel"><summary>Technical details</summary>
        <p>Pause reason: {run.pauseReason ?? "Paused by user"}</p>
        {run.error && <ErrorDetails text={run.error} />}
        {run.report && <><h3>Saved report</h3><p className="pre-wrap">{run.report}</p></>}
        {run.plan && <><h3>Current plan</h3><p className="pre-wrap">{run.plan.summary}</p></>}
      </details>}
      {run.history.length > 0 && <details className="panel cycle-history"><summary>Cycle history · {run.history.length} checkpoints</summary>
        {run.history.map((entry, index) => <article key={index}><h3>Cycle {entry.cycle} · {entry.report ? "Verification" : entry.plan?.stage}</h3><p className="pre-wrap">{entry.report ?? entry.plan?.summary}</p>
          {entry.plan && <ul>{entry.plan.tasks.map((task) => <li key={task.id}>{task.title}</li>)}</ul>}
        </article>)}
      </details>}
      {activity.length > 0 && <details className="panel activity-feed"><summary>Team activity <span className="muted">· {activity.at(-1)!.text.split("\n")[0]}</span></summary><ol>{activity.slice(-30).map((entry) => <li key={entry.id}><time>{new Date(entry.ts).toLocaleTimeString()}</time><span className="pre-wrap">{entry.taskId ? `${tasks.find((t) => t.id === entry.taskId)?.key ?? "Task"}: ` : ""}{entry.text}</span></li>)}</ol></details>}
      </div>
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
        <div className="panel" id="replan">
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
          {proposedLessons(run).length > 0 && <LessonsPicker workdir={run.workdir} lessons={proposedLessons(run)} />}
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
      {progressTasks.length > 0 && (
        <div className="progress-overview">
          <div className="progress-label">
            <strong>
              {done}
              <span> / {progressTasks.length}</span>
            </strong>
            <span>{improving ? `tasks completed in round ${run.cycle}` : "tasks completed"}</span>
          </div>
          <progress
            value={done}
            max={progressTasks.length}
            aria-label={improving ? `Completed tasks in round ${run.cycle}` : "Completed tasks"}
          />
          <div className="progress-counts">
            {(["running", "pending", "failed", "blocked"] as const).map(
              (status) => {
                const count = progressTasks.filter((t) => t.status === status).length;
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
      <div className="view-tabs" id="workspace-tabs" role="group" aria-label="Workspace section">
        <button aria-pressed={tab === "work"} onClick={() => setTab("work")}>
          Tasks & output
        </button>
        <button aria-pressed={tab === "changes"} onClick={() => setTab("changes")}>
          Changes
          {review.comments.length > 0 && <span className="tab-count"> · {review.comments.length} unsent</span>}
        </button>
      </div>
      {tab === "changes" ? (
        <DiffView run={run} tasks={tasks} canComment={canComment} busy={!!busy} draft={review} onDraft={setReview} onSend={sendReview} />
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
            <h2>Current work</h2>
            <span className="hint">{unfinished.length} unfinished</span>
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
                  ? action.title
                  : "Planning output"}
              </small>
            </span>
            <span aria-hidden="true">↗</span>
          </button>
          <ol className="task-list">
            {visibleTasks.map((t) => (
              <li
                key={t.id}
                id={`task-${t.key}`}
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
                <TaskFacts task={t} hasVerify={!!run.plan?.verify || !!t.handoff?.check} />
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
                {t.error && <ErrorDetails text={t.error} />}
                <details>
                  <summary>Task details{t.summary ? " & summary" : ""}</summary>
                  <p className="pre-wrap">{t.description}</p>
                  <h4>Done when</h4>
                  <p className="pre-wrap">{t.acceptance}</p>
                  {t.handoff && <div className="task-handoff"><h4>Handoff evidence</h4>
                    <p>Changed files: {t.handoff.files.join(", ") || "None"}</p>
                    <p>Checks: {t.handoff.check ? `${t.handoff.check.ok ? "Passed" : "Failed"} · ${t.handoff.check.command}` : "No automatic check recorded"}</p>
                    <p>Review: {t.handoff.review?.verdict ?? "No review recorded"}</p>
                    {t.handoff.check && <details><summary>Check output</summary><pre>{t.handoff.check.output}</pre></details>}
                    {t.handoff.review?.findings && <p className="pre-wrap">{t.handoff.review.findings}</p>}
                    {t.mergeCommit && <p className="mono">Merge: {t.mergeCommit}</p>}
                  </div>}
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
          {tasks.length > 0 && unfinished.length === 0 && <p className="hint">All assigned tasks are finished.{run.status === "planning" ? ` ${action.title}.` : ""}</p>}
          {finished.length > 0 && <Button variant="small ghost" aria-expanded={showFinished} onClick={() => setShowFinished(!showFinished)}>{showFinished ? "Hide" : "Show"} completed and replaced tasks ({finished.length})</Button>}
          {picked !== undefined && <Button variant="small ghost" onClick={() => setPicked(undefined)}>Follow current activity</Button>}
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
function TaskFacts({ task, hasVerify }: { task: Task; hasVerify: boolean }) {
  const usage = formatUsage(task);
  const facts = [
    `cycle ${task.cycle}`,
    task.startedAt && task.finishedAt
      ? formatDuration(task.finishedAt - task.startedAt)
      : task.startedAt && task.status === "running"
        ? `started ${timeAgo(task.startedAt)}`
        : null,
    task.iterations > 1 ? `attempt ${task.iterations}` : null,
    usage,
  ].filter(Boolean);
  const inFlight = task.status === "running" || task.status === "failed";
  const bounce = inFlight && task.iterations > 1 ? bounceReason(task) : null;
  return (
    <>
      {inFlight && (
        <ol className="task-steps" aria-label="Task progress">
          {taskSteps(task, hasVerify).map((step) => (
            <li key={step.phase} className={`step-${step.state}`} aria-current={step.state === "current" ? "step" : undefined}>
              {step.state === "done" ? "✓ " : ""}
              {step.label}
              {step.state === "current" && <span className="sr-only"> (current)</span>}
            </li>
          ))}
        </ol>
      )}
      {facts.length > 0 && <p className="task-facts">{facts.join(" · ")}</p>}
      {bounce && <p className="task-bounce">{bounce}</p>}
    </>
  );
}
function ActionBar({ action, stage, context, onGo }: { action: NextAction; stage: string; context?: string; onGo: (target: NonNullable<NextAction["target"]>) => void }) {
  return (
    <div className={`action-bar tone-${action.tone}`} role="status">
      <div>
        <p className="eyebrow">{stage}</p>
        {context && <p className="improvement-context">{context}</p>}
        <h2>{action.title}</h2>
        <p>{action.detail}</p>
      </div>
      {action.target && (
        <Button variant={action.tone === "info" ? "ghost" : "primary"} onClick={() => onGo(action.target!)}>
          {action.label} <span aria-hidden="true">↓</span>
        </Button>
      )}
    </div>
  );
}
/** Steers the team without pausing it: the note joins the guidance every later agent call receives. */
function GuidanceNote({ busy, onSend }: { busy: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  return (
    <details className="panel guidance-note">
      <summary>Send a note to the team</summary>
      <form
        onSubmit={async (e) => {
          e.preventDefault();
          if (text.trim() && (await onSend(text.trim()))) setText("");
        }}
      >
        <label>
          <span className="sr-only">Note for the team</span>
          <textarea rows={2} maxLength={10000} value={text} onChange={(e) => setText(e.target.value)} placeholder="e.g. Use SQLite rather than a JSON file." />
        </label>
        <p className="hint">Applies from the next agent call; an agent already working sees it at its next step.</p>
        <Button variant="small" type="submit" disabled={busy || !text.trim()}>
          Send note
        </Button>
      </form>
    </details>
  );
}
function ResumeControl({ run, action, busy, onResume }: { run: Run; action: NextAction; busy: boolean; onResume: (body: object) => Promise<boolean> }) {
  const [guidance, setGuidance] = useState("");
  const [minutes, setMinutes] = useState(Math.ceil((run.limits?.maxDurationMs ?? 7_200_000) / 60_000));
  const [calls, setCalls] = useState(run.limits?.maxAgentCalls ?? 40);
  const budgetExhausted = !!run.limits && (run.activeElapsedMs >= run.limits.maxDurationMs || run.agentCalls >= run.limits.maxAgentCalls);
  const validBudget = !run.limits || minutes * 60_000 > run.activeElapsedMs && calls > run.agentCalls && minutes * 60_000 >= run.limits.maxDurationMs && calls >= run.limits.maxAgentCalls;
  return <form id="resume" className="panel resume-form" aria-labelledby="resume-title" onSubmit={(e) => {
    e.preventDefault();
    if (!validBudget || busy) return;
    void onResume({ ...(guidance.trim() && { guidance: guidance.trim() }), ...(run.limits && { limits: { maxDurationMs: minutes * 60_000, maxAgentCalls: calls } }) });
  }}>
    <div className="resume-summary"><p className="eyebrow">Progress saved</p><h2 id="resume-title">{action.title}</h2><p>{action.detail}</p></div>
    <details className="resume-options"><summary>Add instructions (optional)</summary>
      <label>Anything the team should do differently?<textarea rows={3} maxLength={10000} value={guidance} onChange={(e) => setGuidance(e.target.value)} placeholder="e.g. Focus on finishing the existing features." /></label>
    </details>
    {run.limits && <details className="resume-options" open={budgetExhausted || undefined}><summary>{budgetExhausted ? "Increase the budget to continue" : "Adjust budget"}</summary>
      <p className="hint">Used: {formatDuration(run.activeElapsedMs)} and {run.agentCalls} agent calls. These totals carry forward.</p>
      <fieldset className="run-limits"><legend>Total budget</legend><label>Active minutes<input type="number" required min={Math.max(Math.ceil(run.limits.maxDurationMs / 60_000), Math.floor(run.activeElapsedMs / 60_000) + 1)} max={1440} value={minutes} onChange={(e) => setMinutes(Number(e.target.value))} /></label><label>Agent calls<input type="number" required min={Math.max(run.limits.maxAgentCalls, run.agentCalls + 1)} max={500} value={calls} onChange={(e) => setCalls(Number(e.target.value))} /></label></fieldset>
    </details>}
    <div className="resume-submit"><Button variant="primary" disabled={busy || !validBudget} type="submit">{busy ? "Continuing…" : action.label}</Button><p className="hint">{run.quotaWait ? "Checks account availability before continuing." : "Keeps completed work and uses the remaining budget."}</p></div>
  </form>;
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
/** Two-step delete; the run branch holds the team's work, so deleting it is a separate, unchecked choice. */
function DeleteRun({ branch, busy, onDelete }: { branch: string; busy: boolean; onDelete: (deleteBranch: boolean) => void }) {
  const [confirming, setConfirming] = useState(false);
  const [withBranch, setWithBranch] = useState(false);
  if (!confirming)
    return (
      <Button variant="small ghost" disabled={busy} onClick={() => setConfirming(true)}>
        Delete run…
      </Button>
    );
  return (
    <div className="cancel-confirm delete-run">
      <span>Delete this run, its output and its worktrees?</span>
      <label>
        <input type="checkbox" checked={withBranch} onChange={(e) => setWithBranch(e.target.checked)} /> Also delete branch{" "}
        <code className="wrap">{branch}</code>
      </label>
      <div className="actions">
        <Button variant="small danger" disabled={busy} onClick={() => onDelete(withBranch)}>
          {busy ? "Deleting…" : "Delete run"}
        </Button>
        <Button variant="small ghost" disabled={busy} onClick={() => setConfirming(false)}>
          Keep
        </Button>
      </div>
    </div>
  );
}
function LogLine({ entry }: { entry: LogEntry }) {
  return (
    <div className={`log-line log-${entry.kind}`}>
      <time>{new Date(entry.ts).toLocaleTimeString([], { hour12: false })}</time>
      <span className="pre-wrap">{entry.text}</span>
    </div>
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
  const [query, setQuery] = useState("");
  const needle = query.trim().toLowerCase();
  const visible = logs.filter((l) => (filter === "all" || l.kind === filter) && (!needle || l.text.toLowerCase().includes(needle)));
  // Collapsing tool calls only helps when they sit between messages.
  const items = filter === "tool" || needle ? visible.map((entry) => ({ kind: "entry" as const, entry })) : groupLogs(visible);
  const download = () => {
    const url = URL.createObjectURL(new Blob([logText(logs)], { type: "text/plain" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `${title.replace(/[^\w.-]+/g, "-").replace(/^-|-$/g, "") || "output"}.log`;
    a.click();
    URL.revokeObjectURL(url);
  };
  const latest = () => {
    setFollow(true);
    if (ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  };
  useLayoutEffect(() => {
    if (follow && ref.current) ref.current.scrollTop = ref.current.scrollHeight;
  }, [logs, follow, filter, query, shown]);
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
        <label className="log-search">
          <span className="sr-only">Search output</span>
          <input type="search" placeholder="Search output…" value={query} onChange={(e) => setQuery(e.target.value)} />
        </label>
        <label className="follow-control">
          <input
            type="checkbox"
            checked={follow}
            onChange={(e) => setFollow(e.target.checked)}
          />
          Follow output
        </label>
        <Button variant="small ghost" disabled={!logs.length} onClick={download}>
          Download
        </Button>
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
          items.map((item) =>
            item.kind === "tools" ? (
              <details key={item.entries[0]!.id} className="log-tools">
                <summary>
                  <time>{new Date(item.entries[0]!.ts).toLocaleTimeString([], { hour12: false })}</time>
                  <span>{item.entries.length} tool calls</span>
                </summary>
                {item.entries.map((l) => <LogLine key={l.id} entry={l} />)}
              </details>
            ) : (
              <LogLine key={item.entry.id} entry={item.entry} />
            ),
          )
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
