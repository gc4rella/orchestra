import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { commitAll, prepareWorkspace } from "../src/server/git.ts";
import { checkRequest, publishEvent, startServer } from "../src/server/http.ts";
import type { AgentInvocation, RunAgent } from "../src/server/runtimes.ts";
import { createScheduler } from "../src/server/scheduler.ts";

describe("checkRequest", () => {
  const req = (method: string, headers: Record<string, string>) => new Request("http://127.0.0.1:4321/api/agents", { method, headers });
  const json = { "content-type": "application/json" };

  test("allows the app's own origin on loopback", () => {
    expect(checkRequest(req("GET", { host: "127.0.0.1:4321" }), 4321)).toBeNull();
    expect(checkRequest(req("POST", { host: "localhost:4321", origin: "http://localhost:4321", ...json }), 4321)).toBeNull();
    expect(checkRequest(req("POST", { host: "127.0.0.1:4321", ...json }), 4321)).toBeNull(); // non-browser client
  });
  test("blocks DNS rebinding via a foreign Host", () => {
    expect(checkRequest(req("GET", { host: "evil.example:4321" }), 4321)).toBe("forbidden host");
  });
  test("blocks cross-site requests", () => {
    expect(checkRequest(req("POST", { host: "127.0.0.1:4321", origin: "https://evil.example", ...json }), 4321)).toBe("forbidden origin");
    expect(checkRequest(req("POST", { host: "127.0.0.1:4321", origin: "http://127.0.0.1:9999", ...json }), 4321)).toBe("forbidden origin");
  });
  test("requires JSON for mutations, which forces a CORS preflight cross-site", () => {
    expect(checkRequest(req("POST", { host: "127.0.0.1:4321", "content-type": "text/plain" }), 4321)).toContain("application/json");
  });
});

