import { useEffect, useState, type FormEvent } from "react";
import type { PreviewConfig, PreviewState, Run } from "../../shared/types.ts";
import { timeAgo } from "../api.ts";
import { Button } from "./UI.tsx";

type Props = {
  run: Run;
  preview: PreviewState | null;
  busy: boolean;
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

function ConfiguredPreview({ run, preview, busy, onConfigure }: Props) {
  const [open, setOpen] = useState(run.preview.enabled);
  const [command, setCommand] = useState(run.preview.command);
  const [reload, setReload] = useState(0);
  useEffect(() => setCommand(run.preview.command), [run.preview.command]);
  const save = (e: FormEvent) => {
    e.preventDefault();
    void onConfigure({ enabled: true, command: command.trim() }).then((ok) => { if (ok) setOpen(true); });
  };
  const labels = { stopped: "Stopped", waiting: "Waiting for the app", starting: "Updating", ready: "Live", failed: "Needs attention" };
  return <section className="live-preview panel" aria-label="Live preview">
    <div className="preview-toolbar">
      <div>
        <h2>Live preview <span className={`preview-status preview-${preview?.status ?? "stopped"}`} role="status">{preview ? labels[preview.status] : "Loading…"}</span></h2>
        <p className="hint">Checked work appears here as tasks merge. Your project folder stays untouched.</p>
      </div>
      <div className="actions">
        {preview?.url && <a className="button small ghost" href={preview.url} target="_blank" rel="noreferrer">Open preview ↗</a>}
        {run.preview.enabled
          ? <Button variant="small ghost" disabled={busy} onClick={() => void onConfigure({ ...run.preview, enabled: false })}>Stop preview</Button>
          : <Button variant="small" disabled={busy} onClick={() => void onConfigure({ ...run.preview, enabled: true }).then((ok) => { if (ok) setOpen(true); })}>Start preview</Button>}
        <Button variant="small ghost" aria-expanded={open} aria-controls="live-preview-body" onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</Button>
      </div>
    </div>
    <div id="live-preview-body" hidden={!open}>
      <p className={`preview-message ${preview?.status === "failed" ? "preview-error" : ""}`} aria-live="polite">{preview?.message ?? "Loading preview status…"}</p>
      {preview?.url && <>
        <div className="preview-address">
          <span className="mono">{preview.commit?.slice(0, 7)}{preview.updatedAt ? ` · updated ${timeAgo(preview.updatedAt)}` : ""}</span>
          <Button variant="small ghost" onClick={() => setReload((v) => v + 1)}>Reload page</Button>
        </div>
        <iframe key={`${preview.url}-${reload}`} src={preview.url} title="App being built by the team" className="preview-frame" sandbox="allow-scripts allow-same-origin allow-forms allow-modals allow-downloads" />
      </>}
      {run.preview.enabled && preview && ["failed", "stopped"].includes(preview.status) && <p><Button variant="small" disabled={busy} onClick={() => void onConfigure(run.preview)}>Restart preview</Button></p>}
      <details className="preview-settings">
        <summary>Preview settings & output</summary>
        <form onSubmit={save}>
          <label>Start command <span className="hint">Leave empty to detect Vite, Next.js, Astro or a root index.html. A custom command must install its own dependencies and serve HTTP on 127.0.0.1 using $PORT. It runs through your shell with your user permissions.</span>
            <input className="mono" value={command} maxLength={1000} disabled={busy} onChange={(e) => setCommand(e.target.value.replace(/[\r\n]/g, " "))} placeholder={'bun install && bun run dev --host 127.0.0.1 --port "$PORT"'} />
          </label>
          <p className="hint">Runs in a separate worktree using committed files. Local .env files are not copied. Preview stays available when the run pauses or finishes; stop it here when done. After Orchestra restarts, start the preview again.</p>
          <Button variant="small" disabled={busy} type="submit">Save & start preview</Button>
        </form>
        {preview?.output && <pre className="preview-output" aria-label="Preview server output">{preview.output}</pre>}
      </details>
    </div>
  </section>;
}
