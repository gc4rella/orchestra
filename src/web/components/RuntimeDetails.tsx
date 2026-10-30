import type { AuditRecord, RuntimeEnvironment, RuntimeManifest } from "../../shared/types.ts";
import { formatDuration } from "../model.ts";

export function EnvironmentSources({ environment }: { environment: RuntimeEnvironment }) {
  return <div className="environment-sources">
    <h4>Configuration sources</h4>
    {environment.sources.length ? <div className="environment-table"><table><thead><tr><th>Type</th><th>Scope</th><th>Entries</th><th>Source</th></tr></thead><tbody>
      {environment.sources.map((source, index) => <tr key={`${source.path}-${source.kind}-${index}`}><td>{source.kind}</td><td>{source.scope}</td><td>{source.count}</td><td><code className="wrap">{source.path}</code></td></tr>)}
    </tbody></table></div> : <p className="hint">No inherited configuration sources were discovered.</p>}
    {environment.notices.map((notice, index) => <p className="hint" key={index}>{notice}</p>)}
  </div>;
}

export function InvocationManifest({ manifest }: { manifest: RuntimeManifest }) {
  return <details className="invocation-manifest"><summary>Invocation configuration</summary>
    <dl><dt>Runtime</dt><dd>{manifest.runtime === "codex" ? "Codex" : "Claude Code"}</dd><dt>Version</dt><dd>{manifest.version ?? "Unknown"}</dd><dt>Model</dt><dd>{manifest.model ?? "CLI default · not reported"}</dd><dt>Reasoning effort</dt><dd>{manifest.effort ?? "CLI default · not reported"}</dd><dt>Adapter</dt><dd>{manifest.transport === "app-server" ? "App server" : "Batch CLI"}</dd></dl>
    <h4>Registered skills</h4>
    {manifest.skills.length ? <ul>{manifest.skills.map((skill) => <li key={skill.id}><code className="wrap">{skill.id}</code> · <code>{skill.revision ?? "Revision unknown"}</code></li>)}</ul> : <p className="hint">No Orchestra skills registered for this invocation.</p>}
    <EnvironmentSources environment={manifest.environment} />
  </details>;
}

export function AuditDetails({ record }: { record: AuditRecord }) {
  return <details className="audit-entry"><summary><time>{new Date(record.ts).toLocaleString()}</time> · {record.kind.replaceAll("-", " ")}{"attempt" in record && record.attempt !== null ? ` · Attempt ${record.attempt}` : ""}{"status" in record ? ` · ${record.status}` : ""}{record.kind === "invocation-started" ? ` · ${record.agent.name}` : ""}</summary>
    <dl><dt>Record</dt><dd className="mono wrap">{record.id}</dd>{record.taskId && <><dt>Task</dt><dd className="mono wrap">{record.taskId}</dd></>}{"phase" in record && record.phase && <><dt>Phase</dt><dd>{record.phase}</dd></>}{"commit" in record && record.commit && <><dt>Revision</dt><dd className="mono wrap">{record.commit}</dd></>}{"invocationId" in record && <><dt>Invocation</dt><dd className="mono wrap">{record.invocationId}</dd></>}
      {record.kind === "invocation-started" && <><dt>Agent at invocation</dt><dd>{record.agent.name} · {record.agent.role}<span className="hint mono">{record.agent.id}</span></dd><dt>Purpose</dt><dd>{record.purpose}</dd>{record.selectionReason && <><dt>Selection reason</dt><dd>{record.selectionReason}</dd></>}{record.queuedAt !== undefined && record.slotAcquiredAt !== undefined && <><dt>Agent queue wait</dt><dd>{formatDuration(Math.max(0, record.slotAcquiredAt - record.queuedAt))}</dd></>}<dt>Input revision</dt><dd className="mono wrap">{record.inputCommit ?? "Not recorded"}</dd><dt>Prompt digest</dt><dd className="mono wrap">{record.promptDigest}</dd><dt>Guidance digest</dt><dd className="mono wrap">{record.guidanceDigest}</dd></>}
      {record.kind === "invocation-finished" && <><dt>Tokens</dt><dd>{record.usage?.tokensReported === false ? "Not reported" : record.usage?.tokens ?? "Not reported"}</dd><dt>Cost (USD)</dt><dd>{record.usage?.costUsd ?? "Not reported"}</dd>{record.error && <><dt>Error</dt><dd className="pre-wrap">{record.error}</dd></>}</>}
      {"agentId" in record && <><dt>Agent id</dt><dd className="mono wrap">{record.agentId}</dd></>}
      {record.kind === "task-assignment" && <><dt>Previous agent</dt><dd className="mono wrap">{record.previousAgentId ?? "Initial assignment"}</dd><dt>Reason</dt><dd>{record.reason}</dd></>}
      {record.kind === "task-review" && <><dt>Reviewer id</dt><dd className="mono wrap">{record.reviewerId}</dd><dt>Verdict</dt><dd>{record.verdict === "approve" ? "Approved" : "Changes requested"}</dd><dt>Findings</dt><dd className="pre-wrap">{record.findings || "None reported"}</dd></>}
    </dl>
    {record.kind === "invocation-started" && <><h4>Selected skill instructions</h4>{record.selectedSkills.length ? <ul>{record.selectedSkills.map((skill) => <li key={skill.id}><code className="wrap">{skill.id}</code> · {skill.revision ?? "Revision unknown"}</li>)}</ul> : <p className="hint">No skill instructions selected for this invocation.</p>}<p className="hint">Selection records the instructions supplied to the agent; it does not prove the agent followed them. {record.registeredSkills.length} skill{record.registeredSkills.length === 1 ? " was" : "s were"} registered.</p><InvocationManifest manifest={record.manifest} /></>}
    {record.kind === "invocation-finished" && !!record.skillClaims?.length && <><h4>Self-reported consulted skills</h4><p className="hint">Agent claims, not independent evidence that instructions were read or applied.</p><ul>{record.skillClaims.map((claim, index) => <li key={index}>{claim}</li>)}</ul></>}
  </details>;
}
