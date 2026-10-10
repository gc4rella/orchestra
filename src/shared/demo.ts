import { isDirector, type Agent, type RuntimeInfo, type Run, type Task } from "./types.ts";

export const DEMO_LIMITS = { maxDurationMs: 5 * 60_000, maxAgentCalls: 12 };
export const DEMO_PROMPT = "Autonomy demo: build a tiny Bun TypeScript arithmetic utility exporting add(a, b).\nInclude useful tests and README usage. Skip definition. Use at least two dependent tasks assigned to different teammates so the test author builds on the implementation handoff. Leave each task passing a noninteractive verify command. Once the basic goal is verified, improve its tests or documentation within this brief if useful; stop when no worthwhile improvement remains. Do not add dependencies or unrelated features.";

export function demoReadiness(agents: Agent[], runtimes: RuntimeInfo[]): string | null {
  if (!agents.some(isDirector) || agents.filter((agent) => !isDirector(agent)).length < 2)
    return "Add a Director and at least two team members to demonstrate an agent-to-agent handoff.";
  if (agents.some((agent) => !runtimes.some((runtime) => runtime.runtime === agent.runtime && runtime.installed)))
    return "Install every runtime used by your team before starting the demo.";
  return null;
}

/** A budget pause is an unfinished demonstration, not a failed run or a passing handoff test. */
export function describeDemoResult(
  run: Pick<Run, "status" | "error" | "pauseReason" | "agentCalls" | "limits">,
  tasks: Pick<Task, "status" | "key" | "dependsOn" | "handoff" | "mergeCommit">[],
): string {
  if (run.limits && run.agentCalls > run.limits.maxAgentCalls) throw new Error("Agent-call budget exceeded");
  if (run.status === "failed") throw new Error(run.error ?? "Demo run failed");
  const handedOff = tasks.some((task) => task.status === "done" && task.dependsOn.some((key) => tasks.some((prior) => prior.key === key && prior.handoff && prior.mergeCommit)));
  const merged = tasks.filter((task) => task.status === "done").length;
  if (run.status === "paused")
    return `PAUSED: ${run.pauseReason ?? "Run paused"}. ${merged} merged tasks, ${run.agentCalls} calls, unchanged checkout. ${handedOff ? "A dependent-agent handoff completed; the run is unfinished." : "The dependent-agent handoff has not completed yet."} Work and checkpoints are preserved; extend the total budget and resume in the UI.`;
  if (run.status !== "completed") throw new Error(`Unexpected demo status: ${run.status}`);
  if (!handedOff) throw new Error("Demo completed without a completed agent-to-agent handoff; inspect retained output");
  return `PASS: automatic handoff, ${merged} merged tasks, ${run.agentCalls} calls, unchanged checkout. Final status: completed.`;
}
