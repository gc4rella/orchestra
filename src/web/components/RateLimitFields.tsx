import type { RateLimitPolicy } from "../../shared/types.ts";

export function RateLimitFields({ value, onChange, scope = "agent", disabled = false }: {
  value: RateLimitPolicy | null;
  onChange: (value: RateLimitPolicy | null) => void;
  scope?: "agent" | "project" | "global";
  disabled?: boolean;
}) {
  return <fieldset disabled={disabled}>
    <legend className="eyebrow">Usage safeguard</legend>
    <label className="autonomy-option">
      <input type="checkbox" checked={value !== null} onChange={(e) => onChange(e.target.checked ? { maxUsedPercent: 50, window: "both" } : null)} />
      <span>{scope === "global" ? "Enable for all agents" : "Override usage safeguard"}</span>
    </label>
    {value && <div className="grid-2">
      <label>Maximum used (%)
        <input type="number" min={1} max={100} required value={value.maxUsedPercent} onChange={(e) => onChange({ ...value, maxUsedPercent: Number(e.target.value) })} />
      </label>
      <label>Quota window
        <select value={value.window} onChange={(e) => onChange({ ...value, window: e.target.value as RateLimitPolicy["window"] })}>
          <option value="both">All available windows</option>
          <option value="5h">5 hours</option>
          <option value="weekly">Weekly</option>
        </select>
      </label>
    </div>}
    <p className="hint">{value
      ? "50% pauses at 50% total account usage, including other apps. Checks run before calls and every minute while working. Work resumes only after the affected window is 100% available. Usage can cross the ceiling between checks."
      : scope === "global" ? "No global safeguard. Explicit agent and project overrides still apply." : scope === "project" ? "Use agent overrides, otherwise the global safeguard. Enable to override them for this project’s new runs." : "Use the global safeguard. Enable an override for this agent across projects."}</p>
    {scope !== "global" && <p className="hint"><a href="#/settings">Manage the global safeguard →</a></p>}
    {value && <p className="hint">Requires subscription quota reporting from the signed-in CLI. If unavailable, the run pauses for attention. Work and budgets are preserved; server restarts require manual resume.</p>}
  </fieldset>;
}
