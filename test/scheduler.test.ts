import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Agent, Plan, PlanTask, RunStatus, ServerEvent } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb, type Db } from "../src/server/db.ts";
import type { Review } from "../src/server/review.ts";
import type { AgentInvocation, AgentResult, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler, MAX_FIX_ROUNDS, MAX_ITERATIONS, MAX_RECOVERIES } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-sched-")));
const schedulers: ReturnType<typeof createScheduler>[] = [];
afterAll(async () => {
  await Promise.all(schedulers.map((s) => s.waitForCleanup()));
  rmSync(root, { recursive: true, force: true });
});

let db: Db;
let boss: Agent;
let dev: Agent;
let qa: Agent;
let events: ServerEvent[];
let n = 0;

/** The director returns `plan`, or the next of `verdicts` when verifying (an accepting fix plan when none is queued). */
let plan: Plan;
let verdicts: Plan[];
/** Reviewers answer with the next of `reviews`, approving when none is queued. */
let reviews: Review[];
/** Worker behaviour per task key (the worktree's name); "integration" resolves merge conflicts. */
let workers: Record<string, (inv: AgentInvocation) => Promise<AgentResult>>;
let directorPrompts: string[];
let invocations: AgentInvocation[];

const accept: Plan = { summary: "Checked everything; the goal is met.", stage: "fix", verify: "", lessons: "", tasks: [] };

const fakeRunAgent: RunAgent = async (inv) => {
  invocations.push(inv);
  if (inv.mode === "readonly") {
    if (inv.prompt.includes("reviewing a teammate's work")) return { ok: true, text: "", structured: reviews.shift() ?? { verdict: "approve", findings: "" } };
    directorPrompts.push(inv.prompt);
    const verifying = inv.prompt.includes("## Verification");
    return { ok: true, text: "", structured: verifying ? (verdicts.shift() ?? accept) : plan };
  }
  return workers[basename(inv.cwd)]!(inv);
};

const write = (file: string, content: string, result = `wrote ${file}`) => async (inv: AgentInvocation) => {
  await Bun.write(join(inv.cwd, file), content);
  return { ok: true, text: result };
};

const show = (repo: string, rev: string) => {
  const r = Bun.spawnSync(["git", "show", rev], { cwd: repo });
  return r.exitCode === 0 ? r.stdout.toString() : null;
};

async function waitForRun(id: string, statuses: RunStatus[]) {
  for (let i = 0; i < 600; i++) {
    const run = db.getRun(id)!;
    if (statuses.includes(run.status)) return run;
    await Bun.sleep(25);
  }
  throw new Error(`run stuck in ${db.getRun(id)!.status}`);
}

/** The tests' team: Boss directs everyone else hired so far. */
function team() {
  const input = { name: "Team", directorId: boss.id, memberIds: db.listAgents().filter((a) => a.id !== boss.id).map((a) => a.id) };
  const existing = db.listTeams()[0];
  if (!existing) return db.createTeam(input).id;
  db.updateTeam(existing.id, input);
  return existing.id;
}

function setup(runAgent: RunAgent = fakeRunAgent, now = Date.now) {
  const worktreeRoot = join(root, `wt${n}`);
  const s = createScheduler({ db, runAgent, now, worktreeRoot, publish: (_, ev) => events.push(ev) });
  schedulers.push(s);
  const workdir = join(root, `project${n++}`);
  const start = async () => {
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
    await waitForRun(run.id, ["awaiting_approval"]);
    return run;
  };
  return { s, workdir, worktreeRoot, start };
}

const task = (id: string, agentId: string, dependsOn: string[] = [], reviewerId = ""): PlanTask => ({
  id, title: `Task ${id}`, description: `Do ${id}`, agentId, reviewerId, dependsOn, acceptanceCriteria: "",
});
const byKey = (runId: string) => Object.fromEntries(db.listTasks(runId).map((t) => [t.key, t]));

beforeEach(() => {
  db = openDb(":memory:");
  boss = db.createAgent({ name: "Boss", runtime: "claude-code", model: null, effort: null, role: DIRECTOR_ROLE, expertise: "", skills: [], instructions: null });
  dev = db.createAgent({ name: "Dev", runtime: "claude-code", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null });
  qa = db.createAgent({ name: "QA", runtime: "codex", model: null, effort: null, role: "QA", expertise: "", skills: [], instructions: null });
  events = [];
  directorPrompts = [];
  invocations = [];
  verdicts = [];
  reviews = [];
  plan = {
    summary: "two in parallel, then integrate", stage: "build", verify: "", lessons: "",
    tasks: [task("a", dev.id), task("b", qa.id), task("c", dev.id, ["a", "b"])],
  };
});

