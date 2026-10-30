import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { commitAll, headCommit, prepareWorkspace } from "../src/server/git.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import type { Plan, RunMilestone, RunStatus, ServerEvent } from "../src/shared/types.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-milestones-")));
const fixtures: { db: ReturnType<typeof openDb>; scheduler: ReturnType<typeof createScheduler> }[] = [];
afterAll(async () => {
  for (const fixture of fixtures) {
    await fixture.scheduler.waitForCleanup();
    await fixture.scheduler.shutdownPreviews();
    fixture.db.close();
  }
  rmSync(root, { recursive: true, force: true });
});

function setup(continuous = false) {
  const home = join(root, `fixture-${fixtures.length}`);
  const path = join(home, "history.db");
  const db = openDb(path);
  let clock = 1_000;
  const make = (name: string, role: string) => db.createAgent({ name, role, runtime: "claude-code", model: "fixture", effort: null, expertise: "", skills: [], instructions: null });
  const director = make("Director", "Director (product & engineering)");
  const worker = make("Worker", "Engineer");
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [worker.id] });
  const item = (id: string) => ({ id, title: id, description: "Write the fixture", acceptanceCriteria: "The file exists", agentId: worker.id, reviewerId: "", dependsOn: [] });
  const build: Plan = { summary: "Build fixture", stage: "build", verify: "true", lessons: "", tasks: [item("base")] };
  const accepted: Plan = { summary: "Accepted fixture", stage: "fix", verify: "true", lessons: "", tasks: [] };
  const events: ServerEvent[] = [];
  let improvements = 0;
  let firstAcceptedBeforeImprovement: RunMilestone | null = null;
  const worktreeRoot = join(home, "worktrees");
  const scheduler = createScheduler({ db, worktreeRoot, now: () => clock, publish: (_, event) => events.push(event), runAgent: async (inv) => {
    if (inv.mode === "worker") {
      const improving = basename(inv.cwd) === "better";
      clock += improving ? 1_000 : 500;
      await Bun.write(join(inv.cwd, improving ? "better.txt" : "base.txt"), "fixture\n");
      return { ok: true, text: "Written fixture" };
    }
    if (inv.prompt.includes("## Continuous improvement")) {
      firstAcceptedBeforeImprovement ??= db.listRuns()[0]!.firstAccepted;
      clock += 200;
      return { ok: true, text: "", structured: ++improvements === 1 ? { ...build, summary: "Improve fixture", tasks: [item("better")] } : { ...accepted, summary: "No worthwhile improvement remains" } };
    }
    clock += 100;
    return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? accepted : build };
  } });
  const wait = async (id: string, statuses: RunStatus[]) => {
    for (let step = 0; step < 600; step++) {
      const run = db.getRun(id)!;
      if (statuses.includes(run.status)) return run;
      await Bun.sleep(20);
    }
    throw new Error(`Milestone fixture stuck at ${db.getRun(id)?.status}`);
  };
  const workdir = join(home, "project");
  const start = () => scheduler.startRun({ teamId: team.id, prompt: "Build the fixture", workdir, autonomous: continuous, continuous });
  const fixture = { db, path, scheduler, workdir, worktreeRoot, start, wait, events, advance: (ms: number) => { clock += ms; }, now: () => clock, firstAcceptedBeforeImprovement: () => firstAcceptedBeforeImprovement };
  fixtures.push(fixture);
  return fixture;
}

