import { useEffect, useRef, useState, type FormEvent } from "react";
import type { Secret } from "../../shared/types.ts";
import { api, timeAgo } from "../api.ts";
import { Button, Notice } from "./UI.tsx";

type Props = { runId: string; visible: boolean; previewEnabled: boolean; onRestart: () => Promise<boolean> };

export function Secrets({ runId, visible, previewEnabled, onRestart }: Props) {
  const [open, setOpen] = useState(false);
  return <section className="secrets-panel" aria-label="Secrets">
    <div className="secrets-heading">
      <div><h3>Secrets</h3><p className="hint">App login details and environment variables.</p></div>
      <Button variant="small ghost" aria-expanded={open} onClick={() => setOpen(!open)}>{open ? "Close secrets" : "Open secrets"}</Button>
    </div>
    {open && visible && <SecretList key={runId} runId={runId} previewEnabled={previewEnabled} onRestart={onRestart} />}
  </section>;
}

function SecretList({ runId, previewEnabled, onRestart }: Omit<Props, "visible">) {
  const endpoint = `/api/runs/${runId}/secrets`;
  const [secrets, setSecrets] = useState<Secret[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState("");
  const [value, setValue] = useState("");
  const [environment, setEnvironment] = useState(false);
  const [restartNeeded, setRestartNeeded] = useState(false);
  const [message, setMessage] = useState("");
  const live = useRef(true);
  const load = async () => {
    try { const items = await api<Secret[]>(endpoint); if (live.current) { setSecrets(items); setError(null); } }
    catch (e) { if (live.current) setError((e as Error).message); }
  };
  useEffect(() => {
    live.current = true;
    void load();
    const timer = setInterval(() => void load(), 5000);
    return () => { live.current = false; clearInterval(timer); };
  }, [endpoint]);
  const save = async (event: FormEvent) => {
    event.preventDefault();
    setBusy(true); setError(null); setMessage("");
    try {
      const previous = secrets?.find((secret) => secret.source === "saved" && secret.name === name);
      const items = await api<Secret[]>(endpoint, { method: "PUT", body: { name, value, environment } });
      if (!live.current) return;
      setSecrets(items); setValue(""); setName(""); setEditing(false);
      setRestartNeeded((pending) => pending || environment || !!previous?.environment);
      setMessage("Secret saved for this project.");
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  };
  const remove = async (secret: Secret) => {
    setBusy(true); setError(null);
    try {
      const items = await api<Secret[]>(endpoint, { method: "DELETE", body: { name: secret.name, source: secret.source } });
      if (!live.current) return;
      setSecrets(items); setRestartNeeded((pending) => pending || secret.environment); setMessage("Secret deleted.");
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setBusy(false); }
  };
  return <div className="secrets-content">
    <p className="hint">Saved for this project on this machine, encrypted in Orchestra’s database. Values are fetched only when revealed or copied. Environment changes apply when a preview next starts.</p>
    {secrets === null ? <p className="hint">Loading secrets…</p> : secrets.length === 0 ? <p className="secrets-empty">No secrets yet. Add a login or environment variable below. When the app reports preview credentials, they appear here automatically.</p> :
      <div className="secrets-list">{secrets.map((secret) => <SecretRow key={`${secret.source}:${secret.name}:${secret.updatedAt}`} secret={secret} endpoint={endpoint} busy={busy} onDelete={() => void remove(secret)} onEdit={() => { setName(secret.name); setValue(""); setEnvironment(secret.environment); setEditing(true); }} />)}</div>}
    {message && <p className="hint" role="status">{message}</p>}
    {restartNeeded && <div className="actions"><span className="hint">Restart the preview to apply environment changes.</span><Button variant="small" disabled={busy} onClick={async () => { setBusy(true); try { if (await onRestart()) setRestartNeeded(false); } finally { if (live.current) setBusy(false); } }}>{previewEnabled ? "Restart preview" : "Start preview"}</Button></div>}
    {editing ? <form className="secret-form" onSubmit={save}>
      <label>Name<input autoFocus required pattern="[A-Za-z_][A-Za-z0-9_]*" maxLength={80} value={name} onChange={(e) => setName(e.target.value)} placeholder="ADMIN_PASSWORD" autoComplete="off" disabled={busy} /></label>
      <label>Value<input required type="password" maxLength={8000} value={value} onChange={(e) => setValue(e.target.value)} autoComplete="new-password" disabled={busy} placeholder="Enter a new value" /></label>
      <label className="check-row"><input type="checkbox" checked={environment} onChange={(e) => setEnvironment(e.target.checked)} disabled={busy} />Pass to the preview as an environment variable</label>
      <p className="hint">Leave unchecked to keep a login detail for reference. Saving an existing name replaces its value. Saving a password does not create or change an account in the app.</p>
      <div className="actions"><Button type="submit" variant="small" disabled={busy}>{busy ? "Saving…" : "Save secret"}</Button><Button type="button" variant="small ghost" disabled={busy} onClick={() => { setEditing(false); setValue(""); }}>Cancel</Button></div>
    </form> : <Button variant="small" disabled={busy} onClick={() => { setName(""); setValue(""); setEnvironment(false); setEditing(true); }}>Add secret</Button>}
    {error && <Notice retry={load}>{error}</Notice>}
  </div>;
}

export function SecretRow({ secret, endpoint, busy, onDelete, onEdit }: { secret: Secret; endpoint: string; busy: boolean; onDelete: () => void; onEdit: () => void }) {
  const [value, setValue] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [message, setMessage] = useState("");
  const [error, setError] = useState<string | null>(null);
  const live = useRef(true);
  useEffect(() => { live.current = true; return () => { live.current = false; }; }, []);
  useEffect(() => {
    if (value === null) return;
    const timer = setTimeout(() => setValue(null), 30_000);
    const hide = () => { if (document.hidden) setValue(null); };
    document.addEventListener("visibilitychange", hide);
    return () => { clearTimeout(timer); document.removeEventListener("visibilitychange", hide); };
  }, [value]);
  const access = async (copy: boolean) => {
    setPending(true); setError(null); setMessage("");
    try {
      const result = await api<{ value: string }>(`${endpoint}/reveal`, { body: { name: secret.name, source: secret.source } });
      if (!live.current) return;
      if (copy) { await navigator.clipboard.writeText(result.value); if (live.current) setMessage("Copied"); }
      else setValue(result.value);
    } catch (e) { if (live.current) setError((e as Error).message); }
    finally { if (live.current) setPending(false); }
  };
  return <article className="secret-row">
    <div className="secret-meta"><strong className="mono wrap">{secret.name}</strong><span className="hint">{secret.source === "preview" ? `Reported by preview${secret.commit ? ` · ${secret.commit.slice(0, 7)}` : ""}` : secret.environment ? "Environment variable · project" : "Saved login detail · project"} · {timeAgo(secret.updatedAt)}</span></div>
    <code className="secret-value" aria-label={value === null ? `${secret.name} hidden` : `${secret.name} value`}>{value ?? "••••••••"}</code>
    <div className="actions">
      <Button variant="small ghost" disabled={pending || busy} onClick={() => value === null ? void access(false) : setValue(null)}>{value === null ? "Reveal" : "Hide"}</Button>
      <Button variant="small ghost" disabled={pending || busy} onClick={() => void access(true)}>Copy</Button>
      {secret.source === "saved" && <><Button variant="small ghost" disabled={busy} onClick={onEdit}>Replace</Button>{confirm ? <><Button variant="small danger" disabled={busy} onClick={onDelete}>Delete secret</Button><Button variant="small ghost" disabled={busy} onClick={() => setConfirm(false)}>Keep</Button></> : <Button variant="small ghost" disabled={busy} onClick={() => setConfirm(true)}>Delete</Button>}</>}
      {message && <span className="hint" role="status">{message}</span>}
    </div>
    {error && <Notice>{error}</Notice>}
  </article>;
}