describe("scheduler", () => {
  test("cancelling planning ignores a late director answer and creates no tasks", async () => {
    let finish!: (result: AgentResult) => void;
    let signal: AbortSignal | undefined;
    const { s, workdir } = setup((inv) => {
      signal = inv.signal;
      return new Promise((resolve) => { finish = resolve; });
    });
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
    for (let i = 0; i < 100 && !finish; i++) await Bun.sleep(10);
    expect(finish).toBeDefined();
    s.cancel(run.id);
    expect(signal?.aborted).toBe(true);
    finish({ ok: true, text: "", structured: plan });
    await Bun.sleep(25);
    expect(db.getRun(run.id)!.status).toBe("cancelled");
    expect(db.listTasks(run.id)).toEqual([]);
    expect(() => s.approve(run.id)).toThrow("not awaiting approval");
  });

  test("runs independent tasks in parallel, dependents after merge, all on the run branch", async () => {
    let concurrent = 0;
    let maxConcurrent = 0;
    const slow = (file: string) => async (inv: AgentInvocation) => {
      maxConcurrent = Math.max(maxConcurrent, ++concurrent);
      await Bun.sleep(100);
      concurrent--;
      return write(file, `${file}\n`)(inv);
    };
    let cPrompt = "";
    workers = {
      a: slow("a.txt"),
      b: slow("b.txt"),
      c: async (inv) => {
        cPrompt = inv.prompt;
        // a and b are merged into the run branch before c starts, so c's worktree has them
        expect(await Bun.file(join(inv.cwd, "a.txt")).exists()).toBe(true);
        expect(await Bun.file(join(inv.cwd, "b.txt")).exists()).toBe(true);
        return write("c.txt", "c\n")(inv);
      },
    };
    const { s, workdir, start } = setup();
    const run = await start();
    expect(db.getRun(run.id)!.plan).toEqual(plan);

    s.approve(run.id);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(maxConcurrent).toBe(2);
    expect(cPrompt).toContain("- Task a: wrote a.txt");
    expect(db.listTasks(run.id).map((t) => t.status)).toEqual(["done", "done", "done"]);
    for (const f of ["a.txt", "b.txt", "c.txt"]) expect(show(workdir, `${run.branch}:${f}`)).not.toBeNull();
    // user's branch untouched; task branches cleaned up
    expect(show(workdir, "main:a.txt")).toBeNull();
    const branches = Bun.spawnSync(["git", "branch", "--list", "orchestra/*"], { cwd: workdir }).stdout.toString().trim();
    expect(branches).toBe(run.branch);
    expect(events.some((e) => e.type === "log")).toBe(true);
  });

  test("a failure blocks dependents; retry recovers the run", async () => {
    let failB = true;
    workers = {
      a: write("a.txt", "a"),
      b: async (inv) => (failB ? { ok: false, text: "", error: "boom" } : write("b.txt", "b")(inv)),
      c: write("c.txt", "c"),
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    const failed = await waitForRun(run.id, ["completed", "failed"]);
    expect(failed.status).toBe("failed");
    const tasks = byKey(run.id);
    expect(tasks.a!.status).toBe("done");
    expect(tasks.b!.status).toBe("failed");
    expect(tasks.b!.error).toBe("boom");
    expect(tasks.c!.status).toBe("blocked");

    failB = false;
    s.retry(tasks.b!.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
  });

  test("merge conflicts go to the agent; its resolution is merged", async () => {
    plan = { summary: "conflict", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", qa.id)] };
    workers = {
      a: write("shared.txt", "from a\n"),
      b: write("shared.txt", "from b\n"),
      integration: write("shared.txt", "from a and b\n"),
    };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(show(workdir, `${run.branch}:shared.txt`)).toBe("from a and b\n");
  });

  test("an unresolved conflict fails the task and leaves the run branch clean", async () => {
    plan = { summary: "conflict", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", qa.id)] };
    workers = {
      a: write("shared.txt", "from a\n"),
      b: write("shared.txt", "from b\n"),
      integration: async () => ({ ok: true, text: "gave up" }),
    };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("failed");
    const failed = db.listTasks(run.id).find((t) => t.status === "failed")!;
    expect(failed.error).toContain("Could not resolve merge conflict");
    expect(show(workdir, `${run.branch}:shared.txt`)).not.toContain("<<<<<<<");
  });

  test("cancel stops running agents", async () => {
    workers = {
      a: (inv) => new Promise((resolve) => inv.signal!.addEventListener("abort", () => resolve({ ok: false, text: "", error: "cancelled" }))),
      b: (inv) => new Promise((resolve) => inv.signal!.addEventListener("abort", () => resolve({ ok: false, text: "", error: "cancelled" }))),
      c: write("c.txt", "c"),
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    await Bun.sleep(150);
    s.cancel(run.id);
    await Bun.sleep(150);
    expect(db.getRun(run.id)!.status).toBe("cancelled");
    expect(db.listTasks(run.id).map((t) => t.status)).toEqual(["cancelled", "cancelled", "cancelled"]);
  });

  test("a thrown conflict resolver aborts the merge before retry", async () => {
    plan = { summary: "conflict", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", qa.id)] };
    workers = {
      a: write("shared.txt", "from a\n"),
      b: write("shared.txt", "from b\n"),
      integration: async () => { throw new Error("resolver could not start"); },
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("failed");
    const failed = db.listTasks(run.id).find((t) => t.status === "failed")!;
    const cwd = join(root, `wt${n - 1}`, run.id, "integration");
    expect(Bun.spawnSync(["git", "rev-parse", "--verify", "MERGE_HEAD"], { cwd }).exitCode).not.toBe(0);
    expect(Bun.spawnSync(["git", "status", "--porcelain"], { cwd }).stdout.toString()).toBe("");
    workers.integration = write("shared.txt", "resolved\n");
    s.retry(failed.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
  });

  test("invalid director output fails the run; revise re-plans", async () => {
    const good = plan;
    plan = { summary: "bad", stage: "build", verify: "", lessons: "", tasks: [task("a", "ghost")] };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain('unknown agent "ghost"');

    plan = good;
    s.revise(run.id, "use real agents");
    expect((await waitForRun(run.id, ["awaiting_approval", "failed"])).status).toBe("awaiting_approval");
  });
});

describe("director", () => {
  test("every run is directed by the Director, who is left out of the team it staffs", async () => {
    const { start } = setup();
    const run = await start();
    expect(run.directorAgentId).toBe(boss.id);
    expect(directorPrompts[0]).toContain(`"id": "${dev.id}"`);
    expect(directorPrompts[0]).not.toContain(`"id": "${boss.id}"`);
  });

  test("a plan that hands work to the Director is rejected", async () => {
    plan = { summary: "self", stage: "build", verify: "", lessons: "", tasks: [task("a", boss.id)] };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.error).toContain(`unknown agent "${boss.id}"`);
  });

  test("a run needs a team with members", async () => {
    const { s, workdir } = setup();
    await expect(s.startRun({ teamId: "ghost", prompt: "x", workdir })).rejects.toThrow("Pick a team");
    const empty = db.createTeam({ name: "Solo", directorId: boss.id, memberIds: [] });
    await expect(s.startRun({ teamId: empty.id, prompt: "x", workdir })).rejects.toThrow("Add at least one member to Solo");
  });

  test("a run is directed by its team's Director and staffs only its members", async () => {
    const lead = db.createAgent({ name: "Lead", runtime: "codex", model: null, effort: null, role: DIRECTOR_ROLE, expertise: "", skills: [], instructions: null });
    const small = db.createTeam({ name: "Small", directorId: lead.id, memberIds: [qa.id] });
    plan = { summary: "outsider", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: small.id, prompt: "Build it", workdir });
    expect(run).toMatchObject({ teamId: small.id, directorAgentId: lead.id });
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.error).toContain(`unknown agent "${dev.id}"`);
    expect(directorPrompts[0]).toContain(`"id": "${qa.id}"`);
    expect(directorPrompts[0]).not.toContain(`"id": "${dev.id}"`);

    // Membership is read live: once Dev joins, the same plan is valid.
    db.updateTeam(small.id, { name: "Small", directorId: lead.id, memberIds: [qa.id, dev.id] });
    s.revise(run.id, "try again");
    expect((await waitForRun(run.id, ["awaiting_approval", "failed"])).status).toBe("awaiting_approval");
  });
});

describe("two-stage planning", () => {
  test("after the definition stage the director plans the build from the team's docs", async () => {
    const pm = db.createAgent({ name: "PM", runtime: "claude-code", model: null, effort: null, role: "Product Manager", expertise: "", skills: [], instructions: null });
    plan = { summary: "define first", stage: "definition", verify: "", lessons: "", tasks: [task("spec", pm.id), task("design", dev.id, ["spec"])] };
    workers = {
      spec: write("docs/product/spec.md", "# Spec\n", "spec written"),
      design: async (inv) => {
        expect(await Bun.file(join(inv.cwd, "docs/product/spec.md")).exists()).toBe(true);
        return write("docs/engineering/design.md", "# Design\n", "design written")(inv);
      },
      api: write("api.ts", "api\n"),
      qa: write("api.test.ts", "test\n"),
    };
    const { s, workdir, start } = setup();
    const run = await start();
    expect(directorPrompts[0]).toContain('set stage to "definition"');

    // The build plan the director returns once definition is done; it may depend on finished tasks.
    plan = { summary: "now build", stage: "build", verify: "", lessons: "", tasks: [task("api", dev.id, ["design"]), task("qa", qa.id, ["api"])] };
    s.approve(run.id);
    const between = await waitForRun(run.id, ["awaiting_approval", "failed"]);
    expect(between.status).toBe("awaiting_approval");
    expect(between.plan!.stage).toBe("build");
    expect(directorPrompts[1]).toContain("Stage 2: build");
    expect(directorPrompts[1]).toContain("spec written");
    expect(db.listTasks(run.id).map((t) => t.status)).toEqual(["done", "done"]);

    // Revising the build plan keeps the build-stage context.
    s.revise(run.id, "fine as is");
    await waitForRun(run.id, ["awaiting_approval"]);
    expect(directorPrompts[2]).toContain("Stage 2: build");

    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(db.listTasks(run.id).map((t) => t.key)).toEqual(["spec", "design", "api", "qa"]);
    for (const f of ["docs/product/spec.md", "docs/engineering/design.md", "api.ts", "api.test.ts"]) {
      expect(show(workdir, `${run.branch}:${f}`)).not.toBeNull();
    }
  });

  test("a failed build-stage planning can be retried", async () => {
    plan = { summary: "define", stage: "definition", verify: "", lessons: "", tasks: [task("spec", dev.id)] };
    workers = { spec: write("spec.md", "spec") };
    const { s, start } = setup();
    const run = await start();
    plan = { summary: "bad build", stage: "definition", verify: "", lessons: "", tasks: [task("more", dev.id)] }; // must be "build" now
    s.approve(run.id);
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain('stage must be "build"');

    plan = { summary: "build", stage: "build", verify: "", lessons: "", tasks: [task("impl", dev.id, ["spec"])] };
    s.revise(run.id, "try again");
    expect((await waitForRun(run.id, ["awaiting_approval", "failed"])).status).toBe("awaiting_approval");
  });
});

test("server restart fails in-flight work so it can be retried", () => {
  const run = db.createRun({ id: "r1", prompt: "p", workdir: "/w", directorAgentId: dev.id, baseCommit: "x", branch: "orchestra/r1", warning: null });
  db.updateRun(run.id, { status: "running", plan });
  db.insertTasks(run.id, plan);
  const [a, b] = db.listTasks(run.id);
  db.updateTask(a!.id, { status: "running" });
  db.failInterrupted();
  expect(db.getRun(run.id)!.status).toBe("failed");
  expect(db.getTask(a!.id)!.status).toBe("failed");
  expect(db.getTask(b!.id)!.status).toBe("pending");
});

describe("quality loop", () => {
  test("cancelling a running verify command stops it without merging the task", async () => {
    plan = { summary: "one", stage: "build", verify: "echo started > check-started; sleep 30", lessons: "", tasks: [task("a", dev.id)] };
    let cwd = "";
    workers = { a: async (inv) => { cwd = inv.cwd; return write("a.txt", "a\n")(inv); } };
    const { s, start, workdir } = setup();
    const run = await start();
    s.approve(run.id);
    for (let i = 0; i < 200; i++) {
      if (cwd && await Bun.file(join(cwd, "check-started")).exists()) break;
      await Bun.sleep(10);
    }
    expect(await Bun.file(join(cwd, "check-started")).exists()).toBe(true);
    s.cancel(run.id);
    for (let i = 0; i < 200 && byKey(run.id).a!.status === "running"; i++) await Bun.sleep(10);
    expect(byKey(run.id).a).toMatchObject({ status: "cancelled", mergeCommit: null });
    expect(show(workdir, `${run.branch}:a.txt`)).toBeNull();
    expect(db.getRun(run.id)!.status).toBe("cancelled");
  });

  test("a malformed reviewer answer fails the task and never merges its committed work", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    workers = { a: write("a.txt", "a\n") };
    const { s, start, workdir } = setup((inv) => inv.prompt.includes("reviewing a teammate's work")
      ? Promise.resolve({ ok: true, text: "looks good" }) : fakeRunAgent(inv));
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["failed", "completed"])).status).toBe("failed");
    expect(byKey(run.id).a!.error).toContain("Reviewer did not return JSON");
    expect(show(workdir, `${run.branch}:a.txt`)).toBeNull();
    expect(show(workdir, `${run.branch}-a:a.txt`)).toBe("a\n");
  });

  test("persistent review findings stop at the task iteration cap", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    reviews = Array.from({ length: MAX_ITERATIONS }, () => ({ verdict: "changes", findings: "1. Missing error handling" }));
    workers = { a: write("a.txt", "a\n") };
    const { s, start, workdir } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["failed", "completed"])).status).toBe("failed");
    expect(byKey(run.id).a).toMatchObject({ iterations: MAX_ITERATIONS, mergeCommit: null });
    expect(byKey(run.id).a!.error).toContain("Missing error handling");
    expect(invocations.filter((inv) => inv.prompt.includes("reviewing a teammate's work"))).toHaveLength(MAX_ITERATIONS);
    expect(show(workdir, `${run.branch}:a.txt`)).toBeNull();
  });

  const session = (id: string) => ({ id, costUsd: 0, tokens: 0 });
  const SID = "11111111-2222-4333-8444-555555555555";

  test("a failing verify command goes back to the same session until it passes", async () => {
    plan = { summary: "one", stage: "build", verify: "test -f ok.txt", lessons: "", tasks: [task("a", dev.id)] };
    const prompts: string[] = [];
    workers = {
      a: async (inv) => {
        prompts.push(inv.prompt);
        if (inv.resume) {
          expect(inv.resume.id).toBe(SID);
          await Bun.write(join(inv.cwd, "ok.txt"), "ok");
        } else {
          await Bun.write(join(inv.cwd, "a.txt"), "a");
        }
        return { ok: true, text: "done", session: session(SID) };
      },
    };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    const a = byKey(run.id).a!;
    expect(a.iterations).toBe(2);
    expect(a.session?.id).toBe(SID);
    expect(prompts[1]).toContain("The verify command `test -f ok.txt` failed");
    expect(prompts[0]).toContain("Orchestra runs `test -f ok.txt`");
    // the final verification ran the command on the merged build and showed the director its result
    expect(directorPrompts.at(-1)).toContain("The verify command `test -f ok.txt` passed");
    expect(show(workdir, `${run.branch}:ok.txt`)).toBe("ok");
    expect(a.mergeCommit).not.toBeNull();
  });

  test("a reviewer's requested changes go back to the assignee, then the approved work merges", async () => {
    plan = { summary: "reviewed", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    reviews = [{ verdict: "changes", findings: "1. Add a newline at the end of a.txt" }];
    const prompts: string[] = [];
    workers = {
      a: async (inv) => {
        prompts.push(inv.prompt);
        if (prompts.length === 1) expect(inv.resume).toBeUndefined();
        else expect(inv.resume?.id).toBe(SID);
        await Bun.write(join(inv.cwd, "a.txt"), inv.resume ? "a\n" : "a");
        return { ok: true, text: "done", session: session(SID) };
      },
    };
    const { s, workdir, start } = setup(async (inv) => {
      const result = await fakeRunAgent(inv);
      return inv.prompt.includes("reviewing a teammate's work")
        ? { ...result, session: session("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee") }
        : result;
    });
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    const reviewPrompts = invocations.filter((i) => i.prompt.includes("reviewing a teammate's work"));
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[0]!.agent.id).toBe(qa.id);
    expect(reviewPrompts[0]!.prompt).toContain("+a");
    expect(prompts[1]).toContain("Add a newline at the end of a.txt");
    expect(byKey(run.id).a!.session?.id).toBe(SID);
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("a\n");
  });

  test(`a task still failing after ${MAX_ITERATIONS} attempts fails`, async () => {
    plan = { summary: "never green", stage: "build", verify: "echo nope; exit 1", lessons: "", tasks: [task("a", dev.id)] };
    workers = { a: write("a.txt", "a") };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("failed");
    const a = byKey(run.id).a!;
    expect(a.iterations).toBe(MAX_ITERATIONS);
    expect(a.error).toContain(`Still failing after ${MAX_ITERATIONS} attempts`);
    expect(a.error).toContain("nope");
  });

  test("usage adds up per task and per run", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    workers = { a: async (inv) => ({ ...(await write("a.txt", "a")(inv)), usage: { costUsd: 0.25, tokens: 1000 } }) };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    await waitForRun(run.id, ["completed", "failed"]);
    expect(byKey(run.id).a).toMatchObject({ costUsd: 0.25, tokens: 1000 });
    expect(db.getRun(run.id)).toMatchObject({ costUsd: 0.25, tokens: 1000 });
  });
});

