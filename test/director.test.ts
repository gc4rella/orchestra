import { describe, expect, test } from "bun:test";
import type { PlanTask } from "../src/shared/types.ts";
import { planJsonSchema, PlanError, planRules, validatePlan } from "../src/server/director.ts";

const agents = new Set(["a1", "a2"]);
const task = (id: string, dependsOn: string[] = [], agentId = "a1") => ({
  id, title: `Title ${id}`, description: `Do ${id}`, agentId, dependsOn, acceptanceCriteria: "works",
});
const plan = (tasks: PlanTask[], stage: "definition" | "build" = "build") => ({ summary: "s", stage, tasks });

describe("validatePlan", () => {
  test("accepts a DAG over known agents", () => {
    const p = plan([task("setup"), task("api", ["setup"], "a2"), task("ui", ["setup"]), task("e2e", ["api", "ui"])]);
    expect(validatePlan(p, agents)).toEqual(p);
  });

  const rejects = (raw: unknown, message: string, rules = {}) => expect(() => validatePlan(raw, agents, rules)).toThrow(message);

  test("rejects schema mismatches", () => {
    expect(() => validatePlan({ summary: "s", stage: "build" }, agents)).toThrow(PlanError);
    rejects({ ...plan([task("x")]), stage: "ship-it" }, "schema");
    rejects(plan([{ ...task("x"), extra: 1 } as PlanTask]), "schema");
  });
  test("rejects unknown agents", () => rejects(plan([task("x", [], "ghost")]), 'unknown agent "ghost"'));
  test("rejects unknown dependencies", () => rejects(plan([task("x", ["nope"])]), 'unknown task "nope"'));
  test("rejects self dependencies", () => rejects(plan([task("x", ["x"])]), "depends on itself"));
  test("rejects duplicate ids", () => rejects(plan([task("x"), task("x")]), 'duplicate task id "x"'));
  test("rejects ids that are not branch-safe", () => rejects(plan([task("Set Up")]), "kebab-case"));
  test("rejects empty plans", () => rejects(plan([]), "no tasks"));
  test("rejects cycles", () =>
    rejects(plan([task("a", ["c"]), task("b", ["a"]), task("c", ["b"]), task("d")]), "dependency cycle among tasks: a, b, c"));
});

describe("build stage after definition", () => {
  const rules = planRules(["spec", "design"]);

  test("may depend on finished tasks", () => {
    const p = plan([task("api", ["design"]), task("qa", ["api", "spec"])]);
    expect(validatePlan(p, agents, rules)).toEqual(p);
  });
  test("must not reuse finished ids", () =>
    expect(() => validatePlan(plan([task("spec")]), agents, rules)).toThrow('"spec" is already used by a finished task'));
  test("must be a build plan", () =>
    expect(() => validatePlan(plan([task("more-docs")], "definition"), agents, rules)).toThrow('stage must be "build"'));
  test("first plan may be either stage", () => {
    expect(planRules([])).toEqual({});
    expect(validatePlan(plan([task("spec")], "definition"), agents, planRules([])).stage).toBe("definition");
  });
});

test("plan JSON schema is strict, which codex structured output requires", () => {
  const s = planJsonSchema as any;
  expect(s.$schema).toBeUndefined();
  expect(s.additionalProperties).toBe(false);
  expect(s.required).toEqual(["summary", "stage", "tasks"]);
  expect(s.properties.stage.enum).toEqual(["definition", "build"]);
  expect(s.properties.tasks.items.additionalProperties).toBe(false);
  expect(s.properties.tasks.items.required).toHaveLength(6);
});
