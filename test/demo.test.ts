import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEMO_LIMITS, DEMO_PROMPT, describeDemoResult } from "../src/shared/demo.ts";
import { DIRECTOR_ROLE, type Run } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { headCommit } from "../src/server/git.ts";
import { startServer } from "../src/server/http.ts";
import { createScheduler } from "../src/server/scheduler.ts";

test("UI demo route validates before creating a project, runs handoffs, and persists normal history", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-demo-test-")));
  const path = join(root, "orchestra.db");
  const db = openDb(path);
  let installed = true;
  let calls = 0;
  const director = db.createAgent({ name: "Boss", role: DIRECTOR_ROLE, runtime: "codex", model: null, skills: "", instructions: null });
  const worker = db.createAgent({ name: "Builder", role: "Engineer", runtime: "codex", model: "custom-model", skills: "", instructions: null });
  const demoRoot = join(root, "demos");
  const scheduler = createScheduler({ db, worktreeRoot: join(root, "worktrees"), publish: () => {}, runAgent: async (inv) => {
    calls++;
    if (inv.mode === "readonly") return { ok: true, text: "", structured: calls === 1 ? {
      summary: "Build the demo", stage: "build", verify: "bun test", tasks: [
        { id: "utility", title: "Implement add", description: "Implement add", agentId: worker.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "add works" },
        { id: "tests", title: "Test add", description: "Test the implementation", agentId: qa.id, reviewerId: "", dependsOn: ["utility"], acceptanceCriteria: "tests pass" },
      ],
    } : { summary: "Verified; no further improvements needed", stage: "fix", verify: "bun test", tasks: [] } };
    if (inv.agent.id === worker.id) {
      expect(inv.agent.model).toBe("custom-model");
      await Bun.write(join(inv.cwd, "index.ts"), "export const add = (a: number, b: number) => a + b;\n");
      await Bun.write(join(inv.cwd, "basic.test.ts"), 'import {test,expect} from "bun:test"; import {add} from "./index"; test("add",()=>expect(add(1,2)).toBe(3));\n');
      return { ok: true, text: "Implemented add with a passing basic test." };
    }
    expect(inv.prompt).toContain("Implemented add with a passing basic test.");
    await Bun.write(join(inv.cwd, "README.md"), "Use add(a, b) to add two numbers.\n");
    return { ok: true, text: "Checked the handoff and documented usage." };
  } });
  const server = startServer({ db, scheduler, runAgent: async () => ({ ok: false, text: "" }), port: 0, demoRoot, detectRuntimes: async () => [{ runtime: "codex", installed, version: "fixture" }] });
  const url = `http://127.0.0.1:${server.port}`;
  const post = (body: unknown, origin?: string) => fetch(`${url}/api/demo`, { method: "POST", headers: { "content-type": "application/json", ...(origin ? { origin } : {}) }, body: JSON.stringify(body) });
  let qa = worker;
  try {
    expect((await post({ workdir: "/tmp/untrusted-demo" })).status).toBe(400);
    expect((await post({}, "https://evil.example")).status).toBe(403);
    expect((await post({})).status).toBe(409);
    expect(existsSync(demoRoot)).toBe(false);
    qa = db.createAgent({ name: "Tester", role: "QA", runtime: "codex", model: null, skills: "", instructions: null });
    installed = false;
    expect((await post({})).status).toBe(409);
    expect(existsSync(demoRoot)).toBe(false);
    expect(calls).toBe(0);
    installed = true;
    const response = await post({});
    expect(response.status).toBe(200);
    const started = await response.json() as Run;
    expect(started).toMatchObject({ prompt: DEMO_PROMPT, limits: DEMO_LIMITS, autonomous: true, continuous: true, directorAgentId: director.id });
    expect(started.workdir.startsWith(`${demoRoot}/autonomy-demo-`)).toBe(true);
    for (let i = 0; i < 400 && !["completed", "failed", "paused"].includes(db.getRun(started.id)!.status); i++) await Bun.sleep(25);
    await scheduler.waitForCleanup();
    expect(db.getRun(started.id)!.status).toBe("completed");
    expect(await headCommit(started.workdir)).toBe(started.baseCommit);
    const history = await (await fetch(`${url}/api/runs`)).json() as Run[];
    expect(history.map((run) => run.id)).toContain(started.id);
    expect(db.listTasks(started.id).map((task) => task.status)).toEqual(["done", "done"]);
    expect(db.listTasks(started.id)[0]!.handoff?.text).toContain("Implemented add");
    expect(db.listAgents()).toHaveLength(3);
    const reopened = openDb(path);
    try { expect(reopened.getRun(started.id)?.status).toBe("completed"); } finally { reopened.close(); }
  } finally {
    for (const run of db.listRuns()) if (!["completed", "cancelled"].includes(run.status)) scheduler.cancel(run.id);
    await scheduler.waitForCleanup();
    server.stop(true);
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
}, 20_000);


test("CLI demo reports a budget pause honestly and still rejects failures or missing handoffs", () => {
  const run = { status: "paused" as Run["status"], error: null as string | null, pauseReason: "Time budget reached", agentCalls: 4, limits: { ...DEMO_LIMITS } };
  const tasks = [
    { key: "implementation", status: "done" as const, dependsOn: [], handoff: { text: "Implemented add", files: [], check: null, review: null }, mergeCommit: "saved-merge" },
    { key: "qa", status: "pending" as const, dependsOn: ["implementation"], handoff: null, mergeCommit: null },
  ];
  const paused = describeDemoResult(run, tasks);
  expect(paused).toContain("PAUSED: Time budget reached");
  expect(paused).toContain("1 merged tasks, 4 calls");
  expect(paused).toContain("handoff has not completed yet");
  expect(paused).toContain("resume in the UI");
  expect(paused).not.toContain("PASS:");
  expect(describeDemoResult({ ...run, pauseReason: "Agent-call budget reached", agentCalls: 12 }, tasks)).toContain("PAUSED: Agent-call budget reached");
  expect(() => describeDemoResult({ ...run, status: "completed" }, tasks)).toThrow("without a completed agent-to-agent handoff");
  expect(() => describeDemoResult({ ...run, status: "failed", error: "Worker failed" }, tasks)).toThrow("Worker failed");
  expect(() => describeDemoResult({ ...run, agentCalls: 13 }, tasks)).toThrow("Agent-call budget exceeded");
  const completed = [tasks[0]!, { ...tasks[1]!, status: "done" as const }];
  expect(describeDemoResult({ ...run, status: "completed" }, completed)).toContain("PASS: automatic handoff");
  expect(describeDemoResult(run, completed)).toContain("handoff completed; the run is unfinished");
});