describe("autonomy", () => {
  const startAutonomous = (s: ReturnType<typeof setup>["s"], workdir: string) => s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });

  test("an autonomous run approves its own plans through definition, build and verification", async () => {
    const pm = db.createAgent({ name: "PM", runtime: "claude-code", model: null, effort: null, role: "Product Manager", expertise: "", skills: [], instructions: null });
    plan = { summary: "define", stage: "definition", verify: "", lessons: "", tasks: [task("spec", pm.id)] };
    workers = {
      spec: async (inv) => {
        plan = { summary: "build", stage: "build", verify: "", lessons: "", tasks: [task("impl", dev.id, ["spec"])] };
        return write("spec.md", "spec")(inv);
      },
      impl: write("impl.ts", "impl"),
    };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(done.report).toBe(accept.summary);
    expect(db.listTasks(run.id).map((t) => [t.key, t.stage])).toEqual([["spec", "definition"], ["impl", "build"]]);
    expect(events.some((e) => e.type === "run" && e.run.status === "awaiting_approval")).toBe(true);
  });

  test("failed work is re-planned by the director; the replaced tasks are superseded", async () => {
    const recovery: Plan = {
      summary: "retry b differently", stage: "build", verify: "", lessons: "", tasks: [task("b2", dev.id), task("c2", dev.id, ["a", "b2"])],
    };
    workers = {
      a: write("a.txt", "a"),
      b: async () => {
        plan = recovery; // what the director answers next
        return { ok: false, text: "", error: "boom" };
      },
      b2: write("b.txt", "b"),
      c2: write("c.txt", "c"),
    };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(done.recoveries).toBe(1);
    expect(Object.fromEntries(db.listTasks(run.id).map((t) => [t.key, t.status]))).toEqual({
      a: "done", b: "superseded", c: "superseded", b2: "done", c2: "done",
    });
    expect(directorPrompts.some((p) => p.includes("## Recovering from failed work") && p.includes("boom"))).toBe(true);
    for (const f of ["a.txt", "b.txt", "c.txt"]) expect(show(workdir, `${run.branch}:${f}`)).not.toBeNull();
  });

  test(`recovery stops after ${MAX_RECOVERIES} re-plans and the run pauses`, async () => {
    const failing = (next: string) => async () => {
      plan = { summary: `try ${next}`, stage: "build", verify: "", lessons: "", tasks: [task(next, dev.id)] };
      return { ok: false, text: "", error: "boom" };
    };
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    workers = { a: failing("r1"), r1: failing("r2"), r2: failing("r3") };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed", "paused"]);
    expect(done.status).toBe("paused");
    expect(done.recoveries).toBe(MAX_RECOVERIES);
    expect(db.listTasks(run.id).map((t) => [t.key, t.status])).toEqual([["a", "superseded"], ["r1", "superseded"], ["r2", "failed"]]);
  });

  test("verification gaps become a fix round, then the director accepts", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    verdicts = [{ summary: "a.txt lacks a newline", stage: "fix", verify: "", lessons: "", tasks: [task("fix-a", dev.id, ["a"])] }];
    workers = { a: write("a.txt", "a"), "fix-a": write("a.txt", "a\n") };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(done.fixRounds).toBe(1);
    expect(done.report).toBe(accept.summary);
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("a\n");
  });

  test(`after ${MAX_FIX_ROUNDS} fix rounds the remaining gaps are reported, not run`, async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    const gap = (i: number): Plan => ({ summary: `gap ${i}`, stage: "fix", verify: "", lessons: "", tasks: [task(`fix-${i}`, dev.id)] });
    verdicts = [gap(1), gap(2), gap(3)];
    workers = { a: write("a.txt", "a"), "fix-1": write("f1.txt", "1"), "fix-2": write("f2.txt", "2"), "fix-3": write("f3.txt", "3") };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed", "paused"]);
    expect(done.status).toBe("paused");
    expect(done.report).toStartWith(`Unresolved after ${MAX_FIX_ROUNDS} fix rounds.`);
    expect(done.report).toContain("- Task fix-3: Do fix-3");
    expect(db.listTasks(run.id).map((t) => t.key)).toEqual(["a", "fix-1", "fix-2"]);
    expect(directorPrompts.at(-1)).toContain("This is the last round");
  });
});

