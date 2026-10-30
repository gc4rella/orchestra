import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, codexRpc, parseLine, runCodexAppServer, runtimeCapabilities, runtimeEnvironment } from "../src/server/runtimes.ts";
import { ensureSkills, inspectSkillCompatibility, readSkill, skillsPrompt } from "../src/server/skills.ts";
import { handoffJsonSchema, workerHandoff } from "../src/server/handoff.ts";
import type { AgentInvocation, InvocationControl } from "../src/server/runtimes.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-compatibility-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const put = (path: string, text: string) => { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, text); };

describe("skill compatibility", () => {
  test("reports omitted plugin bootstrap, missing resources and Orchestra-owned git operations", () => {
    const repo = join(root, "superpowers");
    const dir = join(repo, "skills", "review");
    put(join(repo, "hooks/hooks.json"), "{}");
    put(join(repo, "agents/reviewer.md"), "review");
    put(join(dir, "SKILL.md"), "---\nname: review\nallowed-tools: Read, Bash\n---\nUse [agent](../../agents/reviewer.md). Run git commit. Read [local](references/local.md).");
    put(join(dir, "references/local.md"), "details");
    const compatibility = inspectSkillCompatibility("obra/superpowers", dir, repo);
    expect(compatibility).toMatchObject({ status: "integration-required", profile: "superpowers", requiredTools: ["Read", "Bash"], missingResources: ["../../agents/reviewer.md"] });
    expect(compatibility.omittedIntegrations).toContain("repository:hooks/hooks.json");
    expect(compatibility.notices.join(" ")).toContain("Orchestra owns commits");
    expect(compatibility.notices.join(" ")).toContain("startup bootstrap is not installed");
  });

  test("ECC learning profile describes hooks that are not activated", () => {
    const repo = join(root, "ecc");
    const dir = join(repo, "skills/learning");
    put(join(dir, "SKILL.md"), "---\nname: learning\n---\nLearn from observations.");
    const compatibility = inspectSkillCompatibility("affaan-m/everything-claude-code", dir, repo);
    expect(compatibility.profile).toBe("ecc");
    expect(compatibility.notices.join(" ")).toContain("continuous-learning capture");
    expect(compatibility.notices.join(" ")).toContain("not activated");
  });

  test("records source commit and bundled files while retaining the installed revision", async () => {
    const repo = join(root, "repo");
    const library = join(root, "library");
    put(join(repo, "skills/example/SKILL.md"), "---\nname: example\ndescription: Original.\n---");
    for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=test", "-c", "user.email=test@example.com", "commit", "-qm", "initial"]]) {
      expect(await Bun.spawn(["git", ...args], { cwd: repo, stdout: "ignore", stderr: "ignore" }).exited).toBe(0);
    }
    const first = (await ensureSkills(["o/r/example"], { root: library, repoUrl: () => repo }))[0]!;
    expect(first.provenance).toMatchObject({ repository: "o/r", revision: first.revision, files: ["SKILL.md"] });
    put(join(repo, "skills/example/SKILL.md"), "---\nname: example\ndescription: Changed upstream.\n---");
    const second = (await ensureSkills(["o/r/example"], { root: library, repoUrl: () => { throw new Error("must not fetch installed skills"); } }))[0]!;
    expect(second.revision ?? null).toBe(first.revision ?? null);
    expect(second.description).toBe("Original.");
  });

  test("old and corrupt manifests remain usable with unknown provenance", () => {
    const library = join(root, "old-library");
    put(join(library, "o/r/old/SKILL.md"), "---\nname: old\n---");
    let skill = readSkill("o/r/old", library)!;
    expect(skill.revision).toBeNull();
    expect(skill.compatibility?.notices.join(" ")).toContain("unknown");
    put(join(library, "o/r/old/.orchestra-skill.json"), '{"revision":"not-a-hash"}');
    skill = readSkill("o/r/old", library)!;
    expect(skill.name).toBe("old");
    expect(skill.revision).toBeNull();
    expect(skillsPrompt([skill], library)).toContain("unknown");
    expect(readSkill("../../etc/passwd", library)).toBeNull();
  });
});

