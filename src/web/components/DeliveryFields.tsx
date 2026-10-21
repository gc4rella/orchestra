import type { DeliveryPolicy } from "../../shared/types.ts";
import { defaultDeliveryPolicy } from "../../shared/types.ts";

export const DELIVERY_PROFILES: { id: DeliveryPolicy["profile"]; label: string; hint: string }[] = [
  { id: "balanced", label: "Balanced", hint: "Start with focused work. Add parallel workers when their assignments can progress independently." },
  { id: "quality", label: "Quality", hint: "Favor independent review and more verification before accepting the delivered result." },
  { id: "speed", label: "Speed", hint: "Favor safe parallel work and prioritize the tasks that hold up delivery." },
  { id: "economy", label: "Economy", hint: "Favor fewer workers, concise handoffs and targeted escalation to conserve agent calls." },
];

export const STRATEGY_LABELS: Record<DeliveryPolicy["strategy"], string> = {
  auto: "Let Orchestra choose", single: "One worker", team: "Parallel team", native: "Native delegation",
};

export function DeliveryFields({ value, onChange, disabled = false, nativeAvailable = false }: {
  value: DeliveryPolicy;
  onChange: (value: DeliveryPolicy) => void;
  disabled?: boolean;
  nativeAvailable?: boolean;
}) {
  return <fieldset className="delivery-fields" disabled={disabled}>
    <legend className="eyebrow">Delivery preferences</legend>
    <div className="delivery-profiles" role="group" aria-label="Delivery profile">
      {DELIVERY_PROFILES.map((profile) => <button key={profile.id} type="button" aria-pressed={value.profile === profile.id} onClick={() => onChange({ ...value, profile: profile.id, maxParallel: defaultDeliveryPolicy(profile.id).maxParallel })}>
        <strong>{profile.label}</strong>
        <span>{profile.hint}</span>
      </button>)}
    </div>
    <div className="grid-2">
      <label>Execution strategy
        <select value={value.strategy} onChange={(e) => onChange({ ...value, strategy: e.target.value as DeliveryPolicy["strategy"] })}>
          {Object.entries(STRATEGY_LABELS).map(([strategy, label]) => <option key={strategy} value={strategy} disabled={strategy === "native" && !nativeAvailable}>{label}{strategy === "native" && !nativeAvailable ? " (unavailable)" : ""}</option>)}
        </select>
        <span className="hint">Orchestra owns acceptance and integration for every strategy. Native delegation requires visible child calls and enforceable budgets.</span>
      </label>
      <label>Maximum parallel workers
        <input type="number" required min={1} max={6} step={1} value={value.maxParallel} onChange={(e) => onChange({ ...value, maxParallel: Number(e.target.value) })} />
        <span className="hint">An upper limit across this run. One worker remains sequential; independent review still uses the run budget.</span>
      </label>
    </div>
    <p className="hint">Required checks and Git safety apply to every profile. These preferences are remembered for this project when you start the run.</p>
  </fieldset>;
}
