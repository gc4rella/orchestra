import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, Plan, RunStatus, ServerEvent } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb, type Db } from "../src/server/db.ts";
import type { AgentInvocation, AgentResult, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-sched-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

let db: Db;
let boss: Agent;
let dev: Agent;
let qa: Agent;
let events: ServerEvent[];
let n = 0;

/** Worker behaviour per task title; the director returns `plan`. */
let plan: Plan;
let workers: Record<string, (inv: AgentInvocation) => Promise<AgentResult>>;
let directorPrompts: string[];

const fakeRunAgent: RunAgent = async (inv) => {
  if (inv.mode === "director") {
    directorPrompts.push(inv.prompt);
    return { ok: true, text: "", structured: plan };
  }
  if (inv.prompt.startsWith("You are resolving a git merge conflict")) return workers.resolve!(inv);
  const title = inv.prompt.match(/^## Your task: (.+)$/m)![1]!;
  return workers[title]!(inv);
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
  for (let i = 0; i < 400; i++) {
    const run = db.getRun(id)!;
    if (statuses.includes(run.status)) return run;
    await Bun.sleep(25);
  }
  throw new Error(`run stuck in ${db.getRun(id)!.status}`);
}

function setup() {
  const s = createScheduler({ db, runAgent: fakeRunAgent, worktreeRoot: join(root, `wt${n}`), publish: (_, ev) => events.push(ev) });
  const workdir = join(root, `project${n++}`);
  const start = async () => {
    const run = await s.startRun({ prompt: "Build it", workdir });
    await waitForRun(run.id, ["awaiting_approval"]);
    return run;
  };
  return { s, workdir, start };
}

const task = (id: string, agentId: string, dependsOn: string[] = []) => ({
  id, title: `Task ${id}`, description: `Do ${id}`, agentId, dependsOn, acceptanceCriteria: "",
});

beforeEach(() => {
  db = openDb(":memory:");
  boss = db.createAgent({ name: "Boss", runtime: "claude-code", model: null, role: DIRECTOR_ROLE, skills: "", instructions: null });
  dev = db.createAgent({ name: "Dev", runtime: "claude-code", model: null, role: "Engineer", skills: "", instructions: null });
  qa = db.createAgent({ name: "QA", runtime: "codex", model: null, role: "QA", skills: "", instructions: null });
  events = [];
  directorPrompts = [];
  plan = { summary: "two in parallel, then integrate", stage: "build", tasks: [task("a", dev.id), task("b", qa.id), task("c", dev.id, ["a", "b"])] };
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
      "Task a": slow("a.txt"),
      "Task b": slow("b.txt"),
      "Task c": async (inv) => {
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
      "Task a": write("a.txt", "a"),
      "Task b": async (inv) => (failB ? { ok: false, text: "", error: "boom" } : write("b.txt", "b")(inv)),
      "Task c": write("c.txt", "c"),
    };
    const { s, start } = setup();
    const run = await start();
    s.approve(run.id);
    const failed = await waitForRun(run.id, ["completed", "failed"]);
    expect(failed.status).toBe("failed");
    const byKey = Object.fromEntries(db.listTasks(run.id).map((t) => [t.key, t]));
    expect(byKey.a!.status).toBe("done");
    expect(byKey.b!.status).toBe("failed");
    expect(byKey.b!.error).toBe("boom");
    expect(byKey.c!.status).toBe("blocked");

    failB = false;
    s.retry(byKey.b!.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
  });

  test("merge conflicts go to the agent; its resolution is merged", async () => {
    plan = { summary: "conflict", stage: "build", tasks: [task("a", dev.id), task("b", qa.id)] };
    workers = {
      "Task a": write("shared.txt", "from a\n"),
      "Task b": write("shared.txt", "from b\n"),
      resolve: write("shared.txt", "from a and b\n"),
    };
    const { s, workdir, start } = setup();
    const run = await start();
    s.approve(run.id);
    expect((await waitForRun(run.id, ["completed", "failed"])).status).toBe("completed");
    expect(show(workdir, `${run.branch}:shared.txt`)).toBe("from a and b\n");
  });

  test("an unresolved conflict fails the task and leaves the run branch clean", async () => {
    plan = { summary: "conflict", stage: "build", tasks: [task("a", dev.id), task("b", qa.id)] };
    workers = {
      "Task a": write("shared.txt", "from a\n"),
      "Task b": write("shared.txt", "from b\n"),
      resolve: async () => ({ ok: true, text: "gave up" }),
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
      "Task a": (inv) => new Promise((resolve) => inv.signal!.addEventListener("abort", () => resolve({ ok: false, text: "", error: "cancelled" }))),
      "Task b": (inv) => new Promise((resolve) => inv.signal!.addEventListener("abort", () => resolve({ ok: false, text: "", error: "cancelled" }))),
      "Task c": write("c.txt", "c"),
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

  test("invalid director output fails the run; revise re-plans", async () => {
    const good = plan;
    plan = { summary: "bad", stage: "build", tasks: [task("a", "ghost")] };
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
    plan = { summary: "self", stage: "build", tasks: [task("a", boss.id)] };
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
    plan = { summary: "define first", stage: "definition", tasks: [task("spec", pm.id), task("design", dev.id, ["spec"])] };
    workers = {
      "Task spec": write("docs/product/spec.md", "# Spec\n", "spec written"),
      "Task design": async (inv) => {
        expect(await Bun.file(join(inv.cwd, "docs/product/spec.md")).exists()).toBe(true);
        return write("docs/engineering/design.md", "# Design\n", "design written")(inv);
      },
      "Task api": write("api.ts", "api\n"),
      "Task qa": write("api.test.ts", "test\n"),
    };
    const { s, workdir, start } = setup();
    const run = await start();
    expect(directorPrompts[0]).toContain('set stage to "definition"');

    // The build plan the director returns once definition is done; it may depend on finished tasks.
    plan = { summary: "now build", stage: "build", tasks: [task("api", dev.id, ["design"]), task("qa", qa.id, ["api"])] };
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
    plan = { summary: "define", stage: "definition", tasks: [task("spec", dev.id)] };
    workers = { "Task spec": write("spec.md", "spec") };
    const { s, start } = setup();
    const run = await start();
    plan = { summary: "bad build", stage: "definition", tasks: [task("more", dev.id)] }; // must be "build" now
    s.approve(run.id);
    const failed = await waitForRun(run.id, ["failed", "awaiting_approval"]);
    expect(failed.status).toBe("failed");
    expect(failed.error).toContain('stage must be "build"');

    plan = { summary: "build", stage: "build", tasks: [task("impl", dev.id, ["spec"])] };
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