describe("steering", () => {
  test("retry keeps earlier files when there is no session, including after reassignment", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    let attempt = 0;
    workers = {
      a: async (inv) => {
        if (++attempt === 1) {
          await Bun.write(join(inv.cwd, "earlier.txt"), "keep this work\n");
          return { ok: false, text: "", error: "interrupted before session was reported" };
        }
        expect(inv.resume).toBeUndefined();
        expect(await Bun.file(join(inv.cwd, "earlier.txt")).text()).toBe("keep this work\n");
        return write("a.txt", "done\n")(inv);
      },
    };
    const { s, start, workdir } = setup();
    const run = await start();
    s.approve(run.id);
    await waitForRun(run.id, ["failed"]);
    s.retry(byKey(run.id).a!.id, { agentId: qa.id });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    await s.waitForCleanup();
    expect(show(workdir, `${run.branch}:earlier.txt`)).toBe("keep this work\n");
  });

  test("the user can edit a plan awaiting approval, within the plan rules", async () => {
    workers = { a: write("a.txt", "a") };
    const { s, start } = setup();
    const run = await start();
    const edited = { ...plan, tasks: [{ ...task("a", qa.id, [], dev.id), title: "Renamed" }] };
    expect(s.editPlan(run.id, edited).plan).toEqual(edited);
    expect(() => s.editPlan(run.id, { ...plan, tasks: [task("a", boss.id)] })).toThrow(`unknown agent "${boss.id}"`);
    s.approve(run.id);
    await waitForRun(run.id, ["completed", "failed"]);
    expect(byKey(run.id).a).toMatchObject({ title: "Renamed", agentId: qa.id, reviewerId: dev.id, status: "done" });
    expect(() => s.editPlan(run.id, edited)).toThrow("Only a plan awaiting approval");
  });

  test("retry resumes the session with the error and the user's instructions; reassigning starts over", async () => {
    const SID = "11111111-2222-4333-8444-555555555555";
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    const calls: AgentInvocation[] = [];
    workers = {
      a: async (inv) => {
        calls.push(inv);
        // The conversation got going before it failed, so it can be resumed.
        if (calls.length < 3) return { ok: false, text: "", error: `boom ${calls.length}`, session: { id: SID, costUsd: 0, tokens: 10 }, usage: { costUsd: 0, tokens: 10 } };
        return write("a.txt", "a")(inv);
      },
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    await waitForRun(run.id, ["failed"]);

    s.retry(byKey(run.id).a!.id, { instructions: "use a.txt" });
    await waitForRun(run.id, ["failed"]);
    expect(calls[1]!.resume?.id).toBe(SID);
    expect(calls[1]!.prompt).toContain("The previous attempt failed:\nboom 1");
    expect(calls[1]!.prompt).toContain("Instructions from the user:\nuse a.txt");

    expect(() => s.retry(byKey(run.id).a!.id, { agentId: boss.id })).toThrow("other than the Director");
    s.retry(byKey(run.id).a!.id, { agentId: qa.id });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(calls[2]!.agent.id).toBe(qa.id);
    expect(calls[2]!.resume).toBeUndefined();
    expect(calls[2]!.prompt).toContain("## Problems to fix from an earlier attempt\nThe previous attempt failed:\nboom 2");
  });

  test("a conversation that can't be resumed is dropped, so the next retry starts fresh", async () => {
    const SID = "11111111-2222-4333-8444-555555555555";
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    const calls: AgentInvocation[] = [];
    workers = {
      a: async (inv) => {
        calls.push(inv);
        if (calls.length === 1) return { ok: false, text: "", error: "boom", session: { id: SID, costUsd: 0, tokens: 10 }, usage: { costUsd: 0, tokens: 10 } };
        if (calls.length === 2) return { ok: false, text: "", error: "No conversation found" }; // resume failed at once
        return write("a.txt", "a")(inv);
      },
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    await waitForRun(run.id, ["failed"]);
    s.retry(byKey(run.id).a!.id);
    await waitForRun(run.id, ["failed"]);
    expect(calls[1]!.resume?.id).toBe(SID);
    expect(byKey(run.id).a!.session).toBeNull();
    s.retry(byKey(run.id).a!.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(calls[2]!.resume).toBeUndefined();
  });

  test("feedback on a completed run reopens it for a round of fixes on the same branch", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    workers = { a: write("a.txt", "a"), polish: write("a.txt", "A") };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");

    verdicts = [{ summary: "capitalize", stage: "fix", verify: "", lessons: "", tasks: [task("polish", dev.id, ["a"])] }];
    s.revise(run.id, "Review comments on the changes (file:line):\n- a.txt:1: capitalize");
    const between = await waitForRun(run.id, ["awaiting_approval", "failed"]);
    expect(between.status).toBe("awaiting_approval");
    expect(directorPrompts.at(-1)).toContain("a.txt:1: capitalize");
    s.approve(run.id);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("A");
  });

  test("a failed run can be handed back to the director to re-plan", async () => {
    workers = { a: write("a.txt", "a"), b: async () => ({ ok: false, text: "", error: "boom" }), b2: write("b.txt", "b") };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    await waitForRun(run.id, ["failed"]);
    plan = { summary: "without c", stage: "build", verify: "", lessons: "", tasks: [task("b2", qa.id, ["a"])] };
    s.revise(run.id, "drop c");
    await waitForRun(run.id, ["awaiting_approval"]);
    expect(directorPrompts.at(-1)).toContain("## Recovering from failed work");
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(byKey(run.id).c!.status).toBe("superseded");
  });
});


describe("continuous building and checkpoints", () => {
  test("verified cycles improve within the brief, pass handoffs, and finish without approvals", async () => {
    plan = { summary: "build", stage: "build", verify: "test -f a.txt", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    let improvement = 0;
    workers = {
      a: write("a.txt", "base\n", "API: a.txt is the shared input. Remaining issue: add dependent output."),
      better: async (inv) => {
        expect(inv.prompt).toContain("API: a.txt");
        expect(inv.prompt).toContain('"ok":true');
        expect(inv.prompt).toContain('"verdict":"approve"');
        expect(await Bun.file(join(inv.cwd, "a.txt")).text()).toBe("base\n");
        return write("b.txt", "improved\n")(inv);
      },
    };
    const { s, workdir } = setup(async (inv) => {
      if (inv.mode === "readonly" && inv.prompt.includes("## Continuous improvement")) {
        expect(inv.prompt).toContain("Do not add unrelated features");
        expect(inv.prompt).toContain("API: a.txt");
        return { ok: true, text: "", structured: ++improvement === 1
          ? { summary: "Improve dependent output", stage: "build", verify: "test -f a.txt && test -f b.txt", lessons: "", tasks: [task("better", dev.id, ["a"], qa.id)] }
          : { ...accept, summary: "No worthwhile improvement remains within the brief." } };
      }
      return fakeRunAgent(inv);
    });
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, continuous: true });
    const finished = await waitForRun(run.id, ["completed", "failed", "paused"]);
    expect(finished.status).toBe("completed");
    expect(improvement).toBe(2);
    expect(finished.history.filter((h) => h.report).map((h) => h.cycle)).toEqual([1, 2, 3]);
    expect(db.listTasks(run.id).map((t) => [t.key, t.cycle, t.phase])).toEqual([["a", 1, "done"], ["better", 2, "done"]]);
    expect(byKey(run.id).better!.handoff).toMatchObject({ files: ["b.txt"], check: { ok: true }, review: { verdict: "approve" } });
    expect(db.listActivity(run.id).some((e) => e.text.includes("Handoff to"))).toBe(true);
    expect(show(workdir, `${run.branch}:b.txt`)).toBe("improved\n");
    expect(show(workdir, "HEAD:b.txt")).toBeNull();
    expect(finished.agentCalls).toBe(9);
  });

  test("call reservation cannot exceed the cap when independent workers launch together", async () => {
    workers = { a: write("a.txt", "a"), b: write("b.txt", "b"), c: write("c.txt", "c") };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 2 } });
    const paused = await waitForRun(run.id, ["paused", "failed"]);
    expect(paused.status).toBe("paused");
    expect(paused.agentCalls).toBe(2);
    expect(invocations).toHaveLength(2);
    expect(paused.pauseReason).toBe("Agent call budget reached");
    expect(db.listTasks(run.id).filter((t) => t.summary)).toHaveLength(1);
    expect(() => s.resume(run.id)).toThrow("Increase the exhausted budget");
    s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 10 }, guidance: "Keep all earlier files" });
    expect((await waitForRun(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
    expect(db.getRun(run.id)!.agentCalls).toBe(5);
    expect(invocations.slice(2).every((i) => i.prompt.includes("Keep all earlier files"))).toBe(true);
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("a");
    expect(show(workdir, "HEAD:a.txt")).toBeNull();
  });

  test("pause during work commits the completed call, resumes at checks, and preserves the session", async () => {
    plan = { summary: "one", stage: "build", verify: "test -f a.txt", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    let finish!: () => void;
    workers = { a: async (inv) => {
      await new Promise<void>((resolve) => { finish = resolve; });
      await Bun.write(join(inv.cwd, "a.txt"), "kept\n");
      return { ok: true, text: "Handoff: kept", session: { id: "11111111-2222-4333-8444-555555555555", tokens: 1, costUsd: 0 } };
    } };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
    while (!finish) await Bun.sleep(5);
    expect(s.pause(run.id).status).toBe("pausing");
    expect(() => s.resume(run.id)).toThrow("Only a paused");
    finish();
    const paused = await waitForRun(run.id, ["paused"]);
    const saved = byKey(run.id).a!;
    expect(saved).toMatchObject({ phase: "check", iterations: 1, summary: "Handoff: kept", session: { tokens: 1 } });
    expect(show(workdir, `${run.branch}:a.txt`)).toBeNull();
    expect(paused.activeSince).toBeNull();
    s.resume(run.id, { guidance: "Verify the kept file" });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(invocations.filter((i) => i.mode === "worker")).toHaveLength(1);
    expect(byKey(run.id).a!.iterations).toBe(1);
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("kept\n");
  });

  test("review calls at the cap save approval and resume directly at merge", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
    workers = { a: write("a.txt", "a") };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 3 } });
    await waitForRun(run.id, ["paused"]);
    expect(byKey(run.id).a).toMatchObject({ phase: "merge", handoff: { review: { verdict: "approve" } } });
    s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 6 } });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(invocations.filter((i) => i.prompt.includes("reviewing a teammate"))).toHaveLength(1);
  });

  test("a last Director call saves the approval checkpoint instead of dropping the plan", async () => {
    workers = { a: write("a.txt", "a"), b: write("b.txt", "b"), c: write("c.txt", "c") };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 1 } });
    expect((await waitForRun(run.id, ["paused"])).checkpoint).toBe("approve");
    expect(db.listTasks(run.id)).toHaveLength(0);
    s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 10 } });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(directorPrompts).toHaveLength(2);
  });

  test("active elapsed time excludes paused time and limits cannot be reduced", async () => {
    let clock = 1000;
    const { s, workdir } = setup(fakeRunAgent, () => clock);
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: false });
    await waitForRun(run.id, ["awaiting_approval"]);
    clock += 30_000;
    s.pause(run.id);
    const used = db.getRun(run.id)!.activeElapsedMs;
    clock += 600_000;
    expect(() => s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 40 } })).toThrow("only increase");
    const resumed = s.resume(run.id);
    expect(resumed.activeElapsedMs).toBe(used);
    expect(resumed.status).toBe("awaiting_approval");
    s.cancel(run.id);
  });

  test("a time deadline aborts the active call, keeps files and session, then resumes", async () => {
    plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
    let attempts = 0;
    workers = { a: async (inv) => {
      if (++attempts > 1) { expect(await Bun.file(join(inv.cwd, "partial.txt")).text()).toBe("partial"); return write("a.txt", "done")(inv); }
      await Bun.write(join(inv.cwd, "partial.txt"), "partial");
      await new Promise<void>((resolve) => inv.signal!.addEventListener("abort", () => resolve(), { once: true }));
      return { ok: false, text: "", session: { id: "11111111-2222-4333-8444-555555555555", costUsd: 0, tokens: 2 } };
    } };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 250, maxAgentCalls: 10 } });
    const paused = await waitForRun(run.id, ["paused"]);
    expect(paused.pauseReason).toBe("Time budget reached");
    expect(byKey(run.id).a).toMatchObject({ phase: "work", session: { tokens: 2 } });
    s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 10 } });
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(show(workdir, `${run.branch}:partial.txt`)).toBe("partial");
    expect(show(workdir, "HEAD:partial.txt")).toBeNull();
  });

  test("cancel after a deadline pause never starts pending work", async () => {
    workers = { a: write("a.txt", "a") };
    const { s, workdir } = setup();
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 1 } });
    await waitForRun(run.id, ["paused"]);
    s.cancel(run.id);
    expect(() => s.resume(run.id)).toThrow("Only a paused");
    expect(db.listTasks(run.id)).toHaveLength(0);
    expect(invocations).toHaveLength(1);
  });

  test("a failed merged-build check cannot be accepted by the Director", async () => {
    plan = { summary: "one", stage: "build", verify: "test ! -f merged-only.txt", lessons: "", tasks: [task("a", dev.id)] };
    workers = { a: write("a.txt", "a") };
    const { s, workdir } = setup();
    // Create the trigger only in integration before its check, after a task merge.
    const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: false });
    await waitForRun(run.id, ["awaiting_approval"]);
    // Give the merged-build command a failure path without breaking task checks.
    s.editPlan(run.id, { ...plan, verify: 'case "$PWD" in */integration) exit 1;; *) exit 0;; esac' });
    s.approve(run.id);
    expect((await waitForRun(run.id, ["failed", "completed"])).status).toBe("failed");
    expect(db.getRun(run.id)!.error).toContain("verify command failed");
  });
});


