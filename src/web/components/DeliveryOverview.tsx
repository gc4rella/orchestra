import type { AgentEvent, Evidence, Run } from "../../shared/types.ts";
import { activeRunTime, formatDuration, formatUsage, requirementResult } from "../model.ts";
import { DELIVERY_PROFILES, STRATEGY_LABELS } from "./DeliveryFields.tsx";
import { InvocationManifest } from "./RuntimeDetails.tsx";

const STATE_LABELS = { satisfied: "Satisfied", failed: "Failed", stale: "Stale", unverified: "Unverified" };

export function DeliveryOverview({ run, evidence, events, now = Date.now(), agentName = (id) => id }: {
  run: Run;
  evidence: Evidence[];
  events: AgentEvent[];
  now?: number;
  agentName?: (id: string) => string;
}) {
  if (!run.delivery) return <section className="delivery-overview panel" aria-label="Delivery overview">
    <h2>Delivery evidence</h2>
    <p role="status">Delivery evidence requires a newer Orchestra server. Restart Orchestra after active runs have stopped to enable it.</p>
  </section>;
  const policy = run.delivery;
  const profile = DELIVERY_PROFILES.find((item) => item.id === policy.profile)!;
  const results = (run.requirements ?? []).map((requirement) => ({ requirement, ...requirementResult(requirement, run.acceptedCommit, evidence) }));
  const required = results.filter(({ requirement }) => requirement.required);
  const satisfied = required.filter(({ status }) => status === "satisfied").length;
  const unresolved = required.filter(({ status }) => status !== "satisfied");
  const usage = formatUsage(run);
  const strategy = run.recommendation?.strategy ?? policy.strategy;
  const recentEvents = events.slice(-30);
  return <section className="delivery-overview panel" aria-label="Delivery overview">
    <div className="section-head">
      <div><p className="eyebrow">Delivery</p><h2>{required.length ? `${satisfied} of ${required.length} required outcomes verified` : "What works, and the evidence behind it"}</h2></div>
      <span className="delivery-profile">{profile.label}</span>
    </div>
    <div className="delivery-metrics">
      <div><span className="hint">Execution</span><strong>{STRATEGY_LABELS[strategy]}</strong><span className="hint">Up to {policy.maxParallel} parallel worker{policy.maxParallel === 1 ? "" : "s"}</span></div>
      <div><span className="hint">Agent calls</span><strong>{run.agentCalls}{run.limits ? ` / ${run.limits.maxAgentCalls}` : ""}</strong><span className="hint">Planning, work, reviews and repairs</span></div>
      <div><span className="hint">Active time remaining</span><strong>{run.limits ? formatDuration(Math.max(0, run.limits.maxDurationMs - activeRunTime(run, now))) : "No time limit"}</strong><span className="hint">{usage ?? "No usage reported yet"}</span></div>
      <div><span className="hint">Accepted integration revision</span><strong className="mono" title={run.acceptedCommit ?? undefined}>{run.acceptedCommit?.slice(0, 12) ?? "Awaiting integration"}</strong><span className="hint">Evidence is specific to this revision</span></div>
    </div>
    <p className="delivery-rationale">{run.recommendation?.reason ?? profile.hint}{run.recommendation && <span className="hint"> {run.recommendation.samples ? `Based on ${run.recommendation.samples} recorded project run${run.recommendation.samples === 1 ? "" : "s"}.` : "Initial recommendation; no project outcome history yet."}</span>}</p>
    {results.length ? <>
      {unresolved.length > 0 && <p className="hint">{unresolved.length} required outcome{unresolved.length === 1 ? " remains" : "s remain"} unresolved. A passing task check does not establish delivery acceptance.</p>}
      <ol className="requirement-list" aria-label="Acceptance requirements">
        {results.map(({ requirement, status, evidence: current }) => <li key={requirement.id} className={`requirement requirement-${status}`}>
          <details>
            <summary><span className="requirement-title"><span className="mono requirement-id">{requirement.id}</span><strong>{requirement.title}</strong>{!requirement.required && <span className="hint">Optional</span>}</span><span className={`requirement-state state-${status}`}>{STATE_LABELS[status]}</span></summary>
            <div className="requirement-details">
              <p className="pre-wrap">{requirement.description}</p>
              <p className="hint">Version {requirement.version} · {requirement.kind === "review" ? "Independent review" : "Command check"}{requirement.required ? " · Required" : ""}</p>
              {requirement.check && <p><code className="wrap">{requirement.check}</code></p>}
              {!!requirement.inputs.length && <p className="hint">Inputs: {requirement.inputs.join(", ")}</p>}
              {!!requirement.artifacts.length && <p className="hint">Expected artifacts: {requirement.artifacts.join(", ")}</p>}
              {status === "stale" && <p className="evidence-stale">The recorded check belongs to an earlier revision or requirement version. Acceptance must run again.</p>}
              {current ? <EvidenceDetails evidence={current} /> : <p className="hint">No acceptance evidence recorded. {requirement.kind === "review" ? "An independent review must establish this outcome." : "This requirement needs a check on the integration revision."}</p>}
            </div>
          </details>
        </li>)}
      </ol>
    </> : <p className="delivery-empty hint">The Director will identify acceptance requirements in its plan. Existing runs keep their original task checks and review history.</p>}
    {evidence.length > 0 && <details className="delivery-history"><summary>Evidence history · {evidence.length} immutable record{evidence.length === 1 ? "" : "s"}</summary>
      <p className="hint">Task and integration checks show work in progress. Acceptance records establish outcomes only for the exact revision and requirement version above.</p>
      {evidence.slice(-40).reverse().map((entry) => <details key={entry.id} className="evidence-history-entry"><summary><span className={`requirement-state state-${entry.status === "passed" ? "satisfied" : entry.status}`}>{entry.status === "passed" ? "Passed" : entry.status === "failed" ? "Failed" : "Unverified"}</span> {entry.scope} · <code>{entry.commit.slice(0, 12)}</code> · {entry.command || entry.producer}</summary><EvidenceDetails evidence={entry} /></details>)}
      {evidence.length > 40 && <p className="hint">Showing the 40 most recent records. All evidence remains saved with this run.</p>}
    </details>}
    {recentEvents.length > 0 && <details className="delivery-history"><summary>Agent invocations · {events.filter((event) => event.kind === "started" || event.kind === "child-started").length} started</summary>
      <ol className="invocation-list">{recentEvents.map((event) => <li key={event.id} className={event.parentId ? "child-invocation" : ""}><time>{new Date(event.ts).toLocaleTimeString()}</time><div className="invocation-event"><strong>{agentName(event.agentId)}</strong> · {event.kind.replaceAll("-", " ")}<span className="hint">{event.text}</span>{event.parentId && <span className="hint mono">Child of {event.parentId}</span>}{event.manifest && <InvocationManifest manifest={event.manifest} />}</div></li>)}</ol>
    </details>}
  </section>;
}

