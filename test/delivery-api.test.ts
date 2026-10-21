import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_ROLE, MAX_MEMORY, defaultDeliveryPolicy } from "../src/shared/types.ts";
import type { Evidence, Plan, Requirement, Run } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { startServer } from "../src/server/http.ts";
import { createScheduler } from "../src/server/scheduler.ts";

describe("delivery API", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-delivery-api-")));
  const worktreeRoot = join(root, "worktrees");
  const db = openDb(":memory:");
  const hire = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = hire("Director", DIRECTOR_ROLE);
  const worker = hire("Worker", "Engineer");
  const team = db.createTeam({ name: "Delivery", directorId: director.id, memberIds: [worker.id] });
  const requirement: Requirement = { id: "checkout", title: "Checkout works", description: "A customer can place an order.", kind: "command", check: "bun test", required: true, inputs: ["src"], artifacts: [], version: 1, updatedAt: 1 };
  const { version: _version, updatedAt: _updatedAt, ...spec } = requirement;
  const plan: Plan = { version: 2, summary: "Implement checkout", stage: "build", verify: "", lessons: "", requirements: [spec], tasks: [{ id: "checkout", title: "Implement checkout", description: "Deliver checkout", agentId: worker.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "Customer can place an order", contract: { requirementIds: ["checkout"], inputs: ["src"], outputs: ["src/checkout.ts"], resources: ["checkout-interface"] } }] };
  let invocations = 0;
  const runAgent = async () => { invocations++; return { ok: true, text: "", structured: plan }; };
  const scheduler = createScheduler({ db, worktreeRoot, publish: () => {}, runAgent });
  const server = startServer({ db, scheduler, runAgent, port: 0, ensureSkills: async () => [], searchSkills: async () => [] });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const request = (path: string, body: unknown, method = "PUT", headers: Record<string, string> = {}) => fetch(url(path), { method, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const seed = (id: string, workdir = join(root, id)) => db.createRun({ id, workdir, prompt: "Build checkout", teamId: team.id, directorAgentId: director.id, baseCommit: "base", branch: `orchestra/${id}`, warning: null });
  const record = (runId: string, overrides: Partial<Omit<Evidence, "id" | "createdAt">> = {}) => db.recordEvidence({ runId, taskId: null, scope: "acceptance", commit: "base", producer: "Orchestra", command: "bun test", status: "passed", requirementIds: [requirement.id], requirementVersions: { checkout: 1 }, output: "passed", durationMs: 10, artifacts: [], ...overrides });

  afterAll(async () => {
    for (const run of db.listRuns()) if (["planning", "awaiting_approval", "running", "pausing"].includes(run.status)) scheduler.cancel(run.id);
    await scheduler.shutdownPreviews();
    await scheduler.waitForCleanup();
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("project defaults persist independently of memory and reject invalid or cross-origin writes", async () => {
    const workdir = join(root, "defaults");
    const path = `/api/projects/delivery?workdir=${encodeURIComponent(workdir)}`;
    expect(await (await fetch(url(path))).json()).toEqual({ delivery: defaultDeliveryPolicy() });
    const delivery = { profile: "quality", strategy: "team", maxParallel: 4 } as const;
    expect((await request("/api/projects/delivery", { workdir, delivery })).status).toBe(200);
    expect(await (await fetch(url(path))).json()).toEqual({ delivery });
    db.setMemory(workdir, "Keep this project note");
    for (const invalid of [{ ...delivery, profile: "cheap" }, { ...delivery, maxParallel: 0 }, { ...delivery, maxParallel: 7 }, { ...delivery, maxParallel: 1.5 }, { ...delivery, extra: true }]) {
      expect((await request("/api/projects/delivery", { workdir, delivery: invalid })).status).toBe(400);
    }
    expect((await request("/api/projects/delivery", { workdir, delivery }, "PUT", { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await fetch(url("/api/projects/delivery"))).status).toBe(400);
    expect(db.getDeliveryPolicy(workdir)).toEqual(delivery);
    expect(db.getMemory(workdir)).toBe("Keep this project note");
  });

  test("unsupported native delegation is rejected before creating files or calling an agent", async () => {
    const workdir = join(root, "native-must-not-exist");
    const before = invocations;
    const delivery = { ...defaultDeliveryPolicy(), strategy: "native" };
    expect((await request("/api/projects/delivery", { workdir, delivery })).status).toBe(409);
    const res = await request("/api/runs", { teamId: team.id, prompt: "Build checkout", workdir, delivery }, "POST");
    expect(res.status).toBe(409);
    expect((await res.json()).error).toContain("budget");
    expect(existsSync(workdir)).toBe(false);
    expect(invocations).toBe(before);
    expect(db.listRuns().some((run) => run.workdir === workdir)).toBe(false);
    db.setDeliveryPolicy(workdir, { ...defaultDeliveryPolicy(), strategy: "native" });
    expect((await request("/api/runs", { teamId: team.id, prompt: "Build checkout", workdir }, "POST")).status).toBe(409);
    expect(existsSync(workdir)).toBe(false);
  });

  test("new runs inherit project policy and let an explicit per-run preference override it", async () => {
    const workdir = join(root, "inherit-policy");
    const delivery = { ...defaultDeliveryPolicy("economy"), maxParallel: 2 };
    db.setDeliveryPolicy(workdir, delivery);
    const created = await request("/api/runs", { teamId: team.id, prompt: "Build checkout", workdir }, "POST");
    expect(created.status).toBe(200);
    const first = await created.json() as Run;
    expect(first.delivery).toEqual(delivery);
    for (let i = 0; i < 100 && db.getRun(first.id)?.status === "planning"; i++) await Bun.sleep(10);
    expect(db.getRun(first.id)?.status).toBe("awaiting_approval");
    const override = defaultDeliveryPolicy("speed");
    const second = await request("/api/runs", { teamId: team.id, prompt: "Build checkout", workdir, delivery: override }, "POST");
    const secondRun = await second.json() as Run;
    expect(secondRun.delivery).toEqual(override);
    for (let i = 0; i < 100 && db.getRun(secondRun.id)?.status === "planning"; i++) await Bun.sleep(10);
    expect(db.getRun(secondRun.id)?.status).toBe("awaiting_approval");
    expect(db.getDeliveryPolicy(workdir)).toEqual(delivery);
  });

  test("evidence and invocation endpoints are read-only, isolated by run and origin protected", async () => {
    seed("evidence-one");
    seed("evidence-two");
    const first = record("evidence-one");
    const second = record("evidence-two", { output: "other run" });
    const event = { id: "event", runId: "evidence-one", taskId: null, invocationId: "invocation", parentId: null, agentId: worker.id, kind: "started" as const, text: "Working", ts: 1 };
    db.recordAgentEvent(event);
    expect(await (await fetch(url("/api/runs/evidence-one/evidence"))).json()).toEqual([first]);
    expect(await (await fetch(url("/api/runs/evidence-two/evidence"))).json()).toEqual([second]);
    expect(await (await fetch(url("/api/runs/evidence-one/events"))).json()).toEqual([event]);
    expect([404, 405]).toContain((await request("/api/runs/evidence-one/evidence", { ...first, status: "failed" })).status);
    expect(db.listEvidence("evidence-one")).toEqual([first]);
    expect((await fetch(url("/api/runs/missing/evidence"))).status).toBe(404);
    expect((await fetch(url("/api/runs/missing/events"))).status).toBe(404);
    expect((await fetch(url("/api/runs/evidence-one/evidence"), { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
  });

  test("explicit plan amendments round-trip requirement versions and task contracts without deleting prior evidence", async () => {
    const run = seed("amend");
    db.updateRun(run.id, { status: "awaiting_approval", plan, requirements: [requirement] });
    const proof = record(run.id);
    const amended: Plan = { ...plan, requirements: [{ ...spec, check: "bun run test:checkout", description: "The complete checkout journey passes." }] };
    const saved = await request(`/api/runs/${run.id}/plan`, amended);
    expect(saved.status).toBe(200);
    const fetched = await (await fetch(url(`/api/runs/${run.id}`))).json();
    expect(fetched.run.requirements).toMatchObject([{ id: "checkout", version: 2, check: "bun run test:checkout" }]);
    expect(fetched.run.plan.tasks[0].contract).toEqual(plan.tasks[0]!.contract);
    expect(db.listEvidence(run.id)).toEqual([proof]);
    expect((await request(`/api/runs/${run.id}/plan`, amended, "PUT", { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await request(`/api/runs/${run.id}/plan`, { ...amended, requirements: [{ ...spec, check: "bun test\nfalse" }] })).status).toBe(409);
  });

  test("rejected acceptance cannot create a verified history report", async () => {
    const run = seed("reject-acceptance");
    db.insertTasks(run.id, plan);
    const task = db.listTasks(run.id)[0]!;
    db.updateTask(task.id, { status: "done", phase: "done", mergeCommit: "base" });
    const newRequirement = { ...spec, id: "new-outcome", title: "Another required outcome" };
    db.updateRun(run.id, { status: "awaiting_approval", requirements: [requirement], plan: { version: 2, summary: "Premature acceptance", stage: "fix", verify: "", lessons: "", requirements: [newRequirement], tasks: [] } });
    record(run.id);
    const response = await request(`/api/runs/${run.id}/approve`, {}, "POST");
    expect(response.status).toBe(409);
    expect((await response.json()).error).toContain("unmet requirements");
    expect(db.getRun(run.id)!.history.some((entry) => entry.report === "Premature acceptance")).toBe(false);
  });

  test("lessons remain proposals until the user accepts them and retirement preserves editable memory", async () => {
    const run = seed("lessons");
    const proof = record(run.id);
    db.proposeLessons(run.id, "base", "- Check checkout after payment changes");
    const [lesson] = db.listLessons(run.workdir);
    expect(lesson).toMatchObject({ runId: run.id, commit: "base", evidenceIds: [proof.id], status: "proposed" });
    expect(db.getMemory(run.workdir)).toBe("");
    const body = { workdir: run.workdir, id: lesson!.id, status: "accepted" };
    expect((await request("/api/projects/lessons", body, "PUT", { Origin: "https://foreign.example" })).status).toBe(403);
    expect((await request("/api/projects/lessons", { ...body, workdir: join(root, "other") })).status).toBe(404);
    expect(db.getMemory(run.workdir)).toBe("");
    expect((await request("/api/projects/lessons", body)).status).toBe(200);
    expect((await request("/api/projects/lessons", body)).status).toBe(200);
    expect(db.getMemory(run.workdir)).toBe(lesson!.text);
    expect(db.listLessons(run.workdir)[0]!.status).toBe("accepted");
    expect((await request("/api/projects/lessons", { ...body, status: "retired" })).status).toBe(200);
    expect(db.listLessons(run.workdir)[0]!.status).toBe("retired");
    expect(db.getMemory(run.workdir)).toBe(lesson!.text);
  });

  test("a full memory rejects lesson acceptance without changing its status or existing notes", async () => {
    const run = seed("full-memory");
    db.proposeLessons(run.id, "base", "Remember this important lesson");
    const [lesson] = db.listLessons(run.workdir);
    const memory = "x".repeat(MAX_MEMORY);
    db.setMemory(run.workdir, memory);
    expect((await request("/api/projects/lessons", { workdir: run.workdir, id: lesson!.id, status: "accepted" })).status).toBe(409);
    expect(db.getMemory(run.workdir)).toBe(memory);
    expect(db.listLessons(run.workdir)[0]!.status).toBe("proposed");
  });

  test("the existing lesson picker records user-selected lesson provenance when saving memory", async () => {
    const run = seed("picker-lesson");
    db.proposeLessons(run.id, "base", "Keep checkout covered");
    expect((await request("/api/projects/memory", { workdir: run.workdir, memory: "Notes\n- Keep checkout covered" })).status).toBe(200);
    expect(db.listLessons(run.workdir)[0]!.status).toBe("accepted");
    const before = db.getMemory(run.workdir);
    const lesson = db.listLessons(run.workdir)[0]!;
    expect((await request("/api/projects/lessons", { workdir: run.workdir, id: lesson.id, status: "accepted" })).status).toBe(200);
    expect(db.getMemory(run.workdir)).toBe(before);
  });

  test("artifact downloads serve only recorded files inside that run and force safe attachment headers", async () => {
    const run = seed("artifacts");
    const base = join(worktreeRoot, run.id, ".artifacts");
    mkdirSync(join(base, "receipt"), { recursive: true });
    writeFileSync(join(base, "receipt", "checkout.html"), "<script>untrusted report</script>");
    writeFileSync(join(base, "unrecorded.txt"), "private");
    writeFileSync(join(worktreeRoot, run.id, "outside.txt"), "outside evidence");
    symlinkSync(join(worktreeRoot, run.id, "outside.txt"), join(base, "link.txt"));
    const proof = record(run.id, { artifacts: ["receipt/checkout.html", "../outside.txt", "link.txt", "missing.txt"] });
    const path = (id: string, index: string) => `/api/runs/${run.id}/artifacts?evidence=${encodeURIComponent(id)}&index=${index}`;
    const response = await fetch(url(path(proof.id, "0")));
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/octet-stream");
    expect(response.headers.get("content-disposition")).toBe("attachment");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    expect(await response.text()).toBe("<script>untrusted report</script>");
    for (const index of ["1", "2", "3", "4"]) expect((await fetch(url(path(proof.id, index)))).status).toBe(404);
    for (const index of ["-1", "0.5", "NaN"]) expect((await fetch(url(path(proof.id, index)))).status).toBe(400);
    expect((await fetch(url(path("unrecorded.txt", "0")))).status).toBe(404);
    expect((await fetch(url(path(proof.id, "0")), { headers: { Origin: "https://foreign.example" } })).status).toBe(403);
    expect([404, 405]).toContain((await request(path(proof.id, "0"), {})).status);
  });
});
