import { useEffect, useState } from "react";
import type { CapacityProposal, CapacityTransfer, Run } from "../../shared/types.ts";
import { api } from "../api.ts";
import { Button, Notice } from "./UI.tsx";

type Props = { run: Run; busy: boolean; onTransfer: (transfers: CapacityTransfer[]) => Promise<boolean> };

export function CapacityTransfers(props: Props) {
  // Bun can refresh the browser bundle before the server loads the new routes.
  if (!props.run.capacityLimits) return <section className="panel capacity-transfers" aria-label="Agent availability">
    <h2>Agent availability</h2>
    <p>Restart Orchestra to enable task transfers. The server is running an older version. Your saved work is still available.</p>
  </section>;
  return <AvailableCapacityTransfers {...props} />;
}

function AvailableCapacityTransfers({ run, busy, onTransfer }: Props) {
  const [proposal, setProposal] = useState<CapacityProposal | null>(null);
  const [selected, setSelected] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [refresh, setRefresh] = useState(0);
  const revision = JSON.stringify([run.status, run.capacityLimits, run.quotaWait, run.error]);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError(null);
    void api<CapacityProposal>(`/api/runs/${run.id}/capacity`).then((value) => {
      if (!active) return;
      setProposal(value);
      const choices: Record<string, string> = {};
      for (const assignment of value.assignments) {
        const other = choices[`${assignment.taskId}:${assignment.kind === "worker" ? "reviewer" : "worker"}`];
        choices[`${assignment.taskId}:${assignment.kind}`] = assignment.candidateIds.find((id) => id !== other) ?? "";
      }
      setSelected(choices);
    }).catch((e: Error) => { if (active) setError(e.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [run.id, revision, refresh]);
  if (!run.capacityLimits?.length && !run.quotaWait && !run.rateLimitResumeAt && !proposal?.limits.length && !error) return null;
  const transfers = proposal?.assignments.map((assignment) => ({ taskId: assignment.taskId, kind: assignment.kind, fromAgentId: assignment.fromAgentId, agentId: selected[`${assignment.taskId}:${assignment.kind}`] ?? "" })) ?? [];
  const valid = transfers.length > 0 && transfers.every((transfer) => transfer.agentId && !transfers.some((other) => other.taskId === transfer.taskId && other.kind !== transfer.kind && other.agentId === transfer.agentId));
  return <section className="panel capacity-transfers" aria-labelledby="capacity-title">
    <h2 id="capacity-title">Move work to available agents</h2>
    <p>Agents using the same CLI share account limits. Orchestra checks the other team members’ quota before proposing a transfer.</p>
    {loading && <p role="status">Checking account availability…</p>}
    {error && <Notice>{error}</Notice>}
    {!loading && proposal && <>
      {proposal.directorBlocked && <p className="hint">The Director uses the limited account too. Its assignment is fixed for this run; moving tasks will still leave the run waiting for that account to recover.</p>}
      {proposal.assignments.map((assignment) => <label key={`${assignment.taskId}:${assignment.kind}`}>
        {assignment.title} · {assignment.kind === "worker" ? "Worker" : "Reviewer"}: {assignment.fromAgentName}
        <select value={selected[`${assignment.taskId}:${assignment.kind}`] ?? ""} disabled={busy} onChange={(event) => setSelected((previous) => ({ ...previous, [`${assignment.taskId}:${assignment.kind}`]: event.target.value }))}>
          <option value="">{assignment.candidateIds.length ? "Choose an agent" : "No confirmed capacity available"}</option>
          {assignment.candidateIds.map((id) => {
            const agent = proposal.agents.find((candidate) => candidate.id === id)!;
            return <option key={id} value={id}>{agent.name} · {agent.role} · {agent.windows.map((window) => `${Math.round((100 - window.usedPercent) * 10) / 10}% available (${window.window})`).join(", ")}</option>;
          })}
        </select>
      </label>)}
      {proposal.assignments.some((assignment) => !assignment.candidateIds.length) && <p className="hint">No eligible teammate has confirmed capacity for every assignment. Add a member on another available CLI to this team, then check again. Unreadable quota is treated as unknown.</p>}
      {!proposal.assignments.length && <p className="hint">{proposal.limits.some((limit) => limit.rerouted) && !proposal.directorBlocked ? "Transfers are saved. Use Continue remaining work below to resume." : "There are no unfinished task assignments to transfer at this checkpoint."}</p>}
      {!!transfers.length && <>
        <p className="hint">Review the proposed roles before applying. Files, checks and budgets are kept. A new worker starts a fresh conversation with the saved task context. Reviewers must remain independent.</p>
        <Button type="button" disabled={busy || !valid} onClick={async () => { if (await onTransfer(transfers)) setRefresh((value) => value + 1); }}>Apply transfers</Button>
      </>}
    </>}
    <Button type="button" variant="ghost" disabled={busy || loading} onClick={() => setRefresh((value) => value + 1)}>Check availability again</Button>
  </section>;
}
