import { describe, expect, test } from "bun:test";
import type { Agent, Handoff, Plan, PlanStage, PlanTask, Requirement, RunHistory, Task } from "../src/shared/types.ts";
import { compactHandoff, invokeDirector, MAX_EARLIER_CYCLES, nextPlanning, planJsonSchema, PlanError, PlanSchema, validatePlan, type PlanContext, type TaskBrief } from "../src/server/director.ts";

const agents = new Set(["a1", "a2"]);
const task = (id: string, dependsOn: string[] = [], agentId = "a1", reviewerId = ""): PlanTask => ({
  id, title: `Title ${id}`, description: `Do ${id}`, agentId, reviewerId, dependsOn, acceptanceCriteria: "works",
});
const plan = (tasks: PlanTask[], stage: PlanStage = "build", verify = "") => ({ summary: "s", stage, verify, lessons: "", tasks });
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
  test("reserves the accepted integration worktree name", () => rejects(plan([task("integration")]), "reserved"));
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
  test("lessons are bounded", () => rejects({ ...plan([task("x")]), lessons: "x".repeat(2001) }, "longer than 2000"));
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
  expect(s.required).toEqual(["summary", "stage", "verify", "lessons", "tasks", "version", "requirements"]);
  expect(s.properties.stage.enum).toEqual(["definition", "build", "fix"]);
  expect(s.properties.tasks.items.additionalProperties).toBe(false);
  expect(s.properties.tasks.items.required).toHaveLength(8);
  expect(s.properties.tasks.items.properties.contract.additionalProperties).toBe(false);
  expect(s.properties.tasks.items.properties.contract.required).toEqual(["requirementIds", "inputs", "outputs", "resources", "skillIds", "ui"]);
});

describe("explicit task skill and UI contracts", () => {
  const skillId = "owner/repo/frontend";
  const agentSkills = new Map([["a1", new Set([skillId])], ["a2", new Set<string>()]]);
  const uiPlan = (): Plan => ({
    ...plan([{ ...task("screen"), contract: { requirementIds: ["journey", "fidelity"], inputs: [], outputs: ["src/web"], resources: [], skillIds: [skillId], ui: true } }]), version: 2,
    requirements: [
      { id: "journey", title: "Primary browser journey", description: "Complete the journey at desktop and narrow widths.", required: true, kind: "command", check: "bun run test:browser", inputs: ["src/web"], artifacts: ["evidence/desktop.png", "evidence/narrow.png"] },
      { id: "fidelity", title: "Visual fidelity", description: "Inspect the screenshots against the visual contract.", required: true, kind: "review", check: "", inputs: ["src/web"], artifacts: [] },
    ],
  });

  test("new output requires explicit selection while compatible stored contracts stay unchanged", () => {
    const current = uiPlan();
    expect(PlanSchema.safeParse(current).success).toBe(true);
    expect(validatePlan(current, agents, { agentSkills })).toEqual(current);
    const previous = uiPlan();
    delete previous.tasks[0]!.contract!.skillIds;
    delete previous.tasks[0]!.contract!.ui;
    expect(PlanSchema.safeParse(previous).success).toBe(false);
    expect(validatePlan(previous, agents, { agentSkills })).toEqual(previous);
    expect(validatePlan(plan([task("existing")]), agents, { agentSkills })).toEqual(plan([task("existing")]));
  });

  test("selected skills must be valid, unique, bounded and registered for the assignee", () => {
    for (const [skillIds, message] of [
      [["../../escape"], "valid marketplace skill ids"], [[skillId, skillId], "duplicate selected skills"],
      [[skillId, "o/r/a", "o/r/b", "o/r/c"], "at most 3"], [["owner/repo/not-installed"], "not registered for its assignee"],
    ] as [string[], string][]) {
      const value = uiPlan(); value.tasks[0]!.contract!.skillIds = skillIds;
      expect(() => validatePlan(value, agents, { agentSkills })).toThrow(message);
    }
    const reassigned = uiPlan(); reassigned.tasks[0]!.agentId = "a2";
    expect(() => validatePlan(reassigned, agents, { agentSkills })).toThrow("not registered for its assignee");
  });

  test("rendered UI tasks cannot omit skills, screenshot evidence or required independent review", () => {
    const noSkill = uiPlan(); noSkill.tasks[0]!.contract!.skillIds = [];
    expect(() => validatePlan(noSkill, agents, { agentSkills })).toThrow("must select a relevant skill");
    for (const artifacts of [[], ["evidence/report.txt"]]) {
      const noScreenshots = uiPlan(); noScreenshots.requirements![0]!.artifacts = artifacts;
      expect(() => validatePlan(noScreenshots, agents, { agentSkills })).toThrow("with screenshot artifacts");
    }
    const optionalCommand = uiPlan(); optionalCommand.requirements![0]!.required = false;
    expect(() => validatePlan(optionalCommand, agents, { agentSkills })).toThrow("with screenshot artifacts");
    const optionalReview = uiPlan(); optionalReview.requirements![1]!.required = false;
    expect(() => validatePlan(optionalReview, agents, { agentSkills })).toThrow("required independent visual review");
    const unlinkedReview = uiPlan(); unlinkedReview.tasks[0]!.contract!.requirementIds = ["journey"];
    expect(() => validatePlan(unlinkedReview, agents, { agentSkills })).toThrow("required independent visual review");
    const backend = uiPlan(); backend.tasks[0]!.contract!.ui = false; backend.tasks[0]!.contract!.skillIds = []; backend.requirements![0]!.artifacts = [];
    expect(validatePlan(backend, agents, { agentSkills })).toEqual(backend);
  });

  test("later UI plans retain explicit skills and use the original requirement evidence contract", () => {
    const value = uiPlan();
    const requirements = value.requirements!.map((requirement) => ({ ...requirement, version: 1, updatedAt: 1 }));
    value.requirements = [];
    expect(validatePlan(value, agents, { requirements, agentSkills })).toEqual(value);
  });

  test("Director invocation validates selected skills against its actual staffing roster", async () => {
    const member: Agent = { id: "a1", name: "Engineer", role: "Frontend", runtime: "codex", model: null, effort: null, expertise: "UI", instructions: null, skills: [], createdAt: 0 };
    const options = { director: { ...member, id: "director" }, roster: [member], goal: "Build the UI", cwd: "/tmp", context: { purpose: "initial", stage: null, tasks: [], verify: "" } as PlanContext, rules: {}, onLog: () => {} };
    const runner = async () => ({ ok: true, text: "", structured: uiPlan() });
    await expect(invokeDirector(runner, options)).rejects.toThrow("not registered for its assignee");
    member.skills = [{ id: skillId, name: "Frontend", description: "Build visual interfaces" }];
    expect((await invokeDirector(runner, options)).tasks[0]!.contract).toMatchObject({ ui: true, skillIds: [skillId] });
  });
});