describe("API", () => {
  const db = openDb(":memory:");
  const scheduler = createScheduler({ db, runAgent: async () => ({ ok: false, text: "" }), worktreeRoot: "/nonexistent", publish: () => {} });
  // Probe calls answer like a signed-in CLI, except for an agent named "Signed out".
  const probes: AgentInvocation[] = [];
  const probe: RunAgent = async (inv) => {
    probes.push(inv);
    return inv.agent.name === "Signed out" ? { ok: false, text: "", error: "Not logged in · Please run /login" } : { ok: true, text: "OK", usage: { costUsd: 0.001, tokens: 12 } };
  };
  const server = startServer({ db, scheduler, runAgent: probe, port: 0 });
  afterAll(async () => {
    // Let client close callbacks drain before stopping Bun 1.2's server.
    await Bun.sleep(25);
    server.stop(true);
  });
  const url = (path: string) => `http://127.0.0.1:${server.port}${path}`;
  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(url(path), { method: "POST", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

  const agent = { name: "Claude", runtime: "claude-code", role: "Engineer", skills: "TS", model: "", instructions: "" };

  test("creates, updates and lists agents", async () => {
    const res = await post("/api/agents", agent);
    expect(res.status).toBe(200);
    const created = await res.json();
    expect(created).toMatchObject({ name: "Claude", model: null, instructions: null });

    const put = await fetch(url(`/api/agents/${created.id}`), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...agent, role: "QA" }),
    });
    expect((await put.json()).role).toBe("QA");
    expect(await (await fetch(url("/api/agents"))).json()).toHaveLength(1);
  });

  test("rejects invalid bodies and flag-like model names", async () => {
    expect((await post("/api/agents", { ...agent, runtime: "gpt" })).status).toBe(400);
    expect((await post("/api/agents", { ...agent, model: "--dangerously-skip-permissions" })).status).toBe(400);
    expect((await post("/api/agents", { ...agent, extra: 1 })).status).toBe(400);
  });

  test("cross-site POST is refused", async () => {
    expect((await post("/api/agents", agent, { origin: "https://evil.example" })).status).toBe(403);
  });

  test("several agents can be hired as Directors; each team names one", async () => {
    const director = { ...agent, name: "Boss", role: DIRECTOR_ROLE };
    const boss = await (await post("/api/agents", director)).json();
    const other = await post("/api/agents", { ...director, name: "Other", role: DIRECTOR_ROLE.toUpperCase() });
    expect(other.status).toBe(200);
    const second = await other.json();
    const dev = await (await post("/api/agents", { ...agent, name: "Dev" })).json();

    // Shape and membership rules.
    expect((await post("/api/teams", { name: "T", directorId: boss.id, memberIds: [] })).status).toBe(400);
    expect((await post("/api/teams", { name: "T", directorId: boss.id, memberIds: [dev.id, dev.id] })).status).toBe(400);
    expect((await post("/api/teams", { name: "T", directorId: "ghost", memberIds: [dev.id] })).status).toBe(400);
    expect((await post("/api/teams", { name: "T", directorId: boss.id, memberIds: ["ghost"] })).status).toBe(400);
    expect((await post("/api/teams", { name: "T", directorId: boss.id, memberIds: [boss.id] })).status).toBe(400);
    expect((await post("/api/teams", { name: "T", directorId: boss.id, memberIds: [dev.id] }, { origin: "https://evil.example" })).status).toBe(403);

    // An agent can be in several teams.
    const a = await (await post("/api/teams", { name: "A", directorId: boss.id, memberIds: [dev.id] })).json();
    const b = await (await post("/api/teams", { name: "B", directorId: second.id, memberIds: [dev.id, boss.id] })).json();
    expect(b).toMatchObject({ name: "B", directorId: second.id, memberIds: [dev.id, boss.id] });
    const put = (path: string, body: unknown) => fetch(url(path), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect(await (await put(`/api/teams/${b.id}`, { name: "B2", directorId: second.id, memberIds: [dev.id] })).json()).toMatchObject({ name: "B2", memberIds: [dev.id] });
    expect((await put("/api/teams/nope", { name: "B2", directorId: second.id, memberIds: [dev.id] })).status).toBe(404);
    expect((await (await fetch(url("/api/teams"))).json()).map((t: { name: string }) => t.name)).toEqual(["A", "B2"]);

    // A Director can't leave while it leads a team.
    const del = (path: string) => fetch(url(path), { method: "DELETE", headers: { "content-type": "application/json" } });
    const refused = await del(`/api/agents/${second.id}`);
    expect(refused.status).toBe(409);
    expect((await refused.json()).error).toContain("directs B2");

    // A team used by a run stays; an unused one can go.
    db.createRun({ id: "t1", prompt: "p", workdir: "/tmp/t1", teamId: a.id, directorAgentId: boss.id, baseCommit: "x", branch: "orchestra/t1", warning: null });
    expect((await del(`/api/teams/${a.id}`)).status).toBe(409);
    expect((await del(`/api/teams/${b.id}`)).status).toBe(200);
    expect((await del(`/api/teams/${b.id}`)).status).toBe(404);
    expect((await del(`/api/agents/${second.id}`)).status).toBe(200);
    db.deleteRun("t1");
    expect((await del(`/api/teams/${a.id}`)).status).toBe(200);
  });

  test("runs need a team; bad workspace is a 400, unknown run a 404", async () => {
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x" })).status).toBe(400);
    const none = await post("/api/runs", { teamId: "ghost", prompt: "x", workdir: "/tmp/x" });
    expect(none.status).toBe(409);
    expect((await none.json()).error).toContain("Pick a team");

    const boss = (await (await fetch(url("/api/agents"))).json()).find((a: { role: string }) => a.role === DIRECTOR_ROLE);
    const dev = await (await post("/api/agents", { ...agent, name: "Worker" })).json();
    const team = db.createTeam({ name: "T", directorId: boss.id, memberIds: [dev.id] });
    const res = await post("/api/runs", { teamId: team.id, prompt: "x", workdir: "relative" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("absolute");
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", directorAgentId: "a" })).status).toBe(400);
    expect((await fetch(url("/api/runs/nope"))).status).toBe(404);
  });

  test("new run, plan, revise and retry bodies are validated", async () => {
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", autonomous: "yes" })).status).toBe(400);
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", checkCommand: "bun test\nrm -rf /" })).status).toBe(400);
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", checkCommand: "x".repeat(501) })).status).toBe(400);
    const put = (body: unknown) =>
      fetch(url("/api/runs/nope/plan"), { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await put({ summary: "s", stage: "build", tasks: [] })).status).toBe(400); // verify missing
    expect((await put({ summary: "s", stage: "build", verify: "", tasks: [] })).status).toBe(404);
    expect((await post("/api/runs/nope/revise", {})).status).toBe(400);
    const comments = Array.from({ length: 51 }, () => ({ file: "a.ts", line: 1, text: "x" }));
    expect((await post("/api/runs/nope/revise", { comments })).status).toBe(400);
    expect((await post("/api/runs/nope/revise", { comments: [{ file: "a.ts", line: 0, text: "x" }] })).status).toBe(400);
    expect((await post("/api/runs/nope/revise", { comments: [{ file: "a.ts", line: 3, text: "x" }] })).status).toBe(404);
    // A plain retry sends no body.
    const retry = await fetch(url("/api/tasks/nope/retry"), { method: "POST", headers: { "content-type": "application/json" } });
    expect(retry.status).toBe(404);
    expect((await post("/api/tasks/nope/retry", { agentId: 5 })).status).toBe(400);
  });

  test("continuous mode and budget bodies are validated before workspace changes", async () => {
    const input = { teamId: db.listTeams()[0]!.id, prompt: "x", workdir: "/tmp/should-not-be-created", autonomous: true, continuous: true };
    for (const limits of [{ maxDurationMs: 0, maxAgentCalls: 10 }, { maxDurationMs: 60_000, maxAgentCalls: 0 }, { maxDurationMs: 60_000, maxAgentCalls: 501 }, { maxDurationMs: 86_400_001, maxAgentCalls: 10 }, { maxDurationMs: 60_000, maxAgentCalls: 1.5 }]) expect((await post("/api/runs", { ...input, limits })).status).toBe(400);
    expect((await post("/api/runs", { ...input, autonomous: false })).status).toBe(409);
    expect((await post("/api/runs/nope/pause", { unexpected: true })).status).toBe(400);
    expect((await post("/api/runs/nope/pause", {})).status).toBe(404);
    expect((await post("/api/runs/nope/resume", { guidance: "x".repeat(10001) })).status).toBe(400);
    expect((await post("/api/runs/nope/resume", { limits: { maxDurationMs: 60_000, maxAgentCalls: 3 } })).status).toBe(404);
    expect((await post("/api/runs/nope/pause", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await post("/api/runs/nope/resume", {}, { origin: "https://evil.example" })).status).toBe(403);
    expect((await fetch(url("/api/runs/nope/activity"))).status).toBe(404);
  });

  test("diffs come only from a run's own branch and tasks", async () => {
    const dir = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-server-")));
    try {
      const { baseCommit } = await prepareWorkspace(dir);
      Bun.spawnSync(["git", "checkout", "-qb", "orchestra/d1"], { cwd: dir });
      writeFileSync(join(dir, "a.txt"), "a\n");
      await commitAll(dir, "a");
      const boss = db.listAgents()[0]!;
      db.createRun({ id: "d1", prompt: "p", workdir: dir, directorAgentId: boss.id, baseCommit, branch: "orchestra/d1", warning: null });
      db.createRun({ id: "d2", prompt: "p", workdir: dir, directorAgentId: boss.id, baseCommit, branch: "orchestra/d1", warning: null });
      const plan = { summary: "s", stage: "build" as const, verify: "", tasks: [{ id: "a", title: "A", description: "d", agentId: boss.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "" }] };
      db.insertTasks("d2", plan);
      const other = db.listTasks("d2")[0]!;

      const files = await (await fetch(url("/api/runs/d1/diff"))).json();
      expect(files).toMatchObject([{ path: "a.txt", status: "added", additions: 1 }]);
      expect((await fetch(url("/api/runs/nope/diff"))).status).toBe(404);
      expect((await fetch(url(`/api/runs/d1/diff?taskId=${other.id}`))).status).toBe(404);
      expect(await (await fetch(url(`/api/runs/d2/diff?taskId=${other.id}`))).json()).toEqual([]); // not merged yet
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("testing an agent makes one read-only probe call and reports sign-in problems", async () => {
    const ok = (await (await post("/api/agents", { ...agent, name: "Probe OK" })).json()) as { id: string };
    const out = (await (await post("/api/agents", { ...agent, name: "Signed out" })).json()) as { id: string };
    const res = await post(`/api/agents/${ok.id}/test`, {});
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, error: null, usage: { tokens: 12 } });
    expect(probes.at(-1)).toMatchObject({ mode: "readonly", agent: { id: ok.id } });
    expect(await (await post(`/api/agents/${out.id}/test`, {})).json()).toMatchObject({ ok: false, error: expect.stringContaining("Not logged in") });
    expect((await post("/api/agents/nope/test", {})).status).toBe(404);
    expect((await post(`/api/agents/${ok.id}/test`, { extra: 1 })).status).toBe(400);
    expect((await post(`/api/agents/${ok.id}/test`, {}, { origin: "https://evil.example" })).status).toBe(403);
    db.deleteAgent(ok.id);
    db.deleteAgent(out.id);
  });

  test("guidance steers an active run and is refused for a paused one", async () => {
    const boss = db.listAgents()[0]!;
    db.createRun({ id: "g1", prompt: "p", workdir: "/tmp/g1", directorAgentId: boss.id, baseCommit: "x", branch: "orchestra/g1", warning: null });
    expect((await post("/api/runs/g1/guidance", { text: "  " })).status).toBe(400);
    expect((await post("/api/runs/g1/guidance", { text: "x".repeat(10_001) })).status).toBe(400);
    expect((await post("/api/runs/nope/guidance", { text: "hi" })).status).toBe(404);
    const res = await post("/api/runs/g1/guidance", { text: "Prefer SQLite." });
    expect(res.status).toBe(200);
    expect((await res.json()).guidance).toBe("Prefer SQLite.");
    expect(db.listActivity("g1").at(-1)?.text).toBe("Guidance from you: Prefer SQLite.");
    db.updateRun("g1", { status: "paused" });
    expect((await post("/api/runs/g1/guidance", { text: "more" })).status).toBe(409);
    const del = (id: string, body: unknown, headers: Record<string, string> = {}) =>
      fetch(url(`/api/runs/${id}`), { method: "DELETE", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });
    expect((await del("nope", {})).status).toBe(404);
    expect((await del("g1", { deleteBranch: "yes" })).status).toBe(400);
    expect((await del("g1", {}, { origin: "https://evil.example" })).status).toBe(403);
    db.updateRun("g1", { status: "running" });
    expect((await del("g1", {})).status).toBe(409);
    db.updateRun("g1", { status: "cancelled" });
    expect(await (await del("g1", {})).json()).toEqual({ remaining: [] });
    expect(db.getRun("g1")).toBeNull();
  });

  test("websocket upgrade from a foreign origin is refused", async () => {
    const res = await fetch(url("/ws"), { headers: { origin: "https://evil.example", upgrade: "websocket", connection: "upgrade" } });
    expect(res.status).toBe(403);
  });

  test("websocket subscribers receive run updates through the publish path", async () => {
    const run = db.getRun("d1")!;
    const ws = new WebSocket(url("/ws").replace("http:", "ws:"));
    const received: unknown[] = [];
    ws.onmessage = (ev) => received.push(JSON.parse(String(ev.data)));
    try {
      await new Promise<void>((resolve, reject) => { ws.onopen = () => resolve(); ws.onerror = () => reject(new Error("WebSocket connection failed")); });
      ws.send(JSON.stringify({ subscribe: `run:${run.id}` }));
      // There is no subscription acknowledgement; retry publishing until the server has handled the message.
      for (let i = 0; i < 50 && !received.length; i++) {
        await Bun.sleep(10);
        publishEvent(server, run.id, { type: "run", run });
      }
      expect(received[0]).toEqual({ type: "run", run });
    } finally {
      const closed = new Promise<void>((resolve) => { ws.onclose = () => resolve(); });
      ws.close();
      await closed;
    }
  });

  test("invalid websocket subscriptions close with a policy violation", async () => {
    const ws = new WebSocket(url("/ws").replace("http:", "ws:"));
    try {
      const closed = new Promise<number>((resolve, reject) => {
        ws.onclose = (ev) => resolve(ev.code);
        ws.onerror = () => reject(new Error("WebSocket connection failed"));
      });
      await new Promise<void>((resolve) => { ws.onopen = () => resolve(); });
      ws.send(JSON.stringify({ subscribe: "other:private" }));
      expect(await closed).toBe(1008);
    } finally { ws.close(); }
  });
});
