import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Evidence, Plan, Requirement, RequirementSpec, Run } from "../src/shared/types.ts";
import { defaultDeliveryPolicy, defaultRunControl } from "../src/shared/types.ts";
import { captureArtifacts } from "../src/server/artifacts.ts";
import { mergeRequirements, recommendStrategy, requirementStatus } from "../src/server/delivery.ts";
import { planJsonSchema, validatePlan } from "../src/server/director.ts";

const spec: RequirementSpec = { id: "journey", title: "Complete journey", description: "The user can complete the workflow", required: true, kind: "command", check: "bun test", inputs: ["src/api.ts"], artifacts: ["evidence/journey.png"] };
const requirement: Requirement = { ...spec, version: 1, updatedAt: 1 };
const plan = (): Plan => ({ version: 2, requirements: [structuredClone(spec)], summary: "Implement the workflow", stage: "build", verify: "bun test", lessons: "", tasks: [
  { id: "api", title: "API", description: "Implement API", agentId: "dev", reviewerId: "qa", dependsOn: [], acceptanceCriteria: "The workflow passes", contract: { requirementIds: ["journey"], inputs: ["src/api.ts"], outputs: ["src"], resources: ["database"] } },
  { id: "ui", title: "UI", description: "Implement UI", agentId: "dev", reviewerId: "qa", dependsOn: [], acceptanceCriteria: "The workflow passes", contract: { requirementIds: ["journey"], inputs: [], outputs: ["web"], resources: [] } },
] });
const agents = new Set(["dev", "qa"]);

test("versioned plans validate requirements and task contracts through the strict schema", () => {
  const value = plan();
  expect(validatePlan(value, agents)).toEqual(value);
  const check = (schema: any) => {
    if (schema.type === "object") {
      expect(schema.additionalProperties).toBe(false);
      expect(new Set(schema.required)).toEqual(new Set(Object.keys(schema.properties)));
      Object.values(schema.properties).forEach(check);
    }
    if (schema.items) check(schema.items);
  };
  check(planJsonSchema);
});

test("untrusted plans cannot invent requirement references, omit criteria or use unsafe paths", () => {
  const unknown = plan(); unknown.tasks[0]!.contract!.requirementIds = ["unknown"];
  expect(() => validatePlan(unknown, agents)).toThrow("known requirements");
  const empty = plan(); empty.tasks[0]!.acceptanceCriteria = " ";
  expect(() => validatePlan(empty, agents)).toThrow("acceptance criteria");
  for (const path of ["../secret", "/etc/passwd", "src/*.ts", "src/../secret", "src\\secret"]) {
    const unsafe = plan(); unsafe.requirements![0]!.artifacts = [path];
    expect(() => validatePlan(unsafe, agents)).toThrow("invalid project paths");
  }
  const duplicate = plan(); duplicate.requirements!.push(structuredClone(spec));
  expect(() => validatePlan(duplicate, agents)).toThrow("duplicate requirement");
});

test("uppercase requirement labels and exact task references survive validation unchanged", () => {
  const ids = ["R-VERIFY", "R-BUILD-PROD", "R-PRD-FUNC", "R-UI-MOBILE", "R-RELEASE-DOCS"];
  const value = plan();
  value.requirements = ids.map((id) => ({ ...spec, id }));
  for (const task of value.tasks) task.contract!.requirementIds = [...ids];
  const before = JSON.stringify(value);
  expect(validatePlan(value, agents)).toEqual(value);
  expect(JSON.stringify(value)).toBe(before);
  const current = mergeRequirements([], value.requirements, 1);
  const continuing = { ...value, requirements: [] };
  expect(validatePlan(continuing, agents, { requirements: current })).toEqual(continuing);
  expect(mergeRequirements(current, value.requirements, 2)).toEqual(current);
  const receipt: Evidence = { id: "e", runId: "r", taskId: null, scope: "acceptance", producer: "orchestra:requirement", commit: "head", requirementIds: ids, requirementVersions: Object.fromEntries(ids.map((id) => [id, 1])), command: spec.check, status: "passed", output: "", durationMs: 1, artifacts: [], createdAt: 1 };
  expect(current.every((requirement) => requirementStatus(requirement, [receipt], "head") === "satisfied")).toBe(true);
  value.tasks[0]!.contract!.requirementIds = ["r-verify"];
  expect(() => validatePlan(value, agents)).toThrow("must reference known requirements");
});

test("requirement format errors differ from duplicate errors and task ids remain lowercase", () => {
  for (const id of ["", "-VERIFY", "R VERIFY", "R/VERIFY", "R_VERIFY", "R\nVERIFY", "R".repeat(41)]) {
    const value = plan();
    value.requirements![0]!.id = id;
    for (const task of value.tasks) task.contract!.requirementIds = [id];
    expect(() => validatePlan(value, agents)).toThrow("must start with a letter or digit");
  }
  const value = plan();
  value.requirements = [{ ...spec, id: "R".repeat(40) }];
  for (const task of value.tasks) task.contract!.requirementIds = ["R".repeat(40)];
  expect(validatePlan(value, agents)).toEqual(value);
  value.requirements.push({ ...value.requirements[0]! });
  expect(() => validatePlan(value, agents)).toThrow(`duplicate requirement id "${"R".repeat(40)}"`);
  value.requirements.pop();
  value.tasks[0]!.id = "API";
  expect(() => validatePlan(value, agents)).toThrow('task id "API" must be lowercase kebab-case');
});

