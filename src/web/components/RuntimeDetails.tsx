import type { RuntimeEnvironment, RuntimeManifest } from "../../shared/types.ts";

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