test("pause during a check saves its evidence and resumes with review", async () => {
  const gate = join(root, `verify-gate-${n}`);
  plan = { summary: "one", stage: "build", verify: `while [ ! -f '${gate}' ]; do sleep 0.01; done`, lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
  workers = { a: write("a.txt", "a") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
  while (byKey(run.id).a?.phase !== "check") await Bun.sleep(5);
  s.pause(run.id);
  await Bun.write(gate, "continue");
  await waitForRun(run.id, ["paused"]);
  expect(byKey(run.id).a).toMatchObject({ phase: "review", handoff: { check: { ok: true } } });
  expect(invocations.filter((inv) => inv.prompt.includes("reviewing a teammate"))).toHaveLength(0);
  s.resume(run.id);
  expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
  expect(invocations.filter((inv) => inv.mode === "worker")).toHaveLength(1);
});

test("a conflict resolver at the budget cap finishes or aborts its merge before pausing", async () => {
  plan = { summary: "parallel conflict", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", qa.id)] };
  workers = { a: write("same.txt", "a\n"), b: write("same.txt", "b\n"), integration: write("same.txt", "resolved\n") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 4 } });
  await waitForRun(run.id, ["paused"]);
  expect(db.listTasks(run.id).every((t) => t.status === "done")).toBe(true);
  expect(show(workdir, `${run.branch}:same.txt`)).toBe("resolved\n");
  expect(db.getRun(run.id)!.agentCalls).toBe(4);
  s.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 6 } });
  expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
});

test("a restarted scheduler resumes a saved merge checkpoint without replaying agents", async () => {
  plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id, [], qa.id)] };
  workers = { a: write("a.txt", "a") };
  const { s, workdir, worktreeRoot } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 3 } });
  await waitForRun(run.id, ["paused"]);
  db.updateRun(run.id, { status: "running", activeSince: Date.now() });
  db.updateTask(byKey(run.id).a!.id, { status: "running" });
  db.failInterrupted();
  const restarted = createScheduler({ db, runAgent: fakeRunAgent, worktreeRoot, publish: (_, ev) => events.push(ev) });
  schedulers.push(restarted);
  expect(db.getRun(run.id)!.status).toBe("failed");
  restarted.resume(run.id, { limits: { maxDurationMs: 60_000, maxAgentCalls: 6 } });
  expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
  expect(invocations.filter((i) => i.mode === "worker")).toHaveLength(1);
  expect(invocations.filter((i) => i.prompt.includes("reviewing a teammate"))).toHaveLength(1);
  expect(show(workdir, `${run.branch}:a.txt`)).toBe("a");
});


test("a malformed late Director result retains a requested pause and can be resumed", async () => {
  let finish!: () => void;
  let calls = 0;
  const { s, workdir } = setup(async (inv) => {
    if (++calls === 1) {
      await new Promise<void>((resolve) => { finish = resolve; });
      return { ok: true, text: "not JSON" };
    }
    return fakeRunAgent(inv);
  });
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
  while (!finish) await Bun.sleep(5);
  s.pause(run.id);
  finish();
  expect((await waitForRun(run.id, ["paused", "failed"])).status).toBe("paused");
  expect(db.getRun(run.id)!.error).toContain("did not return JSON");
  s.resume(run.id);
  await waitForRun(run.id, ["awaiting_approval"]);
  s.cancel(run.id);
});

