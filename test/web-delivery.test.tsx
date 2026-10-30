import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { defaultDeliveryPolicy, defaultRunControl } from "../src/shared/types.ts";
import type { AuditRecord, Evidence, Requirement, Run } from "../src/shared/types.ts";
import { DeliveryFields } from "../src/web/components/DeliveryFields.tsx";
import { DeliveryOverview, EvidenceDetails, historyPage } from "../src/web/components/DeliveryOverview.tsx";
import { AuditDetails } from "../src/web/components/RuntimeDetails.tsx";
import { SkillPicker } from "../src/web/components/SkillPicker.tsx";
import { LessonProvenance } from "../src/web/components/ProjectMemory.tsx";
import { PlanReview, TaskContractFields } from "../src/web/components/PlanReview.tsx";
import { mergeAgentEvents, mergeEvidence, requirementResult } from "../src/web/model.ts";
import { PresetSkillSuggestions, statsLine } from "../src/web/pages/Agents.tsx";

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

test("every history record remains reachable through paging and search beyond the previous display caps", () => {
  const records = Array.from({ length: 105 }, (_, index) => evidence({ id: `receipt-${index}`, output: `Journey ${index}` }));
  const reached = Array.from({ length: 6 }, (_, page) => historyPage(records, "", page, JSON.stringify).records).flat();
  expect(reached.map((entry) => entry.id)).toEqual(records.map((entry) => entry.id));
  expect(historyPage(records, "journey 104", 0, JSON.stringify).records[0]?.id).toBe("receipt-104");
  expect(historyPage(records, "not found", 500, JSON.stringify)).toMatchObject({ total: 0, pages: 1, page: 0 });
  const html = renderToStaticMarkup(<DeliveryOverview run={run()} evidence={records} events={[]} />);
  expect(html).toContain("Search evidence");
  expect(html).toContain("1–20 of 105");
  expect(html).toContain("Page 1 of 6");
  expect(html).toContain("Next");
  expect(html).toContain("Download audit JSON");
  expect(html).not.toContain("Showing the 40 most recent");
});

test("screenshots expose the exact evidence revision with safe raster previews and downloads", () => {
  const html = renderToStaticMarkup(<EvidenceDetails evidence={evidence({ artifacts: ["journey.png", "report.html", "design.svg"] })} />);
  expect(html).toContain('/api/runs/run/artifacts/preview?evidence=proof&amp;index=0');
  expect(html).toContain('loading="lazy"');
  expect(html).toContain("acceptance evidence at abcdef123456");
  expect(html).toContain("Evidence proof");
  expect(html).not.toContain("artifacts/preview?evidence=proof&amp;index=1");
  expect(html).not.toContain("artifacts/preview?evidence=proof&amp;index=2");
  expect(html).toContain("report.html");
});

test("the audit trail shows stable actor configuration, selected skills, retry history and unknown usage", () => {
  const started: AuditRecord = { id: "audit-start", ts: 1, runId: "run", taskId: "task", kind: "invocation-started", invocationId: "call", agent: { id: "worker", name: "Historical designer", role: "Designer", runtime: "codex", model: "saved-model", effort: "high" }, purpose: "work", phase: "work", attempt: 2, inputCommit: "checked-input", promptDigest: "saved-prompt-digest", guidanceDigest: "saved-guidance-digest", registeredSkills: [{ id: "owner/repo/design", revision: "pinned" }], selectedSkills: [{ id: "owner/repo/design", revision: "pinned" }], manifest: { runtime: "codex", version: "fixture", model: "saved-model", effort: "high", transport: "batch", skills: [], environment: { sources: [], notices: [] } } };
  const html = renderToStaticMarkup(<DeliveryOverview run={run()} evidence={[]} events={[{ id: "event", runId: "run", taskId: "task", invocationId: "call", parentId: null, agentId: "worker", kind: "started", text: "Work", ts: 1 }]} audit={[started]} agentName={() => "Renamed agent"} />);
  expect(html).toContain("Historical designer");
  expect(html).not.toContain("Renamed agent");
  for (const value of ["Attempt 2", "saved-model", "saved-prompt-digest", "checked-input", "Selected skill instructions", "owner/repo/design", "does not prove the agent followed them"]) expect(html).toContain(value);
  const completion = renderToStaticMarkup(<AuditDetails record={{ id: "finish", ts: 2, runId: "run", taskId: "task", kind: "invocation-finished", invocationId: "call", status: "interrupted", usage: null, error: "Interrupted", skillClaims: ["Design skill"] }} />);
  expect(completion).toContain("interrupted");
  expect(completion).toContain("Not reported");
  expect(completion).toContain("Agent claims, not independent evidence");
});