test("first acceptance excludes paused and approval wait time and persists through restart", async () => {
  const fixture = setup();
  const run = await fixture.start();
  await fixture.wait(run.id, ["awaiting_approval"]);
  expect(fixture.db.getRun(run.id)).toMatchObject({ firstRunnable: null, firstAccepted: null, activeElapsedMs: 100 });
  fixture.scheduler.pause(run.id);
  await fixture.wait(run.id, ["paused"]);
  fixture.advance(50_000);
  fixture.scheduler.resume(run.id);
  fixture.advance(10_000);
  fixture.scheduler.approve(run.id);
  const finished = await fixture.wait(run.id, ["completed", "failed", "paused"]);
  expect(finished.status).toBe("completed");
  expect(finished.firstAccepted).toEqual({ at: 61_700, elapsedMs: 700, commit: finished.acceptedCommit });
  expect(finished.firstRunnable).toBeNull();
  await fixture.scheduler.waitForCleanup();
  const reopened = openDb(fixture.path);
  expect(reopened.getRun(run.id)?.firstAccepted).toEqual(finished.firstAccepted);
  reopened.close();
});

test("first accepted goal is recorded before continuous improvements and retains its exact original revision", async () => {
  const fixture = setup(true);
  const run = await fixture.start();
  const finished = await fixture.wait(run.id, ["completed", "failed", "paused"]);
  expect(finished.status).toBe("completed");
  const initialTask = fixture.db.listTasks(run.id).find((task) => task.key === "base")!;
  expect(finished.firstAccepted).toEqual({ at: 1_700, elapsedMs: 700, commit: initialTask.mergeCommit });
  expect(fixture.firstAcceptedBeforeImprovement()).toEqual(finished.firstAccepted);
  expect(finished.firstAccepted!.commit).not.toBe(finished.acceptedCommit);
  expect(finished.activeElapsedMs).toBeGreaterThan(finished.firstAccepted!.elapsedMs);
  expect(finished.firstRunnable).toBeNull();
  await fixture.scheduler.waitForCleanup();
  const reopened = openDb(fixture.path);
  expect(reopened.getRun(run.id)?.firstAccepted).toEqual(finished.firstAccepted);
  reopened.close();
});

test("first runnable preview is measured on actual readiness, excludes pauses and survives later preview replacements", async () => {
  const fixture = setup();
  await prepareWorkspace(fixture.workdir);
  await Bun.write(join(fixture.workdir, "index.html"), "<main>Initial fixture</main>");
  await commitAll(fixture.workdir, "Seed fixture");
  const run = await fixture.start();
  await fixture.wait(run.id, ["awaiting_approval"]);
  fixture.scheduler.pause(run.id);
  await fixture.wait(run.id, ["paused"]);
  fixture.advance(50_000);
  await fixture.scheduler.configurePreview(run.id, { enabled: true, command: "" });
  const ready = async () => {
    for (let step = 0; step < 400; step++) {
      const preview = fixture.scheduler.getPreview(run.id);
      if (preview.status === "ready") return preview;
      if (preview.status === "failed") throw new Error(preview.message);
      await Bun.sleep(20);
    }
    throw new Error("Static preview never became ready");
  };
  const preview = await ready();
  expect(await (await fetch(preview.url!)).text()).toContain("Initial fixture");
  const first = fixture.db.getRun(run.id)!.firstRunnable;
  expect(first).toEqual({ at: 51_100, elapsedMs: 100, commit: run.baseCommit, draft: false });
  expect(fixture.db.getRun(run.id)!.firstAccepted).toBeNull();
  const integration = join(fixture.worktreeRoot, run.id, "integration");
  await Bun.write(join(integration, "index.html"), "<main>Later preview</main>");
  await commitAll(integration, "Update fixture");
  const newerCommit = await headCommit(integration);
  fixture.advance(10_000);
  await fixture.scheduler.configurePreview(run.id, { enabled: true, command: "" });
  expect((await ready()).commit).toBe(newerCommit);
  expect(fixture.db.getRun(run.id)!.firstRunnable).toEqual(first);
  expect(fixture.events.some((event) => event.type === "run" && event.run.firstRunnable?.commit === first!.commit)).toBe(true);
  await fixture.scheduler.shutdownPreviews();
  const reopened = openDb(fixture.path);
  expect(reopened.getRun(run.id)?.firstRunnable).toEqual(first);
  reopened.close();
});
