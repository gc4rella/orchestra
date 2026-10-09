import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
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

const accept: Plan = { summary: "Checked everything; the goal is met.", stage: "fix", verify: "", tasks: [] };

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

function setup() {
  const s = createScheduler({ db, runAgent: fakeRunAgent, worktreeRoot: join(root, `wt${n}`), publish: (_, ev) => events.push(ev) });
  schedulers.push(s);
  const workdir = join(root, `project${n++}`);
  const start = async () => {
    const run = await s.startRun({ prompt: "Build it", workdir });
    await waitForRun(run.id, ["awaiting_approval"]);
    return run;
  };
  return { s, workdir, start };
}

const task = (id: string, agentId: string, dependsOn: string[] = [], reviewerId = ""): PlanTask => ({
  id, title: `Task ${id}`, description: `Do ${id}`, agentId, reviewerId, dependsOn, acceptanceCriteria: "",
});
const byKey = (runId: string) => Object.fromEntries(db.listTasks(runId).map((t) => [t.key, t]));

beforeEach(() => {
  db = openDb(":memory:");
  boss = db.createAgent({ name: "Boss", runtime: "claude-code", model: null, role: DIRECTOR_ROLE, skills: "", instructions: null });
  dev = db.createAgent({ name: "Dev", runtime: "claude-code", model: null, role: "Engineer", skills: "", instructions: null });
  qa = db.createAgent({ name: "QA", runtime: "codex", model: null, role: "QA", skills: "", instructions: null });
  events = [];
  directorPrompts = [];
  invocations = [];
  verdicts = [];
  reviews = [];
  plan = {
    summary: "two in parallel, then integrate", stage: "build", verify: "",
    tasks: [task("a", dev.id), task("b", qa.id), task("c", dev.id, ["a", "b"])],
  };
});

describe("scheduler", () => {
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
    plan = { summary: "conflict", stage: "build", verify: "", tasks: [task("a", dev.id), task("b", qa.id)] };
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
    plan = { summary: "conflict", stage: "build", verify: "", tasks: [task("a", dev.id), task("b", qa.id)] };
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
    plan = { summary: "conflict", stage: "build", verify: "", tasks: [task("a", dev.id), task("b", qa.id)] };
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
    plan = { summary: "bad", stage: "build", verify: "", tasks: [task("a", "ghost")] };
    const { s, workdir } = setup();
    const run = await s.startRun({ prompt: "Build it", workdir });
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
    plan = { summary: "self", stage: "build", verify: "", tasks: [task("a", boss.id)] };
    const { s, workdir } = setup();
    const run = await s.startRun({ prompt: "Build it", workdir });
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.error).toContain(`unknown agent "${boss.id}"`);
  });

  test("a run needs a Director and a team", async () => {
    const { s, workdir } = setup();
    db.deleteAgent(dev.id);
    db.deleteAgent(qa.id);
    await expect(s.startRun({ prompt: "x", workdir })).rejects.toThrow("at least one team member");
    db.deleteAgent(boss.id);
    await expect(s.startRun({ prompt: "x", workdir })).rejects.toThrow("Hire a Director");
  });
});