describe("runtime environment inventory", () => {
  test("counts inherited configuration without exposing settings, hooks or credential content", async () => {
    const dir = join(root, "runtime-config");
    const project = join(root, "project");
    put(join(dir, "settings.json"), JSON.stringify({ apiKey: "secret-key", hooks: { PostToolUse: [{ hooks: [{ command: "secret-command" }] }] }, enabledPlugins: { privatePlugin: true, disabled: false } }));
    put(join(dir, "skills/test/SKILL.md"), "secret instructions");
    put(join(dir, "agents/reviewer.md"), "secret agent instructions");
    put(join(dir, ".credentials.json"), "secret credential");
    put(join(project, "CLAUDE.md"), "private project memory");
    put(join(project, ".claude/settings.local.json"), JSON.stringify({ hooks: { Stop: [{ hooks: [] }] } }));
    symlinkSync(dir, join(dir, "skills/linked-config"));
    const result = await runtimeEnvironment("claude-code", project, dir);
    expect(result.sources).toContainEqual({ kind: "hooks", scope: "user", path: join(dir, "settings.json"), count: 1 });
    expect(result.sources).toContainEqual({ kind: "skills", scope: "user", path: join(dir, "skills"), count: 1 });
    expect(result.sources).toContainEqual({ kind: "memory", scope: "project", path: join(project, "CLAUDE.md"), count: 1 });
    const serialized = JSON.stringify(result);
    for (const secret of ["secret-key", "secret-command", "secret credential", "privatePlugin", "private project memory", ".credentials.json"]) expect(serialized).not.toContain(secret);
  });
});

describe("native delegation controls and observed children", () => {
  test("batch execution can remove delegation from both CLI toolsets, including resume", () => {
    const base = { cwd: "/w", model: null, mode: "worker" as const, schemaPath: "/s", lastMessagePath: "/m", delegation: "disabled" as const };
    expect(buildArgs({ ...base, runtime: "claude-code" })).toContain("Agent,Task,TeamCreate,SendMessage");
    const codex = buildArgs({ ...base, runtime: "codex", session: { id: "01a1057b-4be9-7ff0-8cc0-1f07f63eb1af", resume: true } });
    expect(codex).toContain("agents.enabled=false");
    expect(codex).toContain("features.multi_agent=false");
    expect(runtimeCapabilities("codex", "batch").steering).toBe(false);
    expect(runtimeCapabilities("codex", "app-server")).toMatchObject({ steering: true, accounting: "invocation" });
    expect(runtimeCapabilities("claude-code", "app-server").transport).toBe("batch");
  });

  test("parses known child events with parent identity and avoids unrelated task noise", () => {
    const parsed = parseLine("codex", JSON.stringify({ type: "item.completed", item: { type: "collab_agent_tool_call", tool: "spawn_agent", sender_thread_id: "parent", agents_states: { child: { status: "running" } } } }));
    expect(parsed.events).toEqual([{ id: "child", parentId: "parent", kind: "child-started", text: "Native Codex child child: running; independent usage unknown" }]);
    expect(parseLine("claude-code", JSON.stringify({ type: "system", subtype: "task_started", task_id: "bash", task_type: "local_bash" })).events).toBeUndefined();
    expect(parseLine("claude-code", JSON.stringify({ type: "system", subtype: "task_started", task_id: "child", task_type: "local_agent", parent_tool_use_id: "parent", description: "Review" })).events?.[0]).toMatchObject({ parentId: "parent", kind: "child-started", text: "Review" });
  });
});

const threadId = "01a1057b-4be9-7ff0-8cc0-1f07f63eb1af";
const invocation = (): AgentInvocation => ({
  agent: { id: "worker", name: "Worker", runtime: "codex", model: null, effort: null, role: "Engineer", expertise: "", skills: [], instructions: null, createdAt: 0 },
  mode: "worker", prompt: "Build it", cwd: root, onLog: () => {},
});