test("improvement planning accepts a build or no-work decision, retaining dependency safety", () => {
  const rules = { improvement: true, stages: ["build", "fix"] as PlanStage[], doneKeys: new Set(["done"]), takenKeys: new Set(["done", "failed"]) };
  expect(validatePlan(plan([task("better", ["done"])], "build"), agents, rules).tasks).toHaveLength(1);
  expect(validatePlan(plan([], "fix"), agents, rules).tasks).toHaveLength(0);
  expect(() => validatePlan(plan([task("better")], "fix"), agents, rules)).toThrow("build tasks or an empty fix plan");
  expect(() => validatePlan(plan([task("better")], "definition"), agents, rules)).toThrow("stage must be");
  expect(() => validatePlan(plan([task("done")]), agents, rules)).toThrow("already used");
  expect(() => validatePlan(plan([task("better", ["failed"])]), agents, rules)).toThrow("unfinished earlier task");
});

describe("bounded prompt evidence", () => {
  const member = (id: string): Agent => ({ id, name: id, runtime: "codex", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null, createdAt: 0 });
  const bulky = (key: string): Handoff => ({
    text: `${key} handoff ${"h".repeat(10_000)}`,
    files: Array.from({ length: 200 }, (_, index) => `src/${key}/${index}.ts`),
    check: { command: "bun test", ok: false, output: `${"o".repeat(8_000)}FAILURE IN ${key}`, commit: "task-revision", producer: "orchestra:task", durationMs: 42 },
    review: { verdict: "changes", findings: `Review ${key} ${"f".repeat(10_000)}` },
    integration: {
      baselineCommit: "accepted-baseline", candidateCommit: "checked-candidate", conflictResolved: true,
      check: { command: "bun test", ok: false, output: `${"i".repeat(8_000)}CANDIDATE FAILURE IN ${key}`, commit: "checked-candidate", producer: "orchestra:integration", durationMs: 17 },
      review: { verdict: "changes", findings: `Candidate review ${key} ${"r".repeat(10_000)}` },
    },
  });
  const brief = (key: string, cycle: number): TaskBrief => ({ key, title: `Task ${key}`, agent: "a1", status: "done", cycle, summary: `summary ${key} ${"s".repeat(5_000)}`, error: "", handoff: bulky(key) });
  const promptFor = async (context: PlanContext, roster = [member("a1")]) => {
    let prompt = "";
    await invokeDirector(async (invocation) => {
      prompt = invocation.prompt;
      return { ok: true, text: "", structured: plan([], "fix") };
    }, {
      director: member("boss"), roster, goal: "Build it", cwd: "/tmp", rules: { stages: ["build", "fix"] }, onLog: () => {}, context,
    });
    return prompt;
  };
  const continuousContext = (cycles: number, purpose: "fix" | "improve"): PlanContext => {
    const tasks: TaskBrief[] = [];
    const history: RunHistory[] = [];
    for (let cycle = 1; cycle <= cycles; cycle++) {
      for (let index = 0; index < 5; index++) tasks.push(brief(`c${cycle}-t${index}`, cycle));
      history.push({ cycle, createdAt: 0, plan: { ...plan([task(`c${cycle}-t0`)]), summary: `plan of cycle ${cycle} ${"p".repeat(3_000)}` }, report: `report of cycle ${cycle}` });
    }
    return { purpose, stage: "fix", tasks, history, verify: "" };
  };

  test("Director instructions distinguish requirement references from branch-safe task ids", async () => {
    const prompt = await promptFor({ purpose: "initial", stage: null, tasks: [], verify: "" });
    expect(prompt).toContain('e.g. "R-VERIFY" or "verify-build"');
    expect(prompt).toContain("Requirement ids are case-sensitive: reuse existing ids exactly");
    expect(prompt).toContain("copy them exactly into each task's contract.requirementIds");
    expect(prompt).toContain("Task ids are short, unique, lowercase kebab-case");
  });

  test("staffing receives bounded capability descriptions and configured runtime choices", async () => {
    const specialist: Agent = {
      ...member("a1"), role: "Engineer", expertise: "Accessible responsive interfaces", model: "configured-model", effort: "high",
      skills: [{
        id: "owner/repo/generic-name", name: "Generic name", description: `Browser screenshot and keyboard verification. ${"x".repeat(900)}discarded-description-tail`, revision: "source-revision",
        compatibility: { status: "integration-required", requiredTools: ["browser"], notices: ["Browser tooling requires setup; instructions alone do not install it."] },
      }],
    };
    const prompt = await promptFor({ purpose: "initial", stage: null, tasks: [], verify: "" }, [specialist]);
    for (const value of ['"model": "configured-model"', '"effort": "high"', '"id": "owner/repo/generic-name"', "Browser screenshot and keyboard verification.", '"revision": "source-revision"', '"status": "integration-required"', '"requiredTools": [', '"browser"', "Browser tooling requires setup"]) expect(prompt).toContain(value);
    expect(prompt).not.toContain("discarded-description-tail");
    expect(prompt).toContain("Prefer demonstrated task fit from expertise and skill descriptions");
    expect(prompt).toContain("not proof that those tools are available");
    expect(prompt).toContain("missing-capability fallback");
    expect(specialist.skills[0]!.description).toContain("discarded-description-tail");
  });

  test("UI acceptance requires visual and browser evidence without a mandatory definition chain", async () => {
    const prompt = await promptFor({ purpose: "initial", stage: null, tasks: [], verify: "" });
    expect(prompt).toContain('plan stage "build" directly');
    expect(prompt).toContain("compact visual contract in the first implementation task");
    expect(prompt).toContain("desktop and narrow-screen screenshot artifacts");
    expect(prompt).toContain("required independent review requirement for fidelity");
    expect(prompt).toContain("Do not substitute build/type/unit checks or a running preview");
    expect(prompt).toContain("Backend-only tasks do not need this UI procedure");
    expect(prompt).toContain("Set contract.skillIds to 1–3 relevant installed skill ids");
    expect(prompt).toContain("Set contract.ui to true when the task changes rendered UI code");
    expect(prompt).toContain("false for backend work or documentation-only design tasks");
    const verification = await promptFor({ purpose: "fix", stage: "fix", tasks: [], verify: "" });
    expect(verification).toContain("Broken visual fidelity, responsive behavior and missing required browser evidence are real gaps");
  });

  test("handoff excerpts retain real paths, verdicts and revision provenance without changing saved evidence", () => {
    const original = bulky("feature");
    const saved = JSON.stringify(original);
    const compact = compactHandoff(original);
    expect(JSON.stringify(original)).toBe(saved);
    expect(compact.text.length).toBeLessThan(4_100);
    expect(compact.files).toEqual(original.files.slice(0, 50));
    expect(compact.omittedFiles).toBe(150);
    expect(compact.check).toMatchObject({ command: "bun test", ok: false, commit: "task-revision", producer: "orchestra:task", durationMs: 42 });
    expect(compact.check?.output.endsWith("FAILURE IN feature")).toBe(true);
    expect(compact.check!.output.length).toBeLessThan(2_100);
    expect(compact.review).toMatchObject({ verdict: "changes" });
    expect(compact.review!.findings.length).toBeLessThan(2_100);
    expect(compact.integration).toMatchObject({
      baselineCommit: "accepted-baseline", candidateCommit: "checked-candidate", conflictResolved: true,
      check: { command: "bun test", ok: false, commit: "checked-candidate", producer: "orchestra:integration", durationMs: 17 }, review: { verdict: "changes" },
    });
    expect(compact.integration?.check?.output.endsWith("CANDIDATE FAILURE IN feature")).toBe(true);
    expect(compact.integration!.review!.findings.length).toBeLessThan(2_100);
  });

  test("long runs retain the latest cycle's evidence and bound older cycle summaries", async () => {
    const short = await promptFor(continuousContext(2, "fix"));
    const long = await promptFor(continuousContext(30, "fix"));
    expect(long.length).toBeLessThan(short.length + MAX_EARLIER_CYCLES + 1_000);
    expect(long.length).toBeLessThan(110_000);
    expect(long).toContain("FAILURE IN c30-t4");
    expect(long).toContain('"candidateCommit":"checked-candidate"');
    expect(long).not.toContain("FAILURE IN c29-t4");
    expect(long).toContain("### Cycle 29");
    expect(long).toContain("older cycle(s) left out");
    expect(long).not.toContain("### Cycle 1\n");
  });

  test("improvement planning sees the previous cycle and summarized older work", async () => {
    const prompt = await promptFor(continuousContext(5, "improve"));
    expect(prompt).toContain("summary c5-t0");
    expect(prompt).toContain("### Cycle 4");
    expect(prompt).toContain("Task c4-t0 (c4-t0): summary c4-t0");
    expect(prompt).not.toContain("FAILURE IN c4-t0");
    expect(prompt.length).toBeLessThan(110_000);
  });

  test("recovery retains used task keys and the latest failure tail", async () => {
    const prompt = await promptFor({
      purpose: "recover", stage: "build", verify: "", tasks: [brief("earlier-task", 1), { ...brief("latest-task", 2), status: "failed", error: `${"log".repeat(20_000)}CURRENT FAILURE` }],
    });
    expect(prompt).toContain("every existing id (earlier-task, latest-task)");
    expect(prompt).toContain("CURRENT FAILURE");
    expect(prompt.length).toBeLessThan(30_000);
  });

  test("current verification output is bounded while acceptance definitions remain complete", async () => {
    const requirement: Requirement = { id: "behavior", title: "Required behavior", description: `full requirement ${"d".repeat(4_900)}`, kind: "command", check: "bun run acceptance", required: true, inputs: ["src/feature.ts"], artifacts: ["evidence/result.png"], version: 7, updatedAt: 123 };
    const delivery = { profile: "quality", strategy: "team", maxParallel: 2 } as const;
    const check = { command: "bun test", ok: false, output: `${"verbose output\n".repeat(10_000)}FINAL CHECK FAILURE`, commit: "accepted-revision", producer: "orchestra:combined" };
    const prompt = await promptFor({ purpose: "fix", stage: "fix", tasks: [], verify: check.command, check, requirements: [requirement], delivery, acceptance: 'behavior: failed at accepted-revision' });
    expect(prompt).toContain(JSON.stringify([requirement]));
    expect(prompt).toContain(JSON.stringify(delivery));
    expect(prompt).toContain("behavior: failed at accepted-revision");
    expect(prompt).toContain("FINAL CHECK FAILURE");
    expect(prompt).toContain("earlier characters");
    expect(prompt.length).toBeLessThan(20_000);
    expect(check.output.length).toBeGreaterThan(100_000);
  });
});
