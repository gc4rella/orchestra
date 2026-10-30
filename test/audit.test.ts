import { expect, test } from "bun:test";
import { knownTaskAuthors } from "../src/server/audit.ts";
import type { AgentEvent, AuditRecord } from "../src/shared/types.ts";

test("known authors reconstruct recorded legacy worker participation after an earlier reassignment lost its author list", () => {
  const task = { id: "task", agentId: "replacement", previousAgentIds: ["saved-earlier-author"] };
  const event = (agentId: string, taskId: string, text: string, kind: AgentEvent["kind"] = "started"): AgentEvent => ({ id: agentId, runId: "run", taskId, invocationId: agentId, parentId: null, agentId, kind, text, ts: 1 });
  const start = (agentId: string, purpose: string, taskId = "task"): AuditRecord => ({ kind: "invocation-started", id: agentId, runId: "run", taskId, ts: 2, invocationId: agentId,
    agent: { id: agentId, name: "Historical actor name", role: "Engineer", runtime: "codex", model: null, effort: null },
    purpose, phase: "work", attempt: 1, inputCommit: "input", promptDigest: "prompt", guidanceDigest: "guidance",
    manifest: { runtime: "codex", version: null, model: null, effort: null, transport: "batch", skills: [], environment: { sources: [], notices: [] } }, registeredSkills: [], selectedSkills: [],
  });
  const audit = [start("audited-author", "work"), start("old-audited-author", "worker"), start("conflict-author", "conflict-resolution"), start("reviewer", "task-review"), start("other-task-author", "work", "other-task")];
  const events = [event("lost-original-author", "task", "Original name: worker"), event("legacy-reviewer", "task", "Reviewer: readonly"), event("legacy-other-task", "other-task", "Other: worker"), event("native-child", "task", "Child: worker", "child-started"), event("summary-claim", "task", "I wrote the files: worker", "completed")];
  expect(knownTaskAuthors([task], audit, events)).toEqual(new Set(["replacement", "saved-earlier-author", "audited-author", "old-audited-author", "conflict-author", "lost-original-author"]));
  expect(task.previousAgentIds).toEqual(["saved-earlier-author"]);
});

test("missing legacy invocation history does not invent authors or borrow them from other task IDs", () => {
  const task = { id: "unrecorded", agentId: "known-current-owner", previousAgentIds: [] };
  expect(knownTaskAuthors([task], [], [])).toEqual(new Set(["known-current-owner"]));
  expect(knownTaskAuthors([], [], [])).toEqual(new Set());
});
