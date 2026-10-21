import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultDeliveryPolicy, defaultRunControl } from "../src/shared/types.ts";
import type { Evidence, Requirement, Run } from "../src/shared/types.ts";
import { DeliveryFields } from "../src/web/components/DeliveryFields.tsx";
import { DeliveryOverview } from "../src/web/components/DeliveryOverview.tsx";
import { SkillPicker } from "../src/web/components/SkillPicker.tsx";
import { LessonProvenance } from "../src/web/components/ProjectMemory.tsx";
import { PlanReview } from "../src/web/components/PlanReview.tsx";
import { mergeAgentEvents, mergeEvidence, requirementResult } from "../src/web/model.ts";

const requirement: Requirement = { id: "checkout", title: "Complete checkout", description: "A customer can place an order.", kind: "command", check: "bun run test:checkout", required: true, inputs: ["src/checkout"], artifacts: ["reports/checkout.png"], version: 2, updatedAt: 1 };
const evidence = (overrides: Partial<Evidence> = {}): Evidence => ({ id: "proof", runId: "run", taskId: null, requirementIds: [requirement.id], requirementVersions: { checkout: 2 }, commit: "abcdef1234567890", scope: "acceptance", producer: "Orchestra · command check", command: "bun run test:checkout", status: "passed", output: "Checkout journey passed", durationMs: 4200, artifacts: ["reports/checkout.png"], createdAt: 100, ...overrides });
const run = (overrides: Partial<Run> = {}): Run => ({ ...defaultRunControl(), id: "run", prompt: "Build checkout", workdir: "/project", teamId: null, directorAgentId: "director", status: "running", plan: null, baseCommit: "base", branch: "orchestra/run", error: null, warning: null, autonomous: true, costUsd: 0, tokens: 0, recoveries: 0, fixRounds: 0, report: null, createdAt: 1, requirements: [requirement], acceptedCommit: "abcdef1234567890", ...overrides });

describe("delivery acceptance", () => {
  test("accepts only an acceptance record for the exact integration revision and requirement version", () => {
    expect(requirementResult(requirement, "abcdef1234567890", [evidence()]).status).toBe("satisfied");
    expect(requirementResult(requirement, "abcdef1234567890", [evidence({ scope: "task" })]).status).toBe("unverified");
    expect(requirementResult(requirement, "abcdef1234567890", [evidence({ scope: "integration" })]).status).toBe("unverified");
    expect(requirementResult(requirement, "changed-revision", [evidence()]).status).toBe("stale");
    expect(requirementResult({ ...requirement, version: 3 }, "abcdef1234567890", [evidence()]).status).toBe("stale");
    expect(requirementResult(requirement, null, [evidence()]).status).toBe("stale");
  });

  test("latest current failure replaces a pass, while unrelated and older revisions cannot override it", () => {
    const records = [evidence(), evidence({ id: "failed", createdAt: 200, status: "failed" }), evidence({ id: "old-revision", createdAt: 300, commit: "old" }), evidence({ id: "unrelated", createdAt: 400, requirementIds: ["another"] })];
    expect(requirementResult(requirement, "abcdef1234567890", records)).toMatchObject({ status: "failed", evidence: { id: "failed" } });
    expect(requirementResult(requirement, "abcdef1234567890", [])).toEqual({ status: "unverified", evidence: null });
  });

  test("an explicitly unverified acceptance record cannot become satisfied", () => {
    expect(requirementResult(requirement, "abcdef1234567890", [evidence({ status: "unverified" })]).status).toBe("unverified");
  });

  test("durable receipt order permits a passing repair to supersede failure when timestamps tie", () => {
    const failed = evidence({ id: "z-failed", status: "failed" });
    const repaired = evidence({ id: "a-pass" });
    expect(requirementResult(requirement, "abcdef1234567890", [failed, repaired]).status).toBe("satisfied");
    expect(requirementResult(requirement, "abcdef1234567890", [repaired, failed]).status).toBe("failed");
  });

  test("reconnect overlaps keep evidence and invocation history without duplicate ids", () => {
    const live = evidence({ id: "new", createdAt: 200 });
    expect(mergeEvidence([evidence(), live], [live]).map((entry) => entry.id)).toEqual(["proof", "new"]);
    const event = { id: "event", runId: "run", taskId: null, invocationId: "call", parentId: null, agentId: "worker", kind: "started" as const, text: "Working", ts: 200 };
    expect(mergeAgentEvents([event], [event])).toEqual([event]);
    const completion = { ...event, id: "a-completion", kind: "completed" as const };
    expect(mergeAgentEvents([event], [event, completion])).toEqual([event, completion]);
  });
});

