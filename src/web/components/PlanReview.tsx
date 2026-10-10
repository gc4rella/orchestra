import { useState, type FormEvent, type ReactNode } from "react";
import type { Agent, Plan, PlanTask, Run, Task } from "../../shared/types.ts";
import { planLabel, planSteps } from "../model.ts";
import { Button } from "./UI.tsx";

export function PlanReview({
  run,
  finished,
  team,
  agentName,
  busy,
  onApprove,
  onRevise,
  onSave,
  children,
}: {
  run: Run;
  /** Tasks of earlier plans; a new plan may depend on the finished ones. */
  finished: Task[];
  /** Members the plan may staff: everyone but the Director. */
  team: Agent[];
  agentName: (id: string) => string;
  busy: string | null;
  onApprove: () => void;
  onRevise: (feedback: string) => void;
  /** Resolves to whether the edited plan was saved. */
  onSave: (plan: Plan) => Promise<boolean>;
  children?: ReactNode;
}) {
  const plan = run.plan!;
  const [expanded, setExpanded] = useState(false);
  const [revising, setRevising] = useState(false);
  const [draft, setDraft] = useState<Plan | null>(null);
  const steps = planSteps(plan.tasks);
  const number = new Map(plan.tasks.map((t, i) => [t.id, String(i + 1).padStart(2, "0")]));
  const people = new Set(plan.tasks.map((t) => t.agentId)).size;
  const longSummary = plan.summary.length > 360;
  const dependency = (key: string) => {
    const inPlan = plan.tasks.find((t) => t.id === key);
    if (inPlan) return { label: number.get(key)!, title: inPlan.title };
    return { label: "✓", title: `${finished.find((t) => t.key === key)?.title ?? key} (done)` };
  };
  if (draft) {
    return (
      <PlanEditor
        draft={draft}
        team={team}
        busy={!!busy}
        onChange={setDraft}
        onCancel={() => setDraft(null)}
        onSave={async () => {
          if (await onSave(draft)) setDraft(null);
        }}
      />
    );
  }
  return (
    <section id="plan-review" tabIndex={-1} className="plan-review" aria-labelledby="plan-review-title">
      <header className="review-head">
        <p className="eyebrow">{planLabel(plan, finished, run.fixRounds)}</p>
        <h2 id="plan-review-title">Review the plan</h2>
        <p className="review-facts">
          {plan.tasks.length} task{plan.tasks.length === 1 ? "" : "s"} · {steps.length} step
          {steps.length === 1 ? "" : "s"} · {people} {people === 1 ? "person" : "people"}
        </p>
      </header>
      <div className="review-summary">
        <p id="plan-summary" className={`pre-wrap ${longSummary && !expanded ? "clamped" : ""}`}>
          {plan.summary}
        </p>
        {longSummary && (
          <button
            type="button"
            className="text-button"
            aria-expanded={expanded}
            aria-controls="plan-summary"
            onClick={() => setExpanded(!expanded)}
          >
            {expanded ? "Show less" : "Read the Director’s full reasoning"}
          </button>
        )}
      </div>
      <p className="plan-checks">
        {plan.verify ? (
          <>
            After each task Orchestra runs <code className="wrap">{plan.verify}</code> and sends failures back to the assignee.
          </>
        ) : (
          "No automatic checks: tasks are only reviewed where a reviewer is named."
        )}
      </p>
      <ol className="plan-steps">
        {steps.map((step, i) => (
          <li key={i} className="plan-step">
            <div className="step-label">
              <span>Step {i + 1}</span>
              {step.length > 1 && <small>{step.length} in parallel</small>}
            </div>
            <ul className="step-tasks">
              {step.map((t) => (
                <li key={t.id} className="plan-card">
                  <div className="plan-card-head">
                    <span className="plan-number">{number.get(t.id)}</span>
                    <h3>{t.title}</h3>
                  </div>
                  <div className="plan-card-meta">
                    <span className="assignee">
                      <span className="mini-avatar" aria-hidden="true">
                        {agentName(t.agentId).slice(0, 1)}
                      </span>
                      {agentName(t.agentId)}
                    </span>
                    {t.reviewerId && <span className="reviewer">reviewed by {agentName(t.reviewerId)}</span>}
                    {t.dependsOn.length > 0 && (
                      <span className="after">
                        after
                        {t.dependsOn.map((key) => {
                          const dep = dependency(key);
                          return (
                            <span key={key} className="dep" title={dep.title}>
                              {dep.label}
                              <span className="sr-only"> {dep.title}</span>
                            </span>
                          );
                        })}
                      </span>
                    )}
                  </div>
                  <details>
                    <summary>Brief and definition of done</summary>
                    <h4>Brief</h4>
                    <p className="pre-wrap">{t.description}</p>
                    <h4>Done when</h4>
                    <p className="pre-wrap">{t.acceptanceCriteria}</p>
                  </details>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
      {plan.stage === "definition" && (
        <p className="quiet-note">
          After these steps the Director reads the team’s documents and plans the build, which you review separately.
        </p>
      )}
      {children}
      <div className="decision-bar">
        {revising ? (
          <ReviseForm
            label="What should the Director change?"
            initial=""
            busy={!!busy}
            onRevise={onRevise}
            onCancel={() => setRevising(false)}
          />
        ) : (
          <>
            <p>
              {steps.length
                ? `Approving starts step 1 (${steps[0]!.length} task${steps[0]!.length === 1 ? "" : "s"}).`
                : "No tasks left: approving accepts the work as it is."}
            </p>
            <div className="decision-actions">
              <Button variant="ghost" disabled={!!busy} onClick={() => setDraft(structuredClone(plan))}>
                Edit plan
              </Button>
              <Button variant="ghost" disabled={!!busy} onClick={() => setRevising(true)}>
                Request changes
              </Button>
              <Button variant="primary" disabled={!!busy} onClick={onApprove}>
                {busy?.endsWith("approve") ? "Starting the team…" : "Approve & start"}
                <span aria-hidden="true">→</span>
              </Button>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

function PlanEditor({
  draft,
  team,
  busy,
  onChange,
  onCancel,
  onSave,
}: {
  draft: Plan;
  team: Agent[];
  busy: boolean;
  onChange: (plan: Plan) => void;
  onCancel: () => void;
  onSave: () => void;
}) {
  const setTask = (id: string, patch: Partial<PlanTask>) =>
    onChange({ ...draft, tasks: draft.tasks.map((t) => (t.id === id ? { ...t, ...patch } : t)) });
  // Removing a task also drops it from the dependencies of the others.
  const remove = (id: string) =>
    onChange({
      ...draft,
      tasks: draft.tasks.filter((t) => t.id !== id).map((t) => ({ ...t, dependsOn: t.dependsOn.filter((d) => d !== id) })),
    });
  return (
    <form
      className="plan-review plan-editor"
      aria-labelledby="plan-editor-title"
      onSubmit={(e: FormEvent) => {
        e.preventDefault();
        if (!busy) onSave();
      }}
    >
      <header className="review-head">
        <p className="eyebrow">Editing the plan</p>
        <h2 id="plan-editor-title">Adjust the plan</h2>
        <p className="review-facts">Changes are checked against the same rules as the Director’s plans when you save.</p>
      </header>
      <label>
        Verify command
        <span className="hint">
          Runs after every task from a fresh checkout; failures go back to the assignee. Leave empty for no automatic checks.
        </span>
        <input
          className="mono"
          maxLength={500}
          value={draft.verify}
          placeholder="npm ci && npm test"
          onChange={(e) => onChange({ ...draft, verify: e.target.value })}
        />
      </label>
      <ol className="editor-tasks">
        {draft.tasks.map((t, i) => (
          <li key={t.id} className="plan-card editor-card">
            <div className="plan-card-head">
              <span className="plan-number">{String(i + 1).padStart(2, "0")}</span>
              <span className="mono muted">{t.id}</span>
              <Button type="button" variant="small ghost" disabled={busy} onClick={() => remove(t.id)}>
                Remove
              </Button>
            </div>
            <label>
              Title
              <input required maxLength={200} value={t.title} onChange={(e) => setTask(t.id, { title: e.target.value })} />
            </label>
            <div className="editor-row">
              <label>
                Assignee
                <select
                  value={t.agentId}
                  onChange={(e) =>
                    // A reviewer can't review their own work.
                    setTask(t.id, { agentId: e.target.value, ...(e.target.value === t.reviewerId && { reviewerId: "" }) })
                  }
                >
                  {team.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.name} · {a.role}
                    </option>
                  ))}
                </select>
              </label>
              <label>
                Reviewer
                <select value={t.reviewerId} onChange={(e) => setTask(t.id, { reviewerId: e.target.value })}>
                  <option value="">No review</option>
                  {team
                    .filter((a) => a.id !== t.agentId)
                    .map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} · {a.role}
                      </option>
                    ))}
                </select>
              </label>
            </div>
            <label>
              Brief
              <textarea
                required
                rows={4}
                maxLength={10000}
                value={t.description}
                onChange={(e) => setTask(t.id, { description: e.target.value })}
              />
            </label>
            <label>
              Done when
              <textarea
                rows={2}
                maxLength={5000}
                value={t.acceptanceCriteria}
                onChange={(e) => setTask(t.id, { acceptanceCriteria: e.target.value })}
              />
            </label>
          </li>
        ))}
      </ol>
      {!draft.tasks.length && (
        <p className="quiet-note">
          {draft.stage === "fix" ? "With no fix tasks, approving accepts the work as it is." : "A plan needs at least one task."}
        </p>
      )}
      <div className="decision-bar">
        <p>Saving replaces the plan; you approve it afterwards.</p>
        <div className="decision-actions">
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Discard changes
          </Button>
          <Button type="submit" variant="primary" disabled={busy}>
            {busy ? "Saving…" : "Save plan"}
          </Button>
        </div>
      </div>
    </form>
  );
}

export function ReviseForm({
  label,
  initial,
  busy,
  onRevise,
  onCancel,
}: {
  label: string;
  initial: string;
  busy: boolean;
  onRevise: (feedback: string) => void;
  /** Present when the form was opened on demand; it then takes focus. */
  onCancel?: () => void;
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
          autoFocus={!!onCancel}
          disabled={busy}
          value={feedback}
          onChange={(e) => setFeedback(e.target.value)}
          placeholder="Describe what to adjust, add, or simplify…"
        />
      </label>
      <div className="revise-actions">
        {onCancel && (
          <Button type="button" variant="ghost" disabled={busy} onClick={onCancel}>
            Cancel
          </Button>
        )}
        <Button disabled={busy || !feedback.trim()} type="submit">
          {busy ? "Sending…" : "Send to Director"}
        </Button>
      </div>
    </form>
  );
}
