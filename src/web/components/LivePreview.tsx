import { useEffect, useState, type FormEvent } from "react";
import type { PreviewConfig, PreviewState, Run } from "../../shared/types.ts";
import { timeAgo } from "../api.ts";
import { Button } from "./UI.tsx";

type Props = {
  run: Run;
  preview: PreviewState | null;
  busy: boolean;
  visible?: boolean;
  onConfigure: (config: PreviewConfig) => Promise<boolean>;
};

export function LivePreview(props: Props) {
  // Bun can update the browser bundle while the server still runs the previous API.
  if (!props.run.preview) return <section className="live-preview panel" aria-label="Live preview">
    <h2>Live preview</h2>
    <p>Restart Orchestra to enable live previews. The server is running an older version.</p>
  </section>;
  return <ConfiguredPreview {...props} />;
}

function ConfiguredPreview({ run, preview, busy, visible = true, onConfigure }: Props) {
  const [command, setCommand] = useState(run.preview.command);
  const [reload, setReload] = useState(0);
  const [visited, setVisited] = useState(visible);
  useEffect(() => setCommand(run.preview.command), [run.preview.command]);
  // Keep the app's navigation and form state when returning to another workspace section.
  useEffect(() => { if (visible) setVisited(true); }, [visible]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void onConfigure({ enabled: true, command: command.trim() });
  };
  const labels = { stopped: "Stopped", waiting: "Waiting for the app", starting: "Updating", ready: "Live", failed: "Needs attention" };
  const status = preview?.status ?? "stopped";
  const restart = run.preview.enabled && ["failed", "stopped"].includes(status);
  const titles = {
    stopped: run.preview.enabled ? "Your preview is stopped" : "See your app take shape",
    waiting: "The first version is on its way",
    starting: "Preparing your app",
    ready: "Your app is ready",
    failed: "Let’s get the preview running",
  };
  return <section className="live-preview" aria-label="Live preview">
    <div className="preview-toolbar">
      <div>
        <h2>Live preview <span className={`preview-status preview-${status}`} role="status">{preview ? labels[status] : "Loading…"}</span></h2>
        <p className="hint">Updates automatically as your team makes runnable changes.</p>
      </div>
      <div className="actions">
        {preview?.url && <>
          <a className="button small ghost" href={preview.url} target="_blank" rel="noreferrer">Open in new tab ↗</a>
          <Button variant="small ghost" onClick={() => setReload((v) => v + 1)}>Reload page</Button>
        </>}
        {restart || !run.preview.enabled
          ? <Button variant="small" disabled={busy} onClick={() => void onConfigure({ ...run.preview, enabled: true })}>{restart ? "Restart preview" : "Start preview"}</Button>
          : <Button variant="small ghost" disabled={busy} onClick={() => void onConfigure({ ...run.preview, enabled: false })}>Stop preview</Button>}
        {restart && preview?.url && <Button variant="small ghost" disabled={busy} onClick={() => void onConfigure({ ...run.preview, enabled: false })}>Stop preview</Button>}
      </div>
    </div>
    {preview?.url ? <>
      {status !== "ready" && <p className={`preview-message ${status === "failed" ? "preview-error" : ""}`} aria-live="polite">{status === "failed" ? "The update failed. Your previous preview is still available." : "Updating the preview. You can keep using this version."}</p>}
      <div className="preview-canvas">
        <div className="preview-address">
          <span>{preview.draft ? "Work in progress · checks pending" : "Integrated build"} <code>{preview.commit?.slice(0, 7) ?? ""}</code></span>
          {preview.updatedAt ? <span>Updated {timeAgo(preview.updatedAt)}</span> : null}
        </div>
        {visited && <iframe key={`${preview.url}-${preview.commit}-${reload}`} src={preview.url} title="App being built by the team" className="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads" />}
      </div>
    </> : <div className={`preview-empty preview-empty-${status}`}>
      <span className="preview-empty-mark" aria-hidden="true">↗</span>
      <p className="eyebrow">Your working app</p>
      <h3>{!preview && run.preview.enabled ? "Getting the preview ready" : titles[status]}</h3>
      <p className="preview-message" aria-live="polite">{!run.preview.enabled && status === "stopped" ? "Start the preview to see your app take shape as your team works." : preview?.message ?? "Loading preview status…"}</p>
      {(status === "waiting" || status === "starting") && <span className="hint">This view updates automatically when the app is ready.</span>}
      {status === "failed" && <span className="hint">Open settings & output below for details, or restart to try again.</span>}
    </div>}
    <details className="preview-settings">
      <summary>Preview settings & output</summary>
      <form onSubmit={save}>
        <label>Start command <span className="hint">Leave empty to detect Vite, Next.js, Astro or a root index.html. A custom command must install its own dependencies and serve HTTP on 127.0.0.1 using $PORT. It runs through your shell with your user permissions.</span>
          <input className="mono" value={command} maxLength={1000} disabled={busy} onChange={(e) => setCommand(e.target.value.replace(/[\r\n]/g, " "))} placeholder={'bun install && bun run dev --host 127.0.0.1 --port "$PORT"'} />
        </label>
        <p className="hint">Runs in a separate worktree using snapshots of team progress. Work in progress has not passed all checks yet. Local .env files are not copied. Preview stays available when the run pauses or finishes; stop it here when done. After Orchestra restarts, start the preview again.</p>
          <div className="actions">
            <Button variant="small" disabled={busy} type="submit">Save & start preview</Button>
            {restart && !preview?.url && <Button variant="small ghost" disabled={busy} type="button" onClick={() => void onConfigure({ ...run.preview, enabled: false })}>Turn off preview</Button>}
          </div>
      </form>
      {status === "failed" && preview?.url && <p className="preview-error">{preview.message}</p>}
      {preview?.output && <pre className="preview-output" aria-label="Preview server output">{preview.output}</pre>}
    </details>
  </section>;
}
