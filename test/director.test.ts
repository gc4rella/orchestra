import { describe, expect, test } from "bun:test";
import type { PlanStage, PlanTask, Task } from "../src/shared/types.ts";
import { nextPlanning, planJsonSchema, PlanError, validatePlan } from "../src/server/director.ts";

const agents = new Set(["a1", "a2"]);
const task = (id: string, dependsOn: string[] = [], agentId = "a1", reviewerId = ""): PlanTask => ({
  id, title: `Title ${id}`, description: `Do ${id}`, agentId, reviewerId, dependsOn, acceptanceCriteria: "works",
});
const plan = (tasks: PlanTask[], stage: PlanStage = "build", verify = "") => ({ summary: "s", stage, verify, tasks });
const existing = (key: string, status: Task["status"], stage: PlanStage) => ({ key, status, stage });

describe("validatePlan", () => {
  test("accepts a DAG over known agents", () => {
    const p = plan([task("setup"), task("api", ["setup"], "a2", "a1"), task("ui", ["setup"]), task("e2e", ["api", "ui"])], "build", "bun test");
    expect(validatePlan(p, agents)).toEqual(p);
  });

  const rejects = (raw: unknown, message: string, rules = {}) => expect(() => validatePlan(raw, agents, rules)).toThrow(message);

  test("rejects schema mismatches", () => {
    expect(() => validatePlan({ summary: "s", stage: "build", verify: "" }, agents)).toThrow(PlanError);
    rejects({ ...plan([task("x")]), stage: "ship-it" }, "schema");
    rejects(plan([{ ...task("x"), extra: 1 } as PlanTask]), "schema");
    rejects({ summary: "s", stage: "build", tasks: [task("x")] }, "schema"); // verify is required
  });
  test("rejects unknown agents", () => rejects(plan([task("x", [], "ghost")]), 'unknown agent "ghost"'));
  test("rejects unknown dependencies", () => rejects(plan([task("x", ["nope"])]), 'unknown task "nope"'));
  test("rejects self dependencies", () => rejects(plan([task("x", ["x"])]), "depends on itself"));
  test("rejects duplicate ids", () => rejects(plan([task("x"), task("x")]), 'duplicate task id "x"'));
  test("rejects ids that are not branch-safe", () => rejects(plan([task("Set Up")]), "kebab-case"));
  test("rejects empty plans", () => rejects(plan([]), "no tasks"));
  test("rejects cycles", () =>
    rejects(plan([task("a", ["c"]), task("b", ["a"]), task("c", ["b"]), task("d")]), "dependency cycle among tasks: a, b, c"));
  test("a reviewer is another known member", () => {
    rejects(plan([task("x", [], "a1", "ghost")]), 'unknown reviewer "ghost"');
    rejects(plan([task("x", [], "a1", "a1")]), "reviewed by its own assignee");
  });
  test("verify is a single, bounded command line", () => {
    rejects(plan([task("x")], "build", "bun test\nrm -rf /"), "single line");
    rejects(plan([task("x")], "build", "x".repeat(501)), "longer than 500");
  });
  test("the first plan can't be a fix plan", () => rejects(plan([task("x")], "fix"), 'stage must be "definition" or "build"'));
});

describe("nextPlanning", () => {
  const ok = (p: unknown, tasks: ReturnType<typeof existing>[]) => validatePlan(p, agents, nextPlanning(tasks).rules);
  const no = (p: unknown, tasks: ReturnType<typeof existing>[], message: string) =>
    expect(() => validatePlan(p, agents, nextPlanning(tasks).rules)).toThrow(message);

  test("first plan may be either stage", () => {
    expect(nextPlanning([]).purpose).toBe("initial");
    expect(ok(plan([task("spec")], "definition"), []).stage).toBe("definition");
  });

  describe("build after definition", () => {
    const tasks = [existing("spec", "done", "definition"), existing("design", "done", "definition")];
    test("is the build purpose", () => expect(nextPlanning(tasks)).toMatchObject({ purpose: "build", stage: "build" }));
    test("may depend on finished tasks", () => {
      const p = plan([task("api", ["design"]), task("qa", ["api", "spec"])]);
      expect(ok(p, tasks)).toEqual(p);
    });
    test("must not reuse earlier ids", () => no(plan([task("spec")]), tasks, '"spec" is already used by an earlier task'));
    test("must be a build plan", () => no(plan([task("more-docs")], "definition"), tasks, 'stage must be "build"'));
  });

  describe("recovery", () => {
    const tasks = [existing("api", "done", "build"), existing("ui", "failed", "build"), existing("e2e", "blocked", "build")];
    test("follows failed or blocked tasks, in their stage", () =>
      expect(nextPlanning(tasks)).toMatchObject({ purpose: "recover", stage: "build" }));
    test("may depend on done tasks but not on the failed ones it replaces", () => {
      expect(ok(plan([task("ui-2", ["api"])]), tasks).tasks).toHaveLength(1);
      no(plan([task("ui-2", ["ui"])]), tasks, 'depends on unfinished earlier task "ui"');
      no(plan([task("ui")]), tasks, "already used");
    });
  });

  describe("verification after the build", () => {
    const tasks = [existing("spec", "done", "definition"), existing("api", "done", "build"), existing("old", "superseded", "build")];
    test("is a fix plan, which may be empty to accept the build", () => {
      expect(nextPlanning(tasks)).toMatchObject({ purpose: "fix", stage: "fix" });
      expect(ok(plan([], "fix"), tasks).tasks).toEqual([]);
      expect(ok(plan([task("fix-api", ["api"])], "fix"), tasks).tasks).toHaveLength(1);
      no(plan([task("more")], "build"), tasks, 'stage must be "fix"');
    });
    test("follows fix rounds too", () =>
      expect(nextPlanning([...tasks, existing("fix-api", "done", "fix")]).purpose).toBe("fix"));
  });
});

test("plan JSON schema is strict, which codex structured output requires", () => {
  const s = planJsonSchema as any;
  expect(s.$schema).toBeUndefined();
  expect(s.additionalProperties).toBe(false);
  expect(s.required).toEqual(["summary", "stage", "verify", "tasks"]);
  expect(s.properties.stage.enum).toEqual(["definition", "build", "fix"]);
  expect(s.properties.tasks.items.additionalProperties).toBe(false);
  expect(s.properties.tasks.items.required).toHaveLength(7);
});
