import { useState, type ReactNode } from "react";
import type { AgentEvent, AuditRecord, Evidence, Run } from "../../shared/types.ts";
import { activeRunTime, formatDuration, formatUsage, requirementResult } from "../model.ts";
import { DELIVERY_PROFILES, STRATEGY_LABELS } from "./DeliveryFields.tsx";
import { AuditDetails, InvocationManifest } from "./RuntimeDetails.tsx";

const STATE_LABELS = { satisfied: "Satisfied", failed: "Failed", stale: "Stale", unverified: "Unverified" };

export function DeliveryOverview({ run, evidence, events, audit = [], now = Date.now(), agentName = (id) => id }: {
  run: Run;
  evidence: Evidence[];
  events: AgentEvent[];
  audit?: AuditRecord[];
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
  const identities = new Map(audit.flatMap((record) => record.kind === "invocation-started" ? [[record.invocationId, record.agent.name] as const] : []));
  const actor = (id: string, invocationId: string) => identities.get(invocationId) ?? agentName(id);
  return <section className="delivery-overview panel" aria-label="Delivery overview">
    <div className="section-head">
      <div><p className="eyebrow">Delivery</p><h2>{required.length ? `${satisfied} of ${required.length} required outcomes verified` : "What works, and the evidence behind it"}</h2></div>
      <div className="delivery-actions"><span className="delivery-profile">{profile.label}</span><a className="button small" href={`/api/runs/${encodeURIComponent(run.id)}/audit/export`} download>Download audit JSON</a></div>
    </div>
    {(run.firstRunnable || run.firstAccepted) && <div className="delivery-milestones">
      {run.firstRunnable && <p title={`Revision ${run.firstRunnable.commit ?? "not recorded"}`}><span className="hint">First runnable preview</span><strong>{formatDuration(run.firstRunnable.elapsedMs)}</strong><span className="hint">{run.firstRunnable.draft ? "Work in progress · checks pending" : "Integrated snapshot"} · {run.firstRunnable.commit?.slice(0, 12) ?? "Revision not recorded"}</span></p>}
      {run.firstAccepted && <p title={`Revision ${run.firstAccepted.commit ?? "not recorded"}`}><span className="hint">First accepted goal</span><strong>{formatDuration(run.firstAccepted.elapsedMs)}</strong><span className="hint">{run.firstAccepted.commit?.slice(0, 12) ?? "Revision not recorded"} · later improvement time is separate</span></p>}
    </div>}
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
      <HistoryRecords label="Evidence" records={[...evidence].reverse()} searchText={(entry) => JSON.stringify(entry)} render={(entry) => <details className="evidence-history-entry"><summary><span className={`requirement-state state-${entry.status === "passed" ? "satisfied" : entry.status}`}>{entry.status === "passed" ? "Passed" : entry.status === "failed" ? "Failed" : "Unverified"}</span> {entry.scope} · <code>{entry.commit.slice(0, 12)}</code> · {entry.command || entry.producer}</summary><EvidenceDetails evidence={entry} /></details>} />
    </details>}
    {events.length > 0 && <details className="delivery-history"><summary>Agent invocations · {events.filter((event) => event.kind === "started" || event.kind === "child-started").length} started</summary>
      <HistoryRecords label="Invocation events" records={[...events].reverse()} searchText={(event) => `${actor(event.agentId, event.invocationId)} ${JSON.stringify(event)}`} render={(event) => <div className={`invocation-event ${event.parentId ? "child-invocation" : ""}`}><time>{new Date(event.ts).toLocaleString()}</time><strong>{actor(event.agentId, event.invocationId)}</strong> · {event.kind.replaceAll("-", " ")}<span className="hint">{event.text}</span><span className="hint mono">Invocation {event.invocationId}</span>{event.parentId && <span className="hint mono">Child of {event.parentId}</span>}{event.manifest && <InvocationManifest manifest={event.manifest} />}</div>} />
    </details>}
    <details className="delivery-history"><summary>Task attempts and audit trail · {audit.length} record{audit.length === 1 ? "" : "s"}</summary>
      <p className="hint">Saved identities, assignments, attempts, phase changes and invocation usage. Older work without an audit snapshot remains available in evidence and invocation events.</p>
      <HistoryRecords label="Audit trail" records={[...audit].reverse()} searchText={(record) => JSON.stringify(record)} render={(record) => <AuditDetails record={record} />} />
    </details>
  </section>;
}

