import { expect, test } from "bun:test";
import type { Agent, Task } from "../src/shared/types.ts";
import type { AgentResult } from "../src/server/runtimes.ts";
import { invokeRequirementReviews, invokeReview, requirementReviewsJsonSchema, reviewJsonSchema } from "../src/server/review.ts";

const reviewer: Agent = { id: "qa", name: "QA", runtime: "codex", model: null, effort: null, role: "Reviewer", expertise: "", skills: [], instructions: "Check data integrity", createdAt: 0 };
const task: Task = {
  previousAgentIds: [], attempt: 1,
  phase: "work", cycle: 1, startCommit: null, handoff: null, contract: { requirementIds: [], inputs: [], outputs: [], resources: [] }, contextVersions: {}, id: "t", runId: "r", key: "api", title: "API", description: "Implement endpoint", acceptance: "Returns JSON",
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

test("review receives bounded automatic evidence without treating unverified behavior as passing", async () => {
  await invokeReview(async (inv) => {
    expect(inv.prompt).toContain('"commit":"checked-head"');
    expect(inv.prompt).toContain('"ok":false');
    expect(inv.prompt).toContain("browser assertion failed");
    expect(inv.prompt).not.toContain("discarded-prefix");
    expect(inv.prompt).toContain("Required behavior without evidence still needs verification");
    return { ok: true, text: "", structured: { verdict: "changes", findings: "Browser behavior needs a fix" } };
  }, { ...options, checks: [{ command: "bun run test:browser", ok: false, commit: "checked-head", producer: "orchestra:task", output: `discarded-prefix${"x".repeat(4000)}browser assertion failed` }] });
});

test("UI review distinguishes fidelity defects and missing browser evidence from personal preferences", async () => {
  const uiReviewer = { ...reviewer, expertise: "Responsive layout and visual accessibility" };
  const uiTask = { ...task, title: "Reading dashboard", description: "Follow docs/design/ux.md. Inspect evidence/desktop.png and evidence/narrow.png.", acceptance: "Primary journey works at desktop and narrow viewports; layout matches the visual contract." };
  await invokeReview(async (inv) => {
    for (const value of ["Responsive layout and visual accessibility", "evidence/desktop.png", "evidence/narrow.png", "affected screen/viewport, violated criterion, evidence", "Personal style preferences and unrelated redesigns are not defects", "required browser evidence or image-inspection tools are missing", "instead of asserting a visual pass"]) expect(inv.prompt).toContain(value);
    expect(inv.prompt).toContain("passing code checks alone do not establish visual fidelity");
    return { ok: true, text: "", structured: { verdict: "changes", findings: "1. Missing narrow-screen screenshot: run the required browser journey before visual approval." } };
  }, { ...options, reviewer: uiReviewer, task: uiTask });
});

test("failed reviewers and malformed answers cannot approve work", async () => {
  await expect(answer({ ok: false, text: '{"verdict":"approve","findings":""}', error: "rate limited" })).rejects.toThrow("Reviewer failed: rate limited");
  await expect(answer({ ok: true, text: "looks good" })).rejects.toThrow("Reviewer did not return JSON");
  for (const structured of [{ verdict: "approve" }, { verdict: "maybe", findings: "" }, { verdict: "approve", findings: "", extra: true }, null]) {
    await expect(answer({ ok: true, text: "", structured })).rejects.toThrow("Reviewer answer does not match the schema");
  }
});

const requirements = [
  { id: "journey", title: "Primary journey", description: "The complete browser journey succeeds." },
  { id: "visual", title: "Visual fidelity", description: "Desktop and narrow screenshots match the visual contract." },
];
const batchOptions = { reviewer, author: "Dev", diff: "+dashboard", cwd: "/scratch", onLog: () => {}, requirements };

test("one readonly call returns separate requirement verdicts in requested order with complete criteria", async () => {
  const complete = [{ ...requirements[0]!, description: `${"criterion ".repeat(450)}FINAL ACCEPTANCE CRITERION` }, requirements[1]!];
  const signal = AbortSignal.abort();
  let calls = 0;
  const result = await invokeRequirementReviews(async (inv) => {
    calls++;
    expect(inv).toMatchObject({ mode: "readonly", cwd: "/scratch", agent: reviewer, signal, schema: requirementReviewsJsonSchema, onLog: batchOptions.onLog });
    expect(inv.prompt).toContain(JSON.stringify(complete));
    expect(inv.prompt).toContain("FINAL ACCEPTANCE CRITERION");
    expect(inv.prompt.split("SHARED ORIGINAL BRIEF")).toHaveLength(2);
    expect(inv.prompt).toContain("one passing requirement cannot substitute for another");
    expect(inv.prompt).toContain("CURRENT CHECK TAIL");
    expect(inv.prompt).not.toContain("discarded-check-prefix");
    return { ok: true, text: "", structured: { requirements: [{ id: "visual", verdict: "changes", findings: "1. The narrow screenshot clips the primary action." }, { id: "journey", verdict: "approve", findings: "Browser assertions cover the complete journey." }] } };
  }, { ...batchOptions, requirements: complete, context: "SHARED ORIGINAL BRIEF", signal, checks: [{ command: "browser", ok: true, commit: "checked-revision", producer: "orchestra:requirement", output: `discarded-check-prefix${"x".repeat(5000)}CURRENT CHECK TAIL` }] });
  expect(calls).toBe(1);
  expect(result).toEqual([{ id: "journey", verdict: "approve", findings: "Browser assertions cover the complete journey." }, { id: "visual", verdict: "changes", findings: "1. The narrow screenshot clips the primary action." }]);
  expect(requirementReviewsJsonSchema.additionalProperties).toBe(false);
  expect(requirementReviewsJsonSchema.required).toEqual(["requirements"]);
  const item = (requirementReviewsJsonSchema as any).properties.requirements.items;
  expect(item.additionalProperties).toBe(false);
  expect(item.required).toEqual(["id", "verdict", "findings"]);
});

test("single requirement reuses the existing review schema and empty input makes no call", async () => {
  let calls = 0;
  const runner = async (inv: Parameters<Parameters<typeof invokeRequirementReviews>[0]>[0]) => {
    calls++;
    expect(inv.schema).toBe(reviewJsonSchema);
    return { ok: true, text: JSON.stringify({ verdict: "approve", findings: "Checked" }) };
  };
  expect(await invokeRequirementReviews(runner, { ...batchOptions, requirements: [] })).toEqual([]);
  expect(calls).toBe(0);
  expect(await invokeRequirementReviews(runner, { ...batchOptions, requirements: [requirements[0]!] })).toEqual([{ id: "journey", verdict: "approve", findings: "Checked" }]);
  expect(calls).toBe(1);
});

test("batched requirement reviews reject incomplete, duplicate, unknown and malformed verdicts", async () => {
  const approved = { id: "journey", verdict: "approve", findings: "" };
  const cases: [unknown, string][] = [
    [{ requirements: [approved] }, "omitted ids: visual"],
    [{ requirements: [approved, approved] }, 'duplicate id "journey"'],
    [{ requirements: [approved, { ...approved, id: "invented" }] }, 'unknown id "invented"'],
    [{ requirements: [approved, { id: "visual", verdict: "approve" }] }, "does not match the schema"],
    [{ requirements: [approved, { id: "visual", verdict: "maybe", findings: "" }] }, "does not match the schema"],
    [{ requirements: [approved, { id: "visual", verdict: "approve", findings: "", extra: true }] }, "does not match the schema"],
  ];
  for (const [structured, error] of cases) await expect(invokeRequirementReviews(async () => ({ ok: true, text: JSON.stringify(structured) }), batchOptions)).rejects.toThrow(error);
  await expect(invokeRequirementReviews(async () => ({ ok: false, text: "", error: "quota" }), batchOptions)).rejects.toThrow("Reviewer failed: quota");
  await expect(invokeRequirementReviews(async () => ({ ok: true, text: "looks good" }), batchOptions)).rejects.toThrow("Reviewer did not return JSON");
  let called = false;
  const runner = async () => { called = true; return { ok: true, text: "" }; };
  await expect(invokeRequirementReviews(runner, { ...batchOptions, requirements: [requirements[0]!, requirements[0]!] })).rejects.toThrow("inputs contain duplicate ids");
  await expect(invokeRequirementReviews(runner, { ...batchOptions, requirements: Array.from({ length: 61 }, (_, index) => ({ ...requirements[0]!, id: `requirement-${index}` })) })).rejects.toThrow("exceeds 60 requirements");
  expect(called).toBe(false);
});
