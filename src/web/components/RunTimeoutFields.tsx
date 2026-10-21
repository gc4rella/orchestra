import type { RunTimeouts } from "../../shared/types.ts";
import { RUN_TIMEOUT_BOUNDS } from "../../shared/types.ts";

export function RunTimeoutFields({ value, onChange, disabled = false }: {
  value: RunTimeouts;
  onChange: (value: RunTimeouts) => void;
  disabled?: boolean;
}) {
  return <fieldset className="run-limits" disabled={disabled}>
    <legend>Time allowed per operation</legend>
    <label>Agent call (minutes)
      <input type="number" required min={RUN_TIMEOUT_BOUNDS.agentMinutes.min} max={RUN_TIMEOUT_BOUNDS.agentMinutes.max} step={1} value={value.agentMs / 60_000} onChange={(e) => onChange({ ...value, agentMs: Number(e.target.value) * 60_000 })} />
    </label>
    <label>Check command (minutes)
      <input type="number" required min={RUN_TIMEOUT_BOUNDS.checkMinutes.min} max={RUN_TIMEOUT_BOUNDS.checkMinutes.max} step={1} value={value.checkMs / 60_000} onChange={(e) => onChange({ ...value, checkMs: Number(e.target.value) * 60_000 })} />
    </label>
    <p className="hint">Longer tasks may need more time. The total run budget still applies.</p>
  </fieldset>;
}
