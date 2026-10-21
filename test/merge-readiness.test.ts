import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import type { MergeCheck, Plan, RunStatus } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { addWorktree, commitAll, headCommit, prepareWorkspace, removeWorktree } from "../src/server/git.ts";
import { startServer } from "../src/server/http.ts";
import { createScheduler } from "../src/server/scheduler.ts";

describe("merge readiness", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-merge-readiness-")));
  const db = openDb(":memory:");
  const hire = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = hire("Director", DIRECTOR_ROLE);
  const worker = hire("Worker", "Engineer");
  const team = db.createTeam({ name: "Preview", directorId: director.id, memberIds: [worker.id] });
  let invocations = 0;
  const runAgent = async () => { invocations++; throw new Error("Merge readiness must never invoke an agent"); };
  const scheduler = createScheduler({ db, worktreeRoot: join(root, "worktrees"), publish: () => {}, runAgent });
  const server = startServer({ db, scheduler, runAgent, port: 0, ensureSkills: async () => [], searchSkills: async () => [] });
  const url = (id: string) => `http://127.0.0.1:${server.port}/api/runs/${id}/merge-check`;
  const request = (id: string, body: unknown = {}, headers: Record<string, string> = {}) => fetch(url(id), { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  let sequence = 0;

  afterAll(async () => {
    expect(invocations).toBe(0);
    await scheduler.shutdownPreviews();
    await scheduler.waitForCleanup();
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  const git = (cwd: string, ...args: string[]) => {
    const result = Bun.spawnSync(["git", ...args], { cwd, stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };

  const fixture = async (conflicts = false) => {
    const id = `merge-${++sequence}`;
    const repo = join(root, id);
    await prepareWorkspace(repo);
    writeFileSync(join(repo, "shared.txt"), "base\n");
    writeFileSync(join(repo, "dirty.txt"), "base\n");
    await commitAll(repo, "base");
    const baseCommit = await headCommit(repo);
    const branch = `orchestra/${id}`;
    const worktree = join(root, `${id}-worktree`);
    await addWorktree(repo, worktree, branch, baseCommit);
    writeFileSync(join(worktree, "shared.txt"), "accepted work\n");
    await commitAll(worktree, "accepted build");
    const sourceCommit = await headCommit(worktree);
    await removeWorktree(repo, worktree);
    if (conflicts) {
      writeFileSync(join(repo, "shared.txt"), "project changed\n");
      await commitAll(repo, "project changes");
    }
    const targetCommit = await headCommit(repo);
    git(repo, "branch", "release", baseCommit);
    writeFileSync(join(repo, "dirty.txt"), "staged changes\n");
    git(repo, "add", "dirty.txt");
    writeFileSync(join(repo, "dirty.txt"), "unstaged changes\n");
    writeFileSync(join(repo, "untracked.txt"), "untracked user work\n");
    db.createRun({ id, workdir: repo, prompt: "Build it", teamId: team.id, directorAgentId: director.id, baseCommit, branch, warning: null, limits: { maxDurationMs: 600_000, maxAgentCalls: 20 } });
    const plan: Plan = { summary: "Accepted work", stage: "build", verify: "bun test", lessons: "", tasks: [{ id: "build", title: "Build", description: "Deliver the brief", agentId: worker.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "The checks pass" }] };
    db.insertTasks(id, plan);
    db.updateTask(db.listTasks(id)[0]!.id, { status: "done", phase: "done", iterations: 2, mergeCommit: sourceCommit, summary: "Delivered" });
    db.updateRun(id, { status: "completed", acceptedCommit: sourceCommit, agentCalls: 7, activeElapsedMs: 123_000, checkpoint: "execute", cycle: 3, recoveries: 1, fixRounds: 1, plan, history: [{ cycle: 1, createdAt: 1, plan, report: "Checks passed" }], check: { command: "bun test", ok: true, output: "pass", commit: sourceCommit }, report: "Accepted" });
    db.recordEvidence({ runId: id, taskId: null, scope: "acceptance", commit: sourceCommit, producer: "orchestra:combined", command: "bun test", status: "passed", requirementIds: [], requirementVersions: {}, output: "pass", durationMs: 10, artifacts: [] });
    return { id, repo, branch, baseCommit, sourceCommit, targetCommit };
  };

  const snapshot = ({ id, repo }: { id: string; repo: string }) => ({
    run: db.getRun(id), tasks: db.listTasks(id), evidence: db.listEvidence(id), events: db.listAgentEvents(id), logs: db.listLogs(id, null),
    head: git(repo, "rev-parse", "HEAD"), refs: git(repo, "show-ref"), index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    dirty: readFileSync(join(repo, "dirty.txt"), "utf8"), untracked: readFileSync(join(repo, "untracked.txt"), "utf8"), shared: readFileSync(join(repo, "shared.txt"), "utf8"),
  });

  test("checks the current project branch or an explicit local target without changing work or run state", async () => {
    const run = await fixture();
    const before = snapshot(run);
    const defaultResponse = await request(run.id);
    expect(defaultResponse.status).toBe(200);
    expect(await defaultResponse.json()).toEqual({ sourceCommit: run.sourceCommit, targetBranch: "main", targetCommit: run.targetCommit, status: "clean", conflicts: [], message: null });
    const explicitResponse = await request(run.id, { target: "release" });
    expect(explicitResponse.status).toBe(200);
    expect(await explicitResponse.json()).toMatchObject({ sourceCommit: run.sourceCommit, targetBranch: "release", targetCommit: run.baseCommit, status: "clean" });
    expect(snapshot(run)).toEqual(before);
    expect(invocations).toBe(0);
  });

  test("reports conflicts while preserving acceptance evidence, budgets, checkpoints and the dirty checkout", async () => {
    const run = await fixture(true);
    const before = snapshot(run);
    const response = await request(run.id);
    expect(response.status).toBe(200);
    const result: MergeCheck = await response.json();
    expect(result).toMatchObject({ sourceCommit: run.sourceCommit, targetCommit: run.targetCommit, status: "conflicted", conflicts: ["shared.txt"] });
    expect(snapshot(run)).toEqual(before);
  });

  test("requires the request guard and a strict JSON body", async () => {
    const run = await fixture();
    const before = snapshot(run);
    expect((await request(run.id, {}, { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await request(run.id, {}, { Host: "foreign.example" })).status).toBe(403);
    expect((await request(run.id, {}, { "Content-Type": "text/plain" })).status).toBe(403);
    for (const body of [{ unexpected: true }, { target: "" }, { target: null }, { target: 1 }, { target: "x".repeat(201) }, []]) {
      expect((await request(run.id, body)).status).toBe(400);
    }
    expect((await fetch(url(run.id), { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" })).status).toBe(400);
    expect(snapshot(run)).toEqual(before);
  });

  test("refuses missing runs, unfinished runs and builds with no accepted revision", async () => {
    expect((await request("missing-run")).status).toBe(404);
    const run = await fixture();
    for (const status of ["planning", "awaiting_approval", "running", "pausing", "paused", "failed", "cancelled"] satisfies RunStatus[]) {
      db.updateRun(run.id, { status });
      expect((await request(run.id)).status).toBe(409);
    }
    db.updateRun(run.id, { status: "completed", acceptedCommit: null });
    expect((await request(run.id)).status).toBe(409);
    expect(invocations).toBe(0);
  });

  test("rejects branch expressions, missing targets and the source branch itself", async () => {
    const run = await fixture();
    const before = snapshot(run);
    for (const target of ["absent", "HEAD", "main~1", "main^", "@{-1}", "--all", "refs/heads/main"]) {
      expect((await request(run.id, { target })).status).toBe(400);
    }
    expect((await request(run.id, { target: run.branch })).status).toBe(409);
    expect(snapshot(run)).toEqual(before);
  });

  test("refuses a source branch moved after acceptance or deleted locally", async () => {
    const run = await fixture();
    git(run.repo, "update-ref", `refs/heads/${run.branch}`, run.baseCommit);
    const before = snapshot(run);
    const response = await request(run.id);
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("changed after acceptance");
    expect(snapshot(run)).toEqual(before);
    git(run.repo, "branch", "-D", run.branch);
    expect((await request(run.id)).status).toBe(400);
  });

  test("detached HEAD needs an explicit target and stays detached throughout", async () => {
    const run = await fixture();
    git(run.repo, "checkout", "--detach", "-q", "HEAD");
    const before = snapshot(run);
    const response = await request(run.id);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ sourceCommit: run.sourceCommit, targetBranch: null, targetCommit: null, status: "unsupported", message: expect.stringContaining("local target branch") });
    expect((await request(run.id, { target: "release" })).status).toBe(200);
    expect(snapshot(run)).toEqual(before);
    expect(Bun.spawnSync(["git", "symbolic-ref", "--quiet", "HEAD"], { cwd: run.repo }).exitCode).toBe(1);
  });

  for (const drift of ["status", "source", "target"] as const) {
    test(`rejects ${drift} changes between starting a preview and returning its result`, async () => {
      const run = await fixture();
      const getRun = db.getRun;
      let reads = 0;
      db.getRun = (id) => {
        if (id === run.id && ++reads === 2) {
          if (drift === "status") db.updateRun(id, { status: "paused" });
          else git(run.repo, "update-ref", `refs/heads/${drift === "source" ? run.branch : "main"}`, drift === "source" ? run.baseCommit : run.sourceCommit);
        }
        return getRun(id);
      };
      try { await expect(scheduler.checkMerge(run.id)).rejects.toThrow("changed while checking"); }
      finally { db.getRun = getRun; }
    });
  }
});