export function historyPage<T>(records: T[], query: string, page: number, searchText: (entry: T) => string, size = 20) {
  const needle = query.trim().toLocaleLowerCase();
  const filtered = needle ? records.filter((entry) => searchText(entry).toLocaleLowerCase().includes(needle)) : records;
  const pages = Math.max(1, Math.ceil(filtered.length / size));
  const current = Math.max(0, Math.min(page, pages - 1));
  return { records: filtered.slice(current * size, (current + 1) * size), total: filtered.length, pages, page: current };
}

function HistoryRecords<T extends { id: string }>({ label, records, searchText, render }: { label: string; records: T[]; searchText: (entry: T) => string; render: (entry: T) => ReactNode }) {
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const selected = historyPage(records, query, page, searchText);
  return <div className="audit-history">
    <label>Search {label.toLocaleLowerCase()}<input type="search" value={query} onChange={(event) => { setQuery(event.target.value); setPage(0); }} placeholder="Task, revision, check or agent" /></label>
    <div className="audit-pagination"><span className="hint" role="status">{selected.total ? `${selected.page * 20 + 1}–${Math.min((selected.page + 1) * 20, selected.total)} of ${selected.total}` : "No matching records"}</span><div><button type="button" className="button small" disabled={selected.page === 0} onClick={() => setPage(selected.page - 1)}>Previous</button><span className="hint">Page {selected.page + 1} of {selected.pages}</span><button type="button" className="button small" disabled={selected.page + 1 === selected.pages} onClick={() => setPage(selected.page + 1)}>Next</button></div></div>
    <ol className="audit-records">{selected.records.map((record) => <li key={record.id}>{render(record)}</li>)}</ol>
  </div>;
}

export function EvidenceDetails({ evidence }: { evidence: Evidence }) {
  return <div className="evidence-details">
    <dl><dt>Revision</dt><dd className="mono wrap">{evidence.commit}</dd><dt>Producer</dt><dd>{evidence.producer}</dd><dt>Recorded</dt><dd>{new Date(evidence.createdAt).toLocaleString()} · {formatDuration(evidence.durationMs)}</dd>
      {evidence.command && <><dt>Check</dt><dd><code className="wrap">{evidence.command}</code></dd></>}
      {!!evidence.requirementIds.length && <><dt>Requirements</dt><dd>{evidence.requirementIds.map((id) => `${id} v${evidence.requirementVersions[id] ?? "?"}`).join(", ")}</dd></>}
    </dl>
    {!!evidence.artifacts.length && <><p className="hint">Artifacts · {evidence.scope} · {evidence.commit.slice(0, 12)}</p><ul className="evidence-artifacts">{evidence.artifacts.map((artifact, index) => <li key={artifact}>{/\.(?:png|jpe?g|gif|webp)$/i.test(artifact) && <ArtifactPreview evidence={evidence} index={index} artifact={artifact} />}<a href={`/api/runs/${encodeURIComponent(evidence.runId)}/artifacts?evidence=${encodeURIComponent(evidence.id)}&index=${index}`} download><code className="wrap">{artifact}</code></a></li>)}</ul></>}
    {evidence.output && <details><summary>Check output</summary><pre className="evidence-output">{evidence.output}</pre></details>}
  </div>;
}

function ArtifactPreview({ evidence, index, artifact }: { evidence: Evidence; index: number; artifact: string }) {
  const [failed, setFailed] = useState(false);
  const source = `/api/runs/${encodeURIComponent(evidence.runId)}/artifacts/preview?evidence=${encodeURIComponent(evidence.id)}&index=${index}`;
  return failed ? <p className="hint">Image preview unavailable. The recorded artifact can still be downloaded below.</p> : <figure><a href={source} target="_blank" rel="noreferrer"><img src={source} loading="lazy" alt={`${artifact} · ${evidence.scope} evidence at ${evidence.commit.slice(0, 12)}`} onError={() => setFailed(true)} /></a><figcaption className="hint">{evidence.scope} · {evidence.commit.slice(0, 12)} · Evidence {evidence.id}</figcaption></figure>;
}
