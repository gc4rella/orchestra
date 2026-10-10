import { expect, test } from "bun:test";
import type { Agent, Task } from "../src/shared/types.ts";
import type { AgentResult } from "../src/server/runtimes.ts";
import { invokeReview, reviewJsonSchema } from "../src/server/review.ts";

const reviewer: Agent = { id: "qa", name: "QA", runtime: "codex", model: null, role: "Reviewer", skills: "", instructions: "Check data integrity", createdAt: 0 };
const task: Task = {
  phase: "work", cycle: 1, startCommit: null, handoff: null, id: "t", runId: "r", key: "api", title: "API", description: "Implement endpoint", acceptance: "Returns JSON",
  agentId: "dev", reviewerId: "qa", dependsOn: [], stage: "build", status: "running", summary: null, error: null,
  feedback: null, session: null, iterations: 1, costUsd: 0, tokens: 0, mergeCommit: null, startedAt: null, finishedAt: null };
const options = { reviewer, task, author: "Dev", diff: "+endpoint", cwd: "/scratch", onLog: () => {} };
const answer = (result: AgentResult) => invokeReview(async () => result, options);

test("review passes task, diff, instructions, cancellation and strict schema to a readonly invocation", async () => {
  const signal = AbortSignal.abort();
  const result = await invokeReview(async (inv) => {
    expect(inv).toMatchObject({ agent: reviewer, mode: "readonly", cwd: "/scratch", schema: reviewJsonSchema, signal });
    for (const text of ["Check data integrity", "Implement endpoint", "Returns JSON", "+endpoint", "Dev"]) expect(inv.prompt).toContain(text);
    return { ok: true, text: "", structured: { verdict: "approve", findings: "" } };
  }, { ...options, signal });
  expect(result.verdict).toBe("approve");
  expect(reviewJsonSchema.additionalProperties).toBe(false);
  expect(reviewJsonSchema.required).toEqual(["verdict", "findings"]);
});

test("Codex final JSON text and Claude structured output use the same validation", async () => {
  const changes = { verdict: "changes" as const, findings: "1. Return a JSON content type" };
  expect(await answer({ ok: true, text: JSON.stringify(changes) })).toEqual(changes);
  expect(await answer({ ok: true, text: "ignored", structured: changes })).toEqual(changes);
});

test("failed reviewers and malformed answers cannot approve work", async () => {
  await expect(answer({ ok: false, text: '{"verdict":"approve","findings":""}', error: "rate limited" })).rejects.toThrow("Reviewer failed: rate limited");
  await expect(answer({ ok: true, text: "looks good" })).rejects.toThrow("Reviewer did not return JSON");
  for (const structured of [{ verdict: "approve" }, { verdict: "maybe", findings: "" }, { verdict: "approve", findings: "", extra: true }, null]) {
    await expect(answer({ ok: true, text: "", structured })).rejects.toThrow("Reviewer answer does not match the schema");
  }
});
