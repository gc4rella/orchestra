import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { commitAll, prepareWorkspace } from "../src/server/git.ts";
import { checkRequest, publishEvent, startServer } from "../src/server/http.ts";
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
  const server = startServer({ db, scheduler, port: 0 });
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

  test("a team has a single Director", async () => {
    const director = { ...agent, name: "Boss", role: DIRECTOR_ROLE };
    const created = await (await post("/api/agents", director)).json();
    const second = await post("/api/agents", { ...director, name: "Other", role: DIRECTOR_ROLE.toUpperCase() });
    expect(second.status).toBe(409);
    expect((await second.json()).error).toContain("Boss is already the team's Director");
    // saving the Director itself is fine
    const put = await fetch(url(`/api/agents/${created.id}`), {
      method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...director, skills: "more" }),
    });
    expect(put.status).toBe(200);
  });

  test("runs need a Director; bad workspace is a 400, unknown run a 404", async () => {
    const boss = (await (await fetch(url("/api/agents"))).json()).find((a: { role: string }) => a.role === DIRECTOR_ROLE);
    db.deleteAgent(boss.id);
    const none = await post("/api/runs", { prompt: "x", workdir: "/tmp/x" });
    expect(none.status).toBe(409);
    expect((await none.json()).error).toContain("Hire a Director");

    await post("/api/agents", { ...agent, name: "Boss", role: DIRECTOR_ROLE });
    const res = await post("/api/runs", { prompt: "x", workdir: "relative" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toContain("absolute");
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", directorAgentId: "a" })).status).toBe(400);
    expect((await fetch(url("/api/runs/nope"))).status).toBe(404);
  });

  test("new run, plan, revise and retry bodies are validated", async () => {
    expect((await post("/api/runs", { prompt: "x", workdir: "/tmp/x", autonomous: "yes" })).status).toBe(400);
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