export function EvidenceDetails({ evidence }: { evidence: Evidence }) {
  return <div className="evidence-details">
    <dl><dt>Revision</dt><dd className="mono wrap">{evidence.commit}</dd><dt>Producer</dt><dd>{evidence.producer}</dd><dt>Recorded</dt><dd>{new Date(evidence.createdAt).toLocaleString()} · {formatDuration(evidence.durationMs)}</dd>
      {evidence.command && <><dt>Check</dt><dd><code className="wrap">{evidence.command}</code></dd></>}
      {!!evidence.requirementIds.length && <><dt>Requirements</dt><dd>{evidence.requirementIds.map((id) => `${id} v${evidence.requirementVersions[id] ?? "?"}`).join(", ")}</dd></>}
    </dl>
    {!!evidence.artifacts.length && <><p className="hint">Artifacts</p><ul>{evidence.artifacts.map((artifact, index) => <li key={artifact}><a href={`/api/runs/${encodeURIComponent(evidence.runId)}/artifacts?evidence=${encodeURIComponent(evidence.id)}&index=${index}`} download><code className="wrap">{artifact}</code></a></li>)}</ul></>}
    {evidence.output && <details><summary>Check output</summary><pre className="evidence-output">{evidence.output}</pre></details>}
  </div>;
}