function fakeAppServer(script: (message: any, reply: (message: object) => void) => void) {
  const messages: any[] = [];
  let output!: ReadableStreamDefaultController<Uint8Array>;
  let ended = false;
  let exit!: (code: number) => void;
  const exited = new Promise<number>((resolve) => { exit = resolve; });
  const stdout = new ReadableStream<Uint8Array>({ start(controller) { output = controller; } });
  const reply = (message: object) => { if (!ended) output.enqueue(new TextEncoder().encode(`${JSON.stringify(message)}\n`)); };
  const spawn = (argv: string[], _cwd: string) => {
    expect(argv).toContain("agents.enabled=false");
    return {
      pid: 2_147_483_647, stdout, stderr: new ReadableStream<Uint8Array>({ start(controller) { controller.close(); } }), exited,
      stdin: { write(chunk: string) { const message = JSON.parse(chunk); messages.push(message); script(message, reply); }, end() {} },
      kill() { if (!ended) { ended = true; output.close(); exit(0); } },
    };
  };
  return { spawn, messages, reply, get killed() { return ended; } };
}

describe("Codex app-server bridge", () => {
  test("fresh and resumed worker schemas normalize JSON handoffs and reject malformed output without losing usage", async () => {
    for (const resumed of [false, true]) for (const valid of [false, true]) {
      const handoff = { summary: "Delivered", decisions: [], interfaces: ["src/ui.tsx"], blockers: [], verified: [], skillIds: [] };
      const fake = fakeAppServer((message, reply) => {
        if (message.method === "initialize") reply({ id: message.id, result: {} });
        if (["thread/start", "thread/resume"].includes(message.method)) reply({ id: message.id, result: { thread: { id: threadId } } });
        if (message.method === "turn/start") {
          expect(message.params.outputSchema).toEqual(handoffJsonSchema);
          reply({ id: message.id, result: { turn: { id: "worker-turn" } } });
          reply({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 40 } } } });
          reply({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: valid ? JSON.stringify(handoff) : "not JSON" } } });
          reply({ method: "turn/completed", params: { threadId, turn: { id: "worker-turn", status: "completed" } } });
        }
      });
      const result = await runCodexAppServer({ ...invocation(), schema: handoffJsonSchema, ...(resumed ? { resume: { id: threadId, tokens: 100, costUsd: 0 } } : {}) }, fake.spawn);
      expect(result).toMatchObject({ ok: valid, usage: { tokens: resumed ? 90 : 190, costUsd: null }, session: { id: threadId, tokens: 190 } });
      if (valid) expect(workerHandoff(result, [])).toMatchObject({ text: "Delivered", details: { interfaces: ["src/ui.tsx"] } });
      else { expect(result.error).toContain("invalid JSON"); expect(result.structured).toBeUndefined(); }
      expect(fake.messages.some((message) => message.method === (resumed ? "thread/resume" : "thread/start"))).toBe(true);
    }
  });

  test("custom timeout stops the server and preserves the resumed session and reported usage", async () => {
    const fake = fakeAppServer((message, reply) => {
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      if (message.method === "thread/resume") reply({ id: message.id, result: { thread: { id: threadId } } });
      if (message.method === "turn/start") {
        reply({ id: message.id, result: { turn: { id: "timed-turn" } } });
        reply({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 40 } } } });
        reply({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: "Partial result" } } });
      }
    });
    let disposed = false;
    const controller = new AbortController();
    const fallback = setTimeout(() => controller.abort(), 1000);
    let result;
    try {
      result = await runCodexAppServer({
        ...invocation(), timeoutMs: 50, signal: controller.signal, resume: { id: threadId, tokens: 100, costUsd: 0 },
        onControl(control) { if (!control) disposed = true; },
      }, fake.spawn);
    } finally { clearTimeout(fallback); }
    expect(result).toMatchObject({ ok: false, text: "Partial result", usage: { tokens: 90, costUsd: null }, session: { id: threadId, tokens: 190 } });
    expect(result.error).toContain("timed out");
    expect(fake.messages.some((message) => message.method === "turn/start")).toBe(true);
    expect(fake.killed).toBe(true);
    expect(disposed).toBe(true);
  });

  test("handshakes before starting, steers the active turn, returns structured output and settles cumulative usage", async () => {
    const fake = fakeAppServer((message, reply) => {
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      if (message.method === "thread/resume") reply({ id: message.id, result: { thread: { id: threadId } } });
      if (message.method === "turn/start") reply({ id: message.id, result: { turn: { id: "turn-1" } } });
      if (message.method === "turn/steer") {
        expect(message.params.expectedTurnId).toBe("turn-1");
        reply({ id: message.id, result: { turnId: "turn-1" } });
        reply({ method: "thread/tokenUsage/updated", params: { threadId, tokenUsage: { total: { inputTokens: 200, cachedInputTokens: 50, outputTokens: 40 } } } });
        reply({ method: "item/completed", params: { threadId, item: { type: "agentMessage", text: '{"ok":true}' } } });
        reply({ method: "turn/completed", params: { threadId, turn: { id: "turn-1", status: "completed" } } });
      }
    });
    let disposed = false;
    let steering!: Promise<void>;
    const inv = invocation();
    const result = await runCodexAppServer({ ...inv, schema: { type: "object" }, resume: { id: threadId, tokens: 100, costUsd: 0 }, onControl(control) {
      if (control) steering = control.steer("Check the failing test first");
      else disposed = true;
    } }, fake.spawn);
    await steering;
    expect(fake.messages.map((message) => message.method).slice(0, 5)).toEqual(["initialize", "initialized", "thread/resume", "turn/start", "turn/steer"]);
    expect(fake.messages.find((message) => message.method === "thread/resume").params).toMatchObject({ approvalPolicy: "never", sandbox: "workspace-write" });
    expect(result).toMatchObject({ ok: true, structured: { ok: true }, usage: { tokens: 90, costUsd: null }, session: { id: threadId, tokens: 190 } });
    expect(disposed).toBe(true);
  });

  test("protocol errors fail once without replaying an invocation", async () => {
    const fake = fakeAppServer((message, reply) => { if (message.method === "initialize") reply({ id: message.id, error: { message: "unsupported protocol" } }); });
    const result = await runCodexAppServer(invocation(), fake.spawn);
    expect(result).toMatchObject({ ok: false, error: "unsupported protocol" });
    expect(fake.messages.map((message) => message.method)).toEqual(["initialize"]);
  });

  test("cancellation clears controls and terminates the process while preserving the known session", async () => {
    const controller = new AbortController();
    const fake = fakeAppServer((message, reply) => {
      if (message.method === "initialize") reply({ id: message.id, result: {} });
      if (message.method === "thread/start") reply({ id: message.id, result: { thread: { id: threadId } } });
      if (message.method === "turn/start") reply({ id: message.id, result: { turn: { id: "turn-1" } } });
    });
    const controls: (InvocationControl | null)[] = [];
    const result = await runCodexAppServer({ ...invocation(), signal: controller.signal, onControl(control) { controls.push(control); if (control) controller.abort(); } }, fake.spawn);
    expect(result).toMatchObject({ ok: false, error: "cancelled", session: { id: threadId } });
    expect(controls.at(-1)).toBeNull();
  });

  test("interactive requests are rejected and pending requests settle on connection loss", async () => {
    const sent: any[] = [];
    const rpc = codexRpc((message) => sent.push(message), () => {});
    rpc.receive({ id: "approval", method: "item/commandExecution/requestApproval" });
    expect(sent.at(-1)).toEqual({ id: "approval", result: { decision: "decline" } });
    rpc.receive({ id: "input", method: "item/tool/requestUserInput" });
    expect(sent.at(-1).error.code).toBe(-32601);
    const pending = rpc.request("thread/start");
    rpc.close(new Error("connection lost"));
    await expect(pending).rejects.toThrow("connection lost");
    await expect(rpc.request("turn/start")).rejects.toThrow("connection lost");
  });
});