test("incomplete historical agent metrics do not claim known first-pass quality or complete usage", () => {
  const partial = statsLine({ done: 2, failed: 1, firstTry: 0, avgAttempts: 1, reviews: 1, costUsd: 0, tokens: 120, usageIncomplete: true, attemptsIncomplete: true });
  expect(partial).toContain("120 tokens reported; usage incomplete");
  expect(partial).toContain("Attempt history incomplete");
  expect(partial).not.toContain("first time");
  expect(partial).not.toContain("avg");
  expect(statsLine({ done: 0, failed: 0, firstTry: 0, avgAttempts: null, reviews: 0, costUsd: 0, tokens: 0, usageIncomplete: true })).toBe("Usage not fully reported");
});

test("task contract editing exposes installed skill bounds and retains invalid selections after reassignment", () => {
  const task = { id: "ui", title: "UI", description: "Build UI", agentId: "worker", reviewerId: "", dependsOn: [], acceptanceCriteria: "UI works", contract: { requirementIds: ["checkout"], inputs: ["src"], outputs: ["src/ui.tsx"], resources: [], skillIds: ["owner/repo/missing"], ui: true } };
  const html = renderToStaticMarkup(<TaskContractFields task={task} agent={{ id: "worker", name: "Worker", role: "Frontend Engineer", runtime: "codex", model: null, effort: null, expertise: "", skills: [{ id: "owner/repo/installed", name: "Installed skill", description: "Available" }], instructions: null, createdAt: 1 }} disabled={false} onChange={() => {}} />);
  expect(html).toContain("Selected installed skills · up to 3");
  expect(html).toContain("Installed skill");
  expect(html).toContain("Remove unavailable skill");
  expect(html).toContain("The UI quality contract is retained");
  expect(html).toContain('checked=""');
  const legacy = renderToStaticMarkup(<TaskContractFields task={{ ...task, contract: { requirementIds: ["checkout"], inputs: [], outputs: [], resources: [] } }} agent={undefined} disabled={false} onChange={() => {}} />);
  expect(legacy).toContain("legacy task has no explicit skill selection");
});

test("existing agents get missing role recommendations without silently changing installed packs", () => {
  const html = renderToStaticMarkup(<PresetSkillSuggestions role=" Full-stack Engineer " skills={[]} onAdd={() => {}} />);
  expect(html).toContain("anthropics/skills/frontend-design");
  expect(html).toContain("Add to draft");
  expect(html).toContain("unchanged until you save");
  expect(html).toContain("third-party instructions");
  const installed = renderToStaticMarkup(<PresetSkillSuggestions role="Product Designer" skills={[{ id: "anthropics/skills/frontend-design", name: "Frontend design", description: "Design" }]} onAdd={() => {}} />);
  expect(installed).not.toContain("anthropics/skills/frontend-design");
  expect(installed).toContain("web-design-guidelines");
});

test("delivery timings distinguish first runnable and accepted outcomes from later cycles", () => {
  const html = renderToStaticMarkup(<DeliveryOverview run={run({ cycle: 4, continuous: true, firstRunnable: { at: 100, elapsedMs: 90000, commit: "first-preview", draft: true }, firstAccepted: { at: 200, elapsedMs: 240000, commit: "first-accept" } })} evidence={[]} events={[]} />);
  for (const text of ["First runnable preview", "First accepted goal", "first-preview", "first-accept", "checks pending", "later improvement time is separate"]) expect(html).toContain(text);
  const legacy = renderToStaticMarkup(<DeliveryOverview run={run()} evidence={[]} events={[]} />);
  expect(legacy).not.toContain("First accepted goal");
});

test("cost-only invocation usage never displays compatibility token zero as measured usage", () => {
  const html = renderToStaticMarkup(<AuditDetails record={{ id: "cost-only", ts: 1, runId: "run", taskId: null, kind: "invocation-finished", invocationId: "cost-call", status: "completed", usage: { tokens: 0, tokensReported: false, costUsd: 0.02 }, error: null }} />);
  expect(html).toContain("<dt>Tokens</dt><dd>Not reported</dd>");
  expect(html).toContain("<dt>Cost (USD)</dt><dd>0.02</dd>");
});