test("the workspace exposes revision, command, producer, artifacts and unresolved outcomes", () => {
  const html = renderToStaticMarkup(<DeliveryOverview run={run({ acceptedCommit: "new-revision", recommendation: { strategy: "single", reason: "No independent work to parallelize.", samples: 0 } })} evidence={[evidence()]} events={[]} now={1000} />);
  expect(html).toContain("0 of 1 required outcomes verified");
  expect(html).toContain("Stale");
  expect(html).toContain("earlier revision or requirement version");
  expect(html).toContain("abcdef1234567890");
  expect(html).toContain("Orchestra · command check");
  expect(html).toContain("bun run test:checkout");
  expect(html).toContain("reports/checkout.png");
  expect(html).toContain("/api/runs/run/artifacts?evidence=proof&amp;index=0");
  expect(html).toContain("No independent work to parallelize.");
  expect(html).toContain("no project outcome history yet");
});

test("an older running server shows an upgrade notice without claiming delivery evidence is available", () => {
  const oldRun = run();
  delete (oldRun as Partial<Run>).delivery;
  const html = renderToStaticMarkup(<DeliveryOverview run={oldRun} evidence={[]} events={[]} />);
  expect(html).toContain("Delivery evidence requires a newer Orchestra server");
  expect(html).toContain("after active runs have stopped");
  expect(html).not.toContain("required outcomes verified");
  expect(html).not.toContain("Awaiting integration");
});

test("optional outcomes do not count as required acceptance", () => {
  const html = renderToStaticMarkup(<DeliveryOverview run={run({ requirements: [requirement, { ...requirement, id: "optional", title: "Extra polish", required: false }] })} evidence={[evidence()]} events={[]} />);
  expect(html).toContain("1 of 1 required outcomes verified");
  expect(html).toContain("Extra polish");
  expect(html).toContain("Unverified");
});

test("delivery controls expose all profiles and disable unsupported native delegation", () => {
  const html = renderToStaticMarkup(<DeliveryFields value={defaultDeliveryPolicy()} onChange={() => {}} />);
  for (const profile of ["Balanced", "Quality", "Speed", "Economy"]) expect(html).toContain(profile);
  expect(html).toContain('value="native" disabled=""');
  expect(html).toContain('min="1" max="6"');
  expect(html).toContain("Required checks and Git safety apply to every profile");
});

test("skill compatibility discloses source revision and runtime integration needs", () => {
  const html = renderToStaticMarkup(<SkillPicker value={[{ id: "owner/repo/learning", name: "Learning", description: "Learn from sessions", revision: "abc123def456", compatibility: { status: "integration-required", requiredTools: ["python3"], notices: ["Observation hooks require a separate plugin installation."] } }]} onChange={() => {}} />);
  expect(html).toContain("Integration needed");
  expect(html).toContain("abc123def456");
  expect(html).toContain("Required tools: python3");
  expect(html).toContain("Observation hooks require a separate plugin installation.");
});

test("lesson provenance exposes the source revision and evidence before the user remembers it", () => {
  const html = renderToStaticMarkup(<LessonProvenance lesson={{ id: "lesson", runId: "run", commit: "abcdef1234567890", text: "Check the checkout journey after changing payment.", evidenceIds: ["acceptance-proof"], status: "proposed", createdAt: 100 }} busy={false} onChange={() => {}} />);
  expect(html).toContain("Source run");
  expect(html).toContain("abcdef1234567890");
  expect(html).toContain("acceptance-proof");
  expect(html).toContain("Remember lesson");
  expect(html).toContain("Retire lesson");
});

test("plan approval makes requirement amendments and weakened acceptance visible", () => {
  const amended = { ...requirement, required: false, check: "bun run test:checkout:new" };
  const current = run({ plan: { version: 2, summary: "Repair checkout", stage: "fix", verify: "bun test", lessons: "", requirements: [amended], tasks: [] } });
  const html = renderToStaticMarkup(<PlanReview run={current} finished={[]} team={[]} agentName={(id) => id} busy={null} onApprove={() => {}} onRevise={() => {}} onSave={async () => true} />);
  expect(html).toContain("Amends an existing requirement");
  expect(html).toContain("makes a previously required outcome optional");
  expect(html).toContain("bun run test:checkout:new");
});

test("invocation technical details expose the recorded runtime and inherited environment", () => {
  const html = renderToStaticMarkup(<DeliveryOverview run={run()} evidence={[]} events={[{ id: "call", invocationId: "call", runId: "run", taskId: null, parentId: null, agentId: "worker", kind: "started", text: "Working", ts: 1, manifest: { runtime: "codex", version: "codex-cli fixture", model: "fixture-model", effort: "high", transport: "app-server", skills: [{ id: "owner/repo/testing", revision: "skill-revision" }], environment: { sources: [{ kind: "hooks", scope: "project", path: "/project/.codex/config.toml", count: 3 }], notices: ["Inventory may include further managed instructions."] } } }]} />);
  expect(html).toContain("Invocation configuration");
  expect(html).toContain("codex-cli fixture");
  expect(html).toContain("fixture-model");
  expect(html).toContain("App server");
  expect(html).toContain("skill-revision");
  expect(html).toContain("/project/.codex/config.toml");
  expect(html).toContain("<td>3</td>");
  expect(html).toContain("Inventory may include further managed instructions.");
});