test("Director cannot soften any established acceptance definition without an explicit amendment", () => {
  const changes: Partial<RequirementSpec>[] = [{ required: false }, { description: "Only a placeholder is needed" }, { check: "true" }, { artifacts: [] }, { inputs: [] }, { kind: "review", check: "" }];
  for (const change of changes) {
    const value = plan(); Object.assign(value.requirements![0]!, change);
    expect(() => validatePlan(value, agents, { requirements: [requirement] })).toThrow("edit the plan explicitly");
    if (change.required === false) expect(() => validatePlan(value, agents, { requirements: [requirement], allowRequirementAmendment: true })).toThrow("at least one required requirement");
    else expect(validatePlan(value, agents, { requirements: [requirement], allowRequirementAmendment: true })).toEqual(value);
  }
});

test("omitting requirements preserves obligations; amendments version them and stale earlier evidence", () => {
  expect(mergeRequirements([requirement], [], 2)).toEqual([requirement]);
  expect(mergeRequirements([requirement], [structuredClone(spec)], 2)[0]!.version).toBe(1);
  const changed = mergeRequirements([requirement], [{ ...spec, check: "bun run test:e2e" }], 2)[0]!;
  expect(changed).toMatchObject({ version: 2, updatedAt: 2 });
  const receipt: Evidence = { id: "e", runId: "r", taskId: null, scope: "acceptance", producer: "orchestra:requirement", commit: "head", requirementIds: [spec.id], requirementVersions: { journey: 1 }, command: spec.check, status: "passed", output: "", durationMs: 1, artifacts: [], createdAt: 1 };
  expect(requirementStatus(requirement, [receipt], "head")).toBe("satisfied");
  expect(requirementStatus(changed, [receipt], "head")).toBe("stale");
  expect(requirementStatus(requirement, [receipt], "new-head")).toBe("stale");
  expect(requirementStatus(requirement, [{ ...receipt, scope: "integration" }], "head")).toBe("unverified");
});

test("strategy recommendations require evidence from both execution shapes and include failed work", () => {
  const current = plan();
  const policy = defaultDeliveryPolicy("speed");
  const history = (strategy: "single" | "team", i: number, status: Run["status"] = "completed"): Run => ({ ...defaultRunControl(), id: `${strategy}-${i}`, workdir: "/project", prompt: "goal", directorAgentId: "boss", teamId: null, status, plan: null, requirements: [requirement], baseCommit: "base", acceptedCommit: "head", branch: "branch", error: null, warning: null, autonomous: true, costUsd: 0, tokens: 100, recoveries: 0, fixRounds: 0, report: "Accepted", createdAt: i, delivery: policy, recommendation: { strategy, reason: "chosen", samples: 0 }, activeElapsedMs: strategy === "single" ? 100 : 30, history: [{ cycle: 1, createdAt: i, plan: current, report: null }] });
  const singles = Array.from({ length: 3 }, (_, i) => history("single", i));
  expect(recommendStrategy(policy, current, singles).reason).toContain("independently");
  const teams = Array.from({ length: 3 }, (_, i) => history("team", i));
  expect(recommendStrategy(policy, current, [...singles, ...teams])).toMatchObject({ strategy: "team", samples: 6 });
  expect(recommendStrategy(policy, current, [...singles, ...teams, history("team", 4, "failed")]).strategy).toBe("single");
  expect(recommendStrategy(defaultDeliveryPolicy("economy"), current, []).strategy).toBe("single");
});

test("automatic strategy finds parallel work after a shared prerequisite", () => {
  const current = plan();
  const template = current.tasks[0]!;
  current.tasks = [
    { ...template, id: "setup", dependsOn: ["earlier-done"] },
    { ...template, id: "api", dependsOn: ["setup"] },
    { ...template, id: "ui", dependsOn: ["setup"] },
    { ...template, id: "journey", dependsOn: ["api", "ui"] },
  ];
  expect(recommendStrategy(defaultDeliveryPolicy(), current, []).strategy).toBe("team");
  expect(recommendStrategy(defaultDeliveryPolicy("economy"), current, []).strategy).toBe("single");
  expect(recommendStrategy({ ...defaultDeliveryPolicy(), strategy: "single" }, current, []).strategy).toBe("single");
  current.tasks[2]!.dependsOn = ["api"];
  expect(recommendStrategy(defaultDeliveryPolicy(), current, []).strategy).toBe("single");
});

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-artifacts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
test("artifact capture retains regular files and refuses escapes, symlinks and oversized files", async () => {
  writeFileSync(join(root, "report.txt"), "accepted");
  writeFileSync(join(root, "large.bin"), new Uint8Array(5 * 1024 * 1024 + 1));
  symlinkSync(join(root, "report.txt"), join(root, "link.txt"));
  const captured = captureArtifacts(root, ["report.txt", "link.txt", "large.bin", "../outside", "missing.txt"], join(root, "saved"));
  expect(captured.artifacts).toHaveLength(1);
  expect(await Bun.file(join(root, "saved", captured.artifacts[0]!)).text()).toBe("accepted");
  expect(captured.missing).toEqual(["link.txt", "large.bin", "../outside", "missing.txt"]);
});