describe("two-stage planning", () => {
  test("after the definition stage the director plans the build from the team's docs", async () => {
    const pm = db.createAgent({ name: "PM", runtime: "claude-code", model: null, role: "Product Manager", skills: "", instructions: null });
    plan = { summary: "define first", stage: "definition", verify: "", tasks: [task("spec", pm.id), task("design", dev.id, ["spec"])] };
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
    plan = { summary: "now build", stage: "build", verify: "", tasks: [task("api", dev.id, ["design"]), task("qa", qa.id, ["api"])] };
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
    plan = { summary: "define", stage: "definition", verify: "", tasks: [task("spec", dev.id)] };
    workers = { spec: write("spec.md", "spec") };
    const { s, start } = setup();
    const run = await start();
    plan = { summary: "bad build", stage: "definition", verify: "", tasks: [task("more", dev.id)] }; // must be "build" now
    s.approve(run.id);
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain('stage must be "build"');

    plan = { summary: "build", stage: "build", verify: "", tasks: [task("impl", dev.id, ["spec"])] };
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
  const session = (id: string) => ({ id, costUsd: 0, tokens: 0 });
  const SID = "11111111-2222-4333-8444-555555555555";

  test("a failing verify command goes back to the same session until it passes", async () => {
    plan = { summary: "one", stage: "build", verify: "test -f ok.txt", tasks: [task("a", dev.id)] };
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
    plan = { summary: "reviewed", stage: "build", verify: "", tasks: [task("a", dev.id, [], qa.id)] };
    reviews = [{ verdict: "changes", findings: "1. Add a newline at the end of a.txt" }];
    const prompts: string[] = [];
    workers = {
      a: async (inv) => {
        prompts.push(inv.prompt);
        await Bun.write(join(inv.cwd, "a.txt"), inv.resume ? "a\n" : "a");
        return { ok: true, text: "done", session: session(SID) };
      },
    };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    const reviewPrompts = invocations.filter((i) => i.prompt.includes("reviewing a teammate's work"));
    expect(reviewPrompts).toHaveLength(2);
    expect(reviewPrompts[0]!.agent.id).toBe(qa.id);
    expect(reviewPrompts[0]!.prompt).toContain("+a");
    expect(prompts[1]).toContain("Add a newline at the end of a.txt");
    expect(show(workdir, `${run.branch}:a.txt`)).toBe("a\n");
  });

  test(`a task still failing after ${MAX_ITERATIONS} attempts fails`, async () => {
    plan = { summary: "never green", stage: "build", verify: "echo nope; exit 1", tasks: [task("a", dev.id)] };
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
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
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
  const startAutonomous = (s: ReturnType<typeof setup>["s"], workdir: string) => s.startRun({ prompt: "Build it", workdir, autonomous: true });

  test("an autonomous run approves its own plans through definition, build and verification", async () => {
    const pm = db.createAgent({ name: "PM", runtime: "claude-code", model: null, role: "Product Manager", skills: "", instructions: null });
    plan = { summary: "define", stage: "definition", verify: "", tasks: [task("spec", pm.id)] };
    workers = {
      spec: async (inv) => {
        plan = { summary: "build", stage: "build", verify: "", tasks: [task("impl", dev.id, ["spec"])] };
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
      summary: "retry b differently", stage: "build", verify: "", tasks: [task("b2", dev.id), task("c2", dev.id, ["a", "b2"])],
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

  test(`recovery stops after ${MAX_RECOVERIES} re-plans and the run fails`, async () => {
    const failing = (next: string) => async () => {
      plan = { summary: `try ${next}`, stage: "build", verify: "", tasks: [task(next, dev.id)] };
      return { ok: false, text: "", error: "boom" };
    };
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
    workers = { a: failing("r1"), r1: failing("r2"), r2: failing("r3") };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("failed");
    expect(done.recoveries).toBe(MAX_RECOVERIES);
    expect(db.listTasks(run.id).map((t) => [t.key, t.status])).toEqual([["a", "superseded"], ["r1", "superseded"], ["r2", "failed"]]);
  });

  test("verification gaps become a fix round, then the director accepts", async () => {
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
    verdicts = [{ summary: "a.txt lacks a newline", stage: "fix", verify: "", tasks: [task("fix-a", dev.id, ["a"])] }];
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
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
    const gap = (i: number): Plan => ({ summary: `gap ${i}`, stage: "fix", verify: "", tasks: [task(`fix-${i}`, dev.id)] });
    verdicts = [gap(1), gap(2), gap(3)];
    workers = { a: write("a.txt", "a"), "fix-1": write("f1.txt", "1"), "fix-2": write("f2.txt", "2"), "fix-3": write("f3.txt", "3") };
    const { s, workdir } = setup();
    const run = await startAutonomous(s, workdir);
    const done = await waitForRun(run.id, ["completed", "failed"]);
    expect(done.status).toBe("completed");
    expect(done.report).toStartWith(`Unresolved after ${MAX_FIX_ROUNDS} fix rounds.`);
    expect(done.report).toContain("- Task fix-3: Do fix-3");
    expect(db.listTasks(run.id).map((t) => t.key)).toEqual(["a", "fix-1", "fix-2"]);
    expect(directorPrompts.at(-1)).toContain("This is the last round");
  });
});

describe("steering", () => {
  test("retry keeps earlier files when there is no session, including after reassignment", async () => {
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
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
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
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
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
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
    plan = { summary: "one", stage: "build", verify: "", tasks: [task("a", dev.id)] };
    workers = { a: write("a.txt", "a"), polish: write("a.txt", "A") };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");

    verdicts = [{ summary: "capitalize", stage: "fix", verify: "", tasks: [task("polish", dev.id, ["a"])] }];
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
    plan = { summary: "without c", stage: "build", verify: "", tasks: [task("b2", qa.id, ["a"])] };
    s.revise(run.id, "drop c");
    await waitForRun(run.id, ["awaiting_approval"]);
    expect(directorPrompts.at(-1)).toContain("## Recovering from failed work");
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(byKey(run.id).c!.status).toBe("superseded");
  });
});
