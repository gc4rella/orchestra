import { useEffect, useRef, useState, type FormEvent } from "react";
import type { RateLimitPolicy } from "../../shared/types.ts";
import { api } from "../api.ts";
import { RateLimitFields } from "../components/RateLimitFields.tsx";
import { Button, Loading, Notice } from "../components/UI.tsx";

type SettingsData = { rateLimitPolicy: RateLimitPolicy | null };

export function Settings() {
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const lock = useRef(false);
  const load = () => {
    setError(null);
    void api<SettingsData>("/api/settings").then(setSettings).catch((e) => setError((e as Error).message));
  };
  useEffect(load, []);
  const save = async (e: FormEvent) => {
    e.preventDefault();
    if (!settings || lock.current) return;
    lock.current = true;
    setBusy(true);
    setError(null);
    setSaved(false);
    try {
      setSettings(await api<SettingsData>("/api/settings", { method: "PUT", body: settings }));
      setSaved(true);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      lock.current = false;
      setBusy(false);
    }
  };
  return <section className="page">
    <div className="page-head">
      <div>
        <p className="eyebrow">Settings</p>
        <h1>One safeguard for the whole team.</h1>
        <p className="lede">Set the account quota ceiling once. All existing and future agents inherit it unless you choose an explicit override.</p>
      </div>
    </div>
    {!settings && !error && <Loading label="Loading settings" />}
    {error && <Notice retry={!settings ? load : undefined}>{error}</Notice>}
    {settings && <form className="form" onSubmit={save}>
      <RateLimitFields scope="global" value={settings.rateLimitPolicy} disabled={busy} onChange={(rateLimitPolicy) => { setSettings({ rateLimitPolicy }); setSaved(false); }} />
      <p className="hint">Project overrides take priority, then agent overrides, then this global setting. Changes apply before the next call and at the next minute check of active calls. Paused runs keep their refill wait.</p>
      <div><Button type="submit" variant="primary" disabled={busy}>{busy ? "Saving…" : "Save global safeguard"}</Button></div>
      {saved && <Notice kind="success">Global safeguard saved. Agents using the global setting inherit it automatically.</Notice>}
    </form>}
  </section>;
}
