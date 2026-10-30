import type { AgentEvent, AgentStats, AuditRecord, Task } from "../shared/types.ts";

type Start = Extract<AuditRecord, { kind: "invocation-started" }>;
type Finish = Extract<AuditRecord, { kind: "invocation-finished" }>;
type Outcome = { agentId: string; taskId: string; attempt: number; status: "done" | "failed"; recorded: boolean };

/** Recorded write-capable participation excludes an independent review; missing history remains unknown. */
export function knownTaskAuthors(tasks: Pick<Task, "id" | "agentId" | "previousAgentIds">[], audit: readonly AuditRecord[], events: readonly AgentEvent[]): Set<string> {
  const taskIds = new Set(tasks.map((task) => task.id));
  const authors = new Set(tasks.flatMap((task) => [task.agentId, ...task.previousAgentIds]));
  for (const record of audit) {
    if (record.kind === "invocation-started" && record.taskId !== null && taskIds.has(record.taskId) && ["work", "worker", "conflict-resolution"].includes(record.purpose)) authors.add(record.agent.id);
  }
  for (const event of events) {
    if (event.kind === "started" && event.taskId !== null && taskIds.has(event.taskId) && event.text.endsWith(": worker")) authors.add(event.agentId);
  }
  return authors;
}

/** Task totals mix several callers and cannot establish historical per-agent usage. */
export function agentStatistics(tasks: (Task & { auditLegacy: boolean })[], audit: AuditRecord[]): Record<string, AgentStats> {
  const stats: Record<string, AgentStats> = {};
  const get = (id: string) => stats[id] ??= { done: 0, failed: 0, firstTry: 0, avgAttempts: null, costUsd: 0, tokens: 0, reviews: 0 };
  const starts = audit.filter((record): record is Start => record.kind === "invocation-started");
  const finishes = new Map(audit.filter((record): record is Finish => record.kind === "invocation-finished").map((record) => [record.invocationId, record]));
  const workCalls = new Map<string, Start[]>();
  const reviewedTasks = new Set<string>();
  for (const start of starts) {
    const stat = get(start.agent.id);
    const finish = finishes.get(start.invocationId);
    if (start.taskId && (start.purpose === "work" || start.purpose === "worker")) {
      const calls = workCalls.get(start.taskId) ?? [];
      calls.push(start);
      workCalls.set(start.taskId, calls);
    }
    if (start.purpose.includes("review")) {
      if (start.taskId) reviewedTasks.add(start.taskId);
      if (finish?.status === "completed") stat.reviews++;
    }
    if (!finish?.usage) stat.usageIncomplete = true;
    else {
      stat.tokens += finish.usage.tokens;
      stat.costUsd += finish.usage.costUsd ?? 0;
      if (finish.usage.costUsd === null || finish.usage.tokensReported === false) stat.usageIncomplete = true;
    }
  }

  const outcomes = new Map<string, Outcome>();
  for (const record of audit) {
    if (record.kind !== "task-phase" && record.kind !== "task-attempt") continue;
    if (record.status !== "done" && record.status !== "failed") continue;
    outcomes.set(`${record.taskId}:${record.attempt}`, { agentId: record.agentId, taskId: record.taskId, attempt: record.attempt, status: record.status, recorded: true });
  }
  const taskById = new Map(tasks.map((task) => [task.id, task]));
  for (const task of tasks) {
    const stat = get(task.agentId);
    const calls = workCalls.get(task.id) ?? [];
    if (task.auditLegacy || !calls.length) {
      stat.usageIncomplete = true;
      stat.attemptsIncomplete = true;
    }
    const key = `${task.id}:${task.attempt}`;
    if ((task.status === "done" || task.status === "failed") && !outcomes.has(key)) {
      outcomes.set(key, { agentId: task.agentId, taskId: task.id, attempt: task.attempt, status: task.status, recorded: false });
    }
    if (task.reviewerId && task.status === "done" && !reviewedTasks.has(task.id)) {
      const reviewer = get(task.reviewerId);
      reviewer.reviews++;
      reviewer.usageIncomplete = true;
      reviewer.attemptsIncomplete = true;
    }
  }
  const attemptTotals = new Map<string, { count: number; total: number }>();
  for (const outcome of outcomes.values()) {
    const stat = get(outcome.agentId);
    stat[outcome.status]++;
    const task = taskById.get(outcome.taskId);
    const calls = workCalls.get(outcome.taskId) ?? [];
    const complete = outcome.recorded && task && !task.auditLegacy && calls.length > 0;
    if (!complete) stat.attemptsIncomplete = true;
    if (outcome.status !== "done" || !complete) continue;
    const total = attemptTotals.get(outcome.agentId) ?? { count: 0, total: 0 };
    total.count++;
    total.total += calls.length;
    attemptTotals.set(outcome.agentId, total);
    if (outcome.attempt === 1 && calls.length === 1 && task.iterations === 1 && finishes.get(calls[0]!.invocationId)?.status === "completed") stat.firstTry++;
  }
  for (const [id, total] of attemptTotals) get(id).avgAttempts = total.total / total.count;
  return stats;
}