test("user guidance authorizes one additional fix batch without resetting loop counters", async () => {
  plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  const gap = (i: number): Plan => ({ summary: `gap ${i}`, stage: "fix", verify: "", lessons: "", tasks: [task(`fix-${i}`, dev.id)] });
  verdicts = [gap(1), gap(2), gap(3)];
  workers = { a: write("a.txt", "a"), "fix-1": write("f1.txt", "1"), "fix-2": write("f2.txt", "2"), "fix-3": write("f3.txt", "3") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
  await waitForRun(run.id, ["paused"]);
  const used = db.getRun(run.id)!.agentCalls;
  s.resume(run.id, { guidance: "Address the remaining gap in a single focused pass" });
  expect((await waitForRun(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  expect(db.getRun(run.id)!.fixRounds).toBe(MAX_FIX_ROUNDS + 1);
  expect(db.getRun(run.id)!.agentCalls).toBeGreaterThan(used);
  expect(show(workdir, `${run.branch}:f3.txt`)).toBe("3");
});

test("user guidance re-plans exhausted recovery without discarding its counters", async () => {
  const failing = (next: string) => async () => {
    plan = { summary: `try ${next}`, stage: "build", verify: "", lessons: "", tasks: [task(next, dev.id)] };
    return { ok: false, text: "", error: "boom" };
  };
  plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  workers = { a: failing("r1"), r1: failing("r2"), r2: failing("r3"), r3: write("a.txt", "recovered") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
  await waitForRun(run.id, ["paused"]);
  s.resume(run.id, { guidance: "Use the corrected approach" });
  expect((await waitForRun(run.id, ["completed", "failed", "paused"])).status).toBe("completed");
  expect(db.getRun(run.id)!.recoveries).toBe(MAX_RECOVERIES);
  expect(show(workdir, `${run.branch}:a.txt`)).toBe("recovered");
});

test("continue without instructions makes one recovery attempt and pauses again on failure", async () => {
  const failing = (next: string) => async () => {
    plan = { summary: `try ${next}`, stage: "build", verify: "", lessons: "", tasks: [task(next, dev.id)] };
    return { ok: false, text: "", error: "still broken" };
  };
  plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  workers = { a: failing("r1"), r1: failing("r2"), r2: failing("r3"), r3: failing("r4") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
  const before = await waitForRun(run.id, ["paused"]);
  s.resume(run.id);
  const after = await waitForRun(run.id, ["paused"]);
  expect(after.pauseReason).toBe("Recovery limit reached");
  expect(after.recoveries).toBe(MAX_RECOVERIES);
  expect(after.agentCalls).toBe(before.agentCalls + 2);
  expect(after.activeElapsedMs).toBeGreaterThanOrEqual(before.activeElapsedMs);
  expect(after.limits).toEqual(before.limits);
  expect(directorPrompts.at(-1)).toContain("The user chose to continue the remaining work");
  expect(directorPrompts.at(-1)).toContain("still broken");
  await Bun.sleep(50);
  expect(db.getRun(run.id)!.agentCalls).toBe(after.agentCalls);
});

test("continue without instructions permits one fix batch without resetting counters", async () => {
  plan = { summary: "one", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  const gap = (i: number): Plan => ({ summary: `gap ${i}`, stage: "fix", verify: "", lessons: "", tasks: [task(`fix-${i}`, dev.id)] });
  verdicts = [gap(1), gap(2), gap(3), gap(4)];
  workers = { a: write("a.txt", "a"), "fix-1": write("f1.txt", "1"), "fix-2": write("f2.txt", "2"), "fix-3": write("f3.txt", "3") };
  const { s, workdir } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, autonomous: true });
  const before = await waitForRun(run.id, ["paused"]);
  s.resume(run.id, { guidance: "   " });
  const after = await waitForRun(run.id, ["paused"]);
  expect(after.pauseReason).toBe("Fix round limit reached");
  expect(after.fixRounds).toBe(MAX_FIX_ROUNDS + 1);
  expect(after.agentCalls).toBe(before.agentCalls + 2);
  expect(after.limits).toEqual(before.limits);
  expect(byKey(run.id)["fix-4"]).toBeUndefined();
  expect(show(workdir, `${run.branch}:f3.txt`)).toBe("3");
});

test("guidance added while running reaches the next agent call without pausing", async () => {
  const { s, start } = setup();
  plan = { summary: "Two steps", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", dev.id, ["a"])] };
  let runId = "";
  workers = {
    a: async (inv) => {
      expect(inv.prompt).not.toContain("Use tabs");
      s.addGuidance(runId, "Use tabs for indentation.");
      return write("a.txt", "a\n")(inv);
    },
    b: write("b.txt", "b\n"),
  };
  const run = await start();
  runId = run.id;
  s.approve(run.id);
  await waitForRun(run.id, ["completed"]);
  const b = invocations.find((inv) => basename(inv.cwd) === "b")!;
  expect(b.prompt).toContain("## Current guidance from the user\nUse tabs for indentation.");
  expect(db.getRun(run.id)!.guidance).toBe("Use tabs for indentation.");
  expect(() => s.addGuidance(run.id, "late")).toThrow("use resume");
});

test("project memory reaches every agent before the run's guidance; proposed lessons wait for the user", async () => {
  const { s, workdir } = setup();
  db.setMemory(workdir, "Run `bun test` to check.");
  db.setMemory(join(root, "elsewhere"), "Another project's note");
  plan = { summary: "One step", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  verdicts = [{ ...accept, lessons: "The API lives in src/api." }];
  workers = { a: write("a.txt", "a\n") };
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
  await waitForRun(run.id, ["awaiting_approval"]);
  s.addGuidance(run.id, "Keep it small.");
  s.approve(run.id);
  const done = await waitForRun(run.id, ["completed"]);

  expect(invocations.length).toBeGreaterThan(2);
  for (const inv of invocations) {
    expect(inv.prompt).toContain("## Project memory\nNotes the user kept from earlier runs on this project. Follow them unless the goal or the user's guidance says otherwise.\nRun `bun test` to check.");
    expect(inv.prompt).not.toContain("Another project's note");
  }
  const worker = invocations.find((inv) => basename(inv.cwd) === "a")!.prompt;
  expect(worker.indexOf("## Project memory")).toBeLessThan(worker.indexOf("## Current guidance from the user"));
  expect(directorPrompts[0]).toContain("lessons: only when you return no tasks and accept the build");
  // Proposed, not saved: the user chooses what the project keeps.
  expect(done.history.at(-1)!.plan!.lessons).toBe("The API lives in src/api.");
  expect(db.getMemory(workdir)).toBe("Run `bun test` to check.");
});

test("the user's check command reaches the Director as the suggested verify command", async () => {
  const { s, workdir } = setup();
  plan = { summary: "One step", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  const run = await s.startRun({ teamId: team(), prompt: "Build it", workdir, checkCommand: "bun test && bun run typecheck" });
  await waitForRun(run.id, ["awaiting_approval"]);
  expect(db.getRun(run.id)!.checkCommand).toBe("bun test && bun run typecheck");
  expect(directorPrompts.at(-1)).toContain("The user checks this project with `bun test && bun run typecheck`");
});

test("deleting a run removes its rows, worktrees and task branches, and its branch only on request", async () => {
  const { s, workdir, worktreeRoot, start } = setup();
  const branchExists = (b: string) => Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/heads/${b}`], { cwd: workdir }).exitCode === 0;
  plan = { summary: "One step", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  workers = { a: async () => ({ ok: false, text: "", error: "boom" }) };
  const failed = await start();
  s.approve(failed.id);
  await waitForRun(failed.id, ["failed"]);
  const mainBefore = show(workdir, "main");
  expect(mainBefore).not.toBeNull();
  expect(existsSync(join(worktreeRoot, failed.id, "a"))).toBe(true);
  expect(branchExists(`${failed.branch}-a`)).toBe(true);

  expect(await s.deleteRun(failed.id, { deleteBranch: false })).toEqual({ remaining: [] });
  expect(db.getRun(failed.id)).toBeNull();
  expect(events.at(-1)).toEqual({ type: "deleted", runId: failed.id });
  expect(db.listTasks(failed.id)).toEqual([]);
  expect(db.listLogs(failed.id, null)).toEqual([]);
  expect(existsSync(join(worktreeRoot, failed.id))).toBe(false);
  expect(branchExists(`${failed.branch}-a`)).toBe(false);
  expect(branchExists(failed.branch)).toBe(true);
  expect(show(workdir, "main")).toBe(mainBefore);

  workers = { a: write("a.txt", "a\n") };
  const done = await s.startRun({ teamId: team(), prompt: "Build it", workdir });
  await waitForRun(done.id, ["awaiting_approval"]);
  s.approve(done.id);
  await waitForRun(done.id, ["completed"]);
  await s.deleteRun(done.id, { deleteBranch: true });
  expect(branchExists(done.branch)).toBe(false);
  expect(show(workdir, "main")).toBe(mainBefore);
});

test("a run that is still working can't be deleted", async () => {
  const { s, start } = setup();
  plan = { summary: "One step", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id)] };
  let release!: () => void;
  workers = { a: (inv) => new Promise((resolve) => { release = () => resolve(write("a.txt", "a\n")(inv)); }) };
  const run = await start();
  s.approve(run.id);
  await waitForRun(run.id, ["running"]);
  await expect(s.deleteRun(run.id, { deleteBranch: false })).rejects.toThrow("Pause or cancel");
  while (!release) await Bun.sleep(5);
  release();
  await waitForRun(run.id, ["completed"]);
});

describe('automatic continuation after provider rate limits', () => {
  function limitedSetup(agent: RunAgent, clock = Date.now) {
    const callbacks: (() => void)[] = [];
    const delays: number[] = [];
    const scheduleRateLimitRetry = ((callback: () => void, delay: number) => {
      callbacks.push(callback);
      delays.push(delay);
      return setTimeout(() => {}, 2_000_000);
    }) as typeof setTimeout;
    const s = createScheduler({ db, runAgent: agent, now: clock, worktreeRoot: join(root, `rate-wt${n}`), publish: (_, ev) => events.push(ev), scheduleRateLimitRetry });
    schedulers.push(s);
    const workdir = join(root, `rate-project${n++}`);
    return { s, callbacks, delays, workdir };
  }
  const limited: AgentResult = { ok: false, text: "You've hit your session limit · resets 9:40pm (Europe/Rome)", error: 'success' };

  test('Director resumes the saved plan checkpoint, excluding waiting time', async () => {
    let time = Date.parse('2026-10-18T15:50:02Z');
    let calls = 0;
    const { s, callbacks, delays, workdir } = limitedSetup(async (inv) => ++calls === 1 ? limited : fakeRunAgent(inv), () => time);
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true });
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.checkpoint).toBe('plan');
    expect(paused.agentCalls).toBe(1);
    expect(paused.rateLimitRetries).toBe(1);
    expect(paused.rateLimitResumeAt).toBe(Date.parse('2026-10-18T19:41:00Z'));
    expect(delays[0]).toBe(paused.rateLimitResumeAt! - time);
    time = paused.rateLimitResumeAt!;
    callbacks.shift()!();
    const continued = await waitForRun(run.id, ['awaiting_approval']);
    expect(continued.agentCalls).toBe(2);
    expect(continued.activeElapsedMs).toBe(0);
    expect(continued.rateLimitResumeAt).toBeNull();
  });

  test('an existing rate-limited failure can opt in and wait without replaying calls', async () => {
    let calls = 0;
    const { s, callbacks, workdir } = limitedSetup(async (inv) => ++calls === 1 ? { ...limited, error: limited.text } : fakeRunAgent(inv), () => Date.parse('2026-10-18T16:22:00Z'));
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir });
    await waitForRun(run.id, ['failed']);
    const waiting = s.resume(run.id, { autoContinueOnRateLimit: true });
    expect(waiting.status).toBe('paused');
    expect(waiting.autoContinueOnRateLimit).toBe(true);
    expect(waiting.rateLimitResumeAt).toBe(Date.parse('2026-10-18T19:41:00Z'));
    expect(waiting.agentCalls).toBe(1);
    expect(calls).toBe(1);
    callbacks.shift()!();
    await waitForRun(run.id, ['awaiting_approval']);
    expect(calls).toBe(2);
  });

  test('option defaults off and leaves ordinary failure behavior', async () => {
    const { s, callbacks, workdir } = limitedSetup(async () => limited);
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir });
    expect((await waitForRun(run.id, ['failed'])).autoContinueOnRateLimit).toBe(false);
    expect(callbacks).toHaveLength(0);
  });

  test('worker retains its session and iterations; reviewer resumes without repeating work', async () => {
    const session = { id: crypto.randomUUID(), tokens: 0, costUsd: 0 };
    let workCalls = 0;
    let reviewCalls = 0;
    plan.tasks = [task('a', dev.id, [], qa.id)];
    const { s, callbacks, workdir } = limitedSetup(async (inv) => {
      if (inv.mode === 'worker') {
        if (++workCalls === 1) return { ...limited, session };
        expect(inv.resume?.id).toBe(session.id);
        return write('a.txt', 'done')(inv);
      }
      if (inv.prompt.includes("reviewing a teammate's work") && ++reviewCalls === 1) return { ...limited, session: { ...session, id: crypto.randomUUID() } };
      return fakeRunAgent(inv);
    });
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true });
    await waitForRun(run.id, ['awaiting_approval']);
    s.approve(run.id);
    await waitForRun(run.id, ['paused']);
    expect(byKey(run.id).a!.iterations).toBe(0);
    expect(byKey(run.id).a!.session?.id).toBe(session.id);
    callbacks.shift()!();
    await waitForRun(run.id, ['paused']);
    expect(byKey(run.id).a!.phase).toBe('review');
    expect(byKey(run.id).a!.iterations).toBe(1);
    expect(byKey(run.id).a!.session?.id).toBe(session.id);
    callbacks.shift()!();
    await waitForRun(run.id, ['completed']);
    expect(workCalls).toBe(2);
    expect(reviewCalls).toBe(2);
  });

  test('cancel prevents scheduled continuation', async () => {
    let calls = 0;
    const { s, callbacks, workdir } = limitedSetup(async () => { calls++; return limited; });
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true });
    await waitForRun(run.id, ['paused']);
    s.cancel(run.id);
    callbacks.shift()!();
    expect(db.getRun(run.id)!.status).toBe('cancelled');
    expect(db.getRun(run.id)!.rateLimitResumeAt).toBeNull();
    expect(calls).toBe(1);
  });

  test('retry cap prevents unbounded continuation', async () => {
    const { s, callbacks, workdir } = limitedSetup(async () => limited);
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true });
    await waitForRun(run.id, ['paused']);
    for (let i = 0; i < 5; i++) {
      callbacks.shift()!();
      await waitForRun(run.id, ['paused']);
    }
    expect(db.getRun(run.id)!.rateLimitResumeAt).toBeNull();
    expect(db.getRun(run.id)!.rateLimitRetries).toBe(5);
    expect(callbacks).toHaveLength(0);
    expect(db.getRun(run.id)!.agentCalls).toBe(6);
  });


  test('an exhausted call budget overrides automatic continuation', async () => {
    const { s, callbacks, workdir } = limitedSetup(async () => limited);
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true, limits: { maxDurationMs: 60_000, maxAgentCalls: 1 } });
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.pauseReason).toBe('Agent call budget reached');
    expect(paused.rateLimitResumeAt).toBeNull();
    expect(callbacks).toHaveLength(0);
    expect(() => s.resume(run.id)).toThrow('Increase the exhausted budget');
  });

  test('server restart clears automatic continuation and requires explicit resume', async () => {
    const { s, callbacks, workdir } = limitedSetup(async () => limited);
    const run = await s.startRun({ teamId: team(), prompt: 'Build', workdir, autoContinueOnRateLimit: true });
    await waitForRun(run.id, ['paused']);
    db.failInterrupted();
    callbacks.shift()!();
    expect(db.getRun(run.id)!.rateLimitResumeAt).toBeNull();
    expect(db.getRun(run.id)!.pauseReason).toBe('Interrupted by server restart');
    expect(db.getRun(run.id)!.status).toBe('paused');
  });
});

describe('account quota safeguard', () => {
  function guardedSetup(getQuota: NonNullable<Parameters<typeof createScheduler>[0]['getQuota']>, runAgent: RunAgent = fakeRunAgent, now = Date.now, quotaPollMs = 60_000) {
    const callbacks: (() => Promise<void>)[] = [];
    const scheduleRateLimitRetry = ((callback: () => Promise<void>) => {
      callbacks.push(callback);
      return setTimeout(() => {}, 2_000_000);
    }) as typeof setTimeout;
    const s = createScheduler({ db, runAgent, getQuota, now, quotaPollMs, worktreeRoot: join(root, `guard-wt${n}`), publish: (_, ev) => events.push(ev), scheduleRateLimitRetry });
    schedulers.push(s);
    return { s, callbacks, workdir: join(root, `guard-project${n++}`) };
  }
  const policy = { maxUsedPercent: 50, window: 'both' as const };

  test('one global policy covers existing agents on either runtime without individual edits', async () => {
    const agentsBefore = db.listAgents();
    db.setGlobalRateLimitPolicy(policy);
    plan.tasks = [task('a', qa.id)];
    const { s, workdir } = guardedSetup(async (agent) => [{ window: 'weekly', usedPercent: agent.runtime === 'codex' ? 60 : 10, resetsAt: Date.now() + 3600_000 }]);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build' });
    await waitForRun(run.id, ['awaiting_approval']);
    s.approve(run.id);
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.agentCalls).toBe(1);
    expect(paused.quotaWait?.agentId).toBe(qa.id);
    expect(paused.rateLimitPolicy).toBeNull();
    expect(db.listAgents()).toEqual(agentsBefore);
  });

  test('global changes protect an already-running worker at the next quota poll', async () => {
    db.setGlobalRateLimitPolicy({ maxUsedPercent: 80, window: 'weekly' });
    plan.tasks = [task('a', dev.id)];
    let working = false;
    const { s, workdir } = guardedSetup(async () => [{ window: 'weekly', usedPercent: 60, resetsAt: Date.now() + 3600_000 }], async (inv) => {
      if (inv.mode !== 'worker') return fakeRunAgent(inv);
      working = true;
      return new Promise((resolve) => inv.signal!.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'cancelled' }), { once: true }));
    }, Date.now, 10);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build' });
    await waitForRun(run.id, ['awaiting_approval']);
    s.approve(run.id);
    while (!working) await Bun.sleep(5);
    db.setGlobalRateLimitPolicy({ maxUsedPercent: 50, window: 'weekly' });
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.quotaWait?.agentId).toBe(dev.id);
    expect(paused.agentCalls).toBe(2);
    expect(byKey(run.id).a!.status).toBe('pending');
  });

  test('explicit agent and project exceptions take precedence over the global default', async () => {
    db.setGlobalRateLimitPolicy({ maxUsedPercent: 10, window: 'weekly' });
    db.updateAgent(boss.id, { ...boss, rateLimitPolicy: { maxUsedPercent: 80, window: 'weekly' } });
    const { s, workdir } = guardedSetup(async () => [{ window: 'weekly', usedPercent: 60, resetsAt: Date.now() + 3600_000 }]);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build' });
    await waitForRun(run.id, ['awaiting_approval']);
    const override = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: { maxUsedPercent: 50, window: 'weekly' } });
    expect((await waitForRun(override.id, ['paused'])).agentCalls).toBe(0);
  });

  test('project defaults pause before the first call and resume only on a confirmed full refill', async () => {
    let time = Date.now();
    let usedPercent = 50;
    const { s, callbacks, workdir } = guardedSetup(async () => [{ window: 'weekly', usedPercent, resetsAt: time + 3600_000 }], fakeRunAgent, () => time);
    db.setRateLimitPolicy(workdir, policy);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build' });
    let paused = await waitForRun(run.id, ['paused']);
    expect(paused.rateLimitPolicy).toEqual(policy);
    expect(paused.agentCalls).toBe(0);
    expect(invocations).toHaveLength(0);
    expect(paused.quotaWait?.window).toBe('weekly');
    usedPercent = 20; // Below the ceiling is insufficient: wait for 100% available.
    s.resume(run.id);
    await Bun.sleep(30);
    expect(db.getRun(run.id)!.status).toBe('paused');
    expect(db.getRun(run.id)!.agentCalls).toBe(0);
    usedPercent = 0;
    time += 3600_000;
    // Invoke the newest timer; manual resume replaced the previous one.
    await callbacks.pop()!();
    paused = await waitForRun(run.id, ['awaiting_approval']);
    expect(paused.quotaWait).toBeNull();
    expect(paused.agentCalls).toBe(1);
    expect(paused.activeElapsedMs).toBe(0);
  });

  test('agent defaults apply and a project override selects the relevant window', async () => {
    db.updateAgent(boss.id, { ...boss, rateLimitPolicy: { maxUsedPercent: 10, window: 'weekly' } });
    const { s, workdir } = guardedSetup(async () => [
      { window: '5h', usedPercent: 15, resetsAt: Date.now() + 3600_000 },
      { window: 'weekly', usedPercent: 90, resetsAt: Date.now() + 86400_000 },
    ]);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: { maxUsedPercent: 50, window: '5h' } });
    await waitForRun(run.id, ['awaiting_approval']);
    expect(db.getRun(run.id)!.agentCalls).toBe(1);
    const second = await s.startRun({ teamId: team(), workdir, prompt: 'Build' });
    expect((await waitForRun(second.id, ['paused'])).agentCalls).toBe(0);
  });

  test('quota unavailable fails closed without an agent call or automatic retry', async () => {
    const { s, callbacks, workdir } = guardedSetup(async () => []);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: policy });
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.pauseReason).toContain('Usage safeguard unavailable');
    expect(paused.agentCalls).toBe(0);
    expect(callbacks).toHaveLength(0);
  });

  test('refill rechecks are bounded without consuming agent calls', async () => {
    const { s, callbacks, workdir } = guardedSetup(async () => [{ window: '5h', usedPercent: 75, resetsAt: Date.now() + 3600_000 }]);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: policy });
    await waitForRun(run.id, ['paused']);
    for (let i = 0; i < 5; i++) await callbacks.shift()!();
    expect(callbacks).toHaveLength(0);
    expect(db.getRun(run.id)!.rateLimitResumeAt).toBeNull();
    expect(db.getRun(run.id)!.agentCalls).toBe(0);
    s.cancel(run.id);
    expect(db.getRun(run.id)!.status).toBe('cancelled');
  });

  test('cancellation while waiting for quota cannot restart or replace the cancelled run', async () => {
    let release!: (value: import('../src/shared/types.ts').QuotaWindow[]) => void;
    const { s, workdir } = guardedSetup(() => new Promise((resolve) => { release = resolve; }));
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: policy });
    while (!release) await Bun.sleep(5);
    s.cancel(run.id);
    release([{ window: '5h', usedPercent: 75, resetsAt: Date.now() + 3600_000 }]);
    await Bun.sleep(30);
    expect(db.getRun(run.id)!.status).toBe('cancelled');
    expect(db.getRun(run.id)!.agentCalls).toBe(0);
  });

  test('parallel quota reads do not allow calls beyond the shared run budget', async () => {
    workers = { a: write('a.txt', 'a'), b: write('b.txt', 'b'), c: write('c.txt', 'c') };
    const { s, workdir } = guardedSetup(async () => {
      await Bun.sleep(10);
      return [{ window: '5h', usedPercent: 0, resetsAt: Date.now() + 3600_000 }];
    });
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: policy, limits: { maxDurationMs: 60_000, maxAgentCalls: 2 } });
    await waitForRun(run.id, ['awaiting_approval']);
    s.approve(run.id);
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.agentCalls).toBe(2);
    expect(invocations).toHaveLength(2);
    expect(paused.pauseReason).toBe('Agent call budget reached');
  });

  test('long-running workers stop, save session and files, then resume at the same checkpoint', async () => {
    let usedPercent = 0;
    let workCalls = 0;
    const session = { id: crypto.randomUUID(), tokens: 10, costUsd: 0 };
    plan.tasks = [task('a', dev.id)];
    const { s, callbacks, workdir } = guardedSetup(async () => [{ window: '5h', usedPercent, resetsAt: Date.now() + 3600_000 }], async (inv) => {
      if (inv.mode !== 'worker') return fakeRunAgent(inv);
      workCalls++;
      if (workCalls === 1) {
        await Bun.write(join(inv.cwd, 'partial.txt'), 'saved');
        usedPercent = 51;
        return new Promise((resolve) => inv.signal!.addEventListener('abort', () => resolve({ ok: false, text: '', error: 'cancelled', session, usage: { tokens: 10, costUsd: null } }), { once: true }));
      }
      expect(inv.resume?.id).toBe(session.id);
      expect(await Bun.file(join(inv.cwd, 'partial.txt')).text()).toBe('saved');
      return write('done.txt', 'done')(inv);
    }, Date.now, 10);
    const run = await s.startRun({ teamId: team(), workdir, prompt: 'Build', rateLimitPolicy: policy });
    await waitForRun(run.id, ['awaiting_approval']);
    s.approve(run.id);
    const paused = await waitForRun(run.id, ['paused']);
    expect(paused.checkpoint).toBe('execute');
    expect(byKey(run.id).a).toMatchObject({ phase: 'work', status: 'pending', iterations: 0, session });
    expect(paused.tokens).toBe(10);
    usedPercent = 0;
    await callbacks.shift()!();
    const completed = await waitForRun(run.id, ['completed']);
    expect(completed.agentCalls).toBe(4); // Director, interrupted worker, resumed worker, verification.
    expect(workCalls).toBe(2);
    expect(byKey(run.id).a!.iterations).toBe(1);
  });
});

test("live preview follows completed task merges while the team works, survives completion, and stops before deletion", async () => {
  plan = { summary: "Build in two slices", stage: "build", verify: "", lessons: "", tasks: [task("a", dev.id), task("b", dev.id, ["a"])] };
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  workers = {
    a: write("index.html", "First slice"),
    b: async (inv) => { await gate; return write("index.html", "Second slice")(inv); },
  };
  const { s, workdir, worktreeRoot } = setup();
  const run = await s.startRun({ teamId: team(), prompt: "Build a web app", workdir, preview: { enabled: true, command: "" } });
  try {
    await waitForRun(run.id, ["awaiting_approval"]);
    s.approve(run.id);
    for (let i = 0; i < 300 && s.getPreview(run.id).status !== "ready"; i++) await Bun.sleep(20);
    expect(db.getRun(run.id)!.status).toBe("running");
    expect(s.getPreview(run.id).status).toBe("ready");
    expect(await (await fetch(s.getPreview(run.id).url!)).text()).toBe("First slice");
    release();
    await waitForRun(run.id, ["completed"]);
    await s.waitForCleanup();
    const merged = byKey(run.id).b!.mergeCommit;
    for (let i = 0; i < 300 && s.getPreview(run.id).commit !== merged; i++) await Bun.sleep(20);
    const url = s.getPreview(run.id).url!;
    expect(await (await fetch(url)).text()).toBe("Second slice");
    expect(existsSync(join(worktreeRoot, run.id, "integration"))).toBe(false);
    expect(directorPrompts[0]).toContain("## Live preview");
    expect(db.getRun(run.id)!.agentCalls).toBeLessThan(8);
    await s.deleteRun(run.id, { deleteBranch: false });
    expect(existsSync(join(worktreeRoot, run.id))).toBe(false);
    await expect(fetch(url)).rejects.toThrow();
  } finally {
    release();
    await s.shutdownPreviews();
  }
});
