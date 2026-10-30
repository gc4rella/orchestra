import { describe, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildArgs, cliDefaults, parseLine, settleUsage } from "../src/server/runtimes.ts";

const base = { cwd: "/w", schemaPath: "/t/schema.json", lastMessagePath: "/t/last.txt" };

describe("buildArgs", () => {
  test("claude read-only mode with a schema", () => {
    const argv = buildArgs({ ...base, runtime: "claude-code", mode: "readonly", model: "opus", schema: { type: "object" } });
    expect(argv).toEqual([
      "claude", "-p", "--output-format", "stream-json", "--verbose", "--model", "opus",
      "--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob", "--json-schema", '{"type":"object"}',
    ]);
  });
  test("claude worker runs without prompts", () => {
    const argv = buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: null });
    expect(argv).toContain("bypassPermissions");
    expect(argv).not.toContain("--model");
    expect(argv).not.toContain("--json-schema");
  });
  test("codex read-only mode is sandboxed read-only, reads the prompt from stdin", () => {
    const argv = buildArgs({ ...base, runtime: "codex", mode: "readonly", model: null, schema: {} });
    expect(argv).toEqual([
      "codex", "exec", "--json", "-C", "/w", "--skip-git-repo-check", "-o", "/t/last.txt",
      "-s", "read-only", "--output-schema", "/t/schema.json", "-",
    ]);
  });
  test("codex worker writes the workspace with network", () => {
    const argv = buildArgs({ ...base, runtime: "codex", mode: "worker", model: "gpt-5-codex" });
    expect(argv).toEqual([
      "codex", "exec", "--json", "-C", "/w", "--skip-git-repo-check", "-o", "/t/last.txt", "-m", "gpt-5-codex",
      "-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true", "-",
    ]);
  });
  test("effort goes to claude as --effort and to codex as config", () => {
    expect(buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: "opus", effort: "max" }).slice(5, 9))
      .toEqual(["--model", "opus", "--effort", "max"]);
    expect(buildArgs({ ...base, runtime: "codex", mode: "worker", model: null, effort: "high" }).slice(8, 10))
      .toEqual(["-c", 'model_reasoning_effort="high"']);
    const tid = "01a1057b-60e0-7910-9eb7-8e5b390c9a06";
    expect(buildArgs({ ...base, runtime: "codex", mode: "worker", model: null, effort: "minimal", session: { id: tid, resume: true } }).slice(-3))
      .toEqual(["-c", 'model_reasoning_effort="minimal"', "-"]);
  });
  test("an effort the CLI doesn't know never reaches argv", () => {
    expect(() => buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: null, effort: "minimal" })).toThrow("invalid effort");
    expect(() => buildArgs({ ...base, runtime: "codex", mode: "worker", model: null, effort: "--x" })).toThrow("invalid effort");
  });
  const sid = "35c7f173-43b3-4c3d-b885-cd9044b3f3d6";
  test("claude names a new session and resumes it by id", () => {
    expect(buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: null, session: { id: sid, resume: false } }).slice(5, 7))
      .toEqual(["--session-id", sid]);
    expect(buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: null, session: { id: sid, resume: true } }).slice(5, 7))
      .toEqual(["--resume", sid]);
  });
  test("codex resume sets the sandbox through config, since exec resume has no -s or -C", () => {
    const tid = "01a1057b-60e0-7910-9eb7-8e5b390c9a06";
    expect(buildArgs({ ...base, runtime: "codex", mode: "worker", model: "gpt-5-codex", session: { id: tid, resume: true } })).toEqual([
      "codex", "exec", "resume", tid, "--json", "--skip-git-repo-check", "-o", "/t/last.txt",
      "-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true", "-m", "gpt-5-codex", "-",
    ]);
    expect(buildArgs({ ...base, runtime: "codex", mode: "readonly", model: null, schema: {}, session: { id: tid, resume: true } }))
      .toContain('sandbox_mode="read-only"');
  });
  test("a session id that isn't a UUID never reaches argv", () => {
    for (const id of ["--dangerously-skip-permissions", "abc", `${sid} x`]) {
      expect(() => buildArgs({ ...base, runtime: "claude-code", mode: "worker", model: null, session: { id, resume: true } })).toThrow("invalid session id");
    }
  });
});

describe("cliDefaults", () => {
  const dir = () => realpathSync(mkdtempSync(join(tmpdir(), "orchestra-cli-config-")));
  test("reads the top-level model and effort from each CLI's user config", async () => {
    const claude = dir();
    writeFileSync(join(claude, "settings.json"), JSON.stringify({ model: "opus", effortLevel: "xhigh", modelSettings: {} }));
    expect(await cliDefaults("claude-code", claude)).toEqual({ model: "opus", effort: "xhigh" });
    const codex = dir();
    writeFileSync(join(codex, "config.toml"), 'model = "gpt-5-codex"\nmodel_reasoning_effort = "medium"\n\n[profiles.fast]\nmodel = "mini"\n');
    expect(await cliDefaults("codex", codex)).toEqual({ model: "gpt-5-codex", effort: "medium" });
  });
  test("missing or malformed config is unknown, not an error", async () => {
    expect(await cliDefaults("claude-code", dir())).toEqual({ model: null, effort: null });
    const codex = dir();
    writeFileSync(join(codex, "config.toml"), "model = ");
    expect(await cliDefaults("codex", codex)).toEqual({ model: null, effort: null });
  });
});

describe("usage", () => {
  test("claude cost is the session's running total, its tokens are per invocation", () => {
    const first = settleUsage("claude-code", undefined, "s1", { costUsd: 0.068, tokens: 33948 });
    expect(first.usage).toEqual({ costUsd: 0.068, tokens: 33948 });
    expect(first.session).toEqual({ id: "s1", costUsd: 0.068, tokens: 33948 });
    const second = settleUsage("claude-code", first.session, "s1", { costUsd: 0.0727, tokens: 551 });
    expect(second.usage?.costUsd).toBeCloseTo(0.0047);
    expect(second.usage?.tokens).toBe(551);
    expect(second.session).toEqual({ id: "s1", costUsd: 0.0727, tokens: 34499 });
  });
  test("codex reports cumulative tokens and no cost", () => {
    const first = settleUsage("codex", undefined, "t1", { cumulativeTokens: 15676 });
    expect(first.usage).toEqual({ costUsd: null, tokens: 15676 });
    const second = settleUsage("codex", first.session, "t1", { cumulativeTokens: 26000 });
    expect(second.usage).toEqual({ costUsd: null, tokens: 10324 });
  });
  test("no metrics means unknown usage and missing reports preserve prior session totals", () => {
    expect(settleUsage("codex", undefined, undefined, {})).toEqual({ usage: undefined, session: undefined });
    const previous = { id: "same", costUsd: 0.5, tokens: 50 };
    for (const runtime of ["codex", "claude-code"] as const) {
      const result = settleUsage(runtime, previous, "same", {});
      expect(result.usage).toBeUndefined();
      expect(result.session).toMatchObject(previous);
      expect(result.session?.usageUnknown?.tokens).toBe(true);
    }
    expect(previous).toEqual({ id: "same", costUsd: 0.5, tokens: 50 });
  });
  test("explicit zero is known, while cost-only and token-only reports preserve missing metrics", () => {
    expect(settleUsage("claude-code", undefined, "s", { costUsd: 0, tokens: 0 }).usage).toEqual({ costUsd: 0, tokens: 0 });
    expect(settleUsage("codex", undefined, "s", { cumulativeTokens: 0 }).usage).toEqual({ costUsd: null, tokens: 0 });
    expect(settleUsage("claude-code", undefined, "s", { costUsd: 0.2 }).usage).toEqual({ costUsd: 0.2, tokens: 0, tokensReported: false });
    expect(settleUsage("claude-code", undefined, "s", { tokens: 12 }).usage).toEqual({ costUsd: null, tokens: 12 });
  });
  test("a cumulative report after an unknown invocation establishes a new baseline without assigning the gap", () => {
    const previous = { id: "s", costUsd: 0.5, tokens: 50 };
    const missing = settleUsage("codex", previous, "s", {});
    const resumed = settleUsage("codex", missing.session, "s", { cumulativeTokens: 80 });
    expect(resumed.usage).toEqual({ costUsd: null, tokens: 0, tokensReported: false });
    expect(resumed.session).toEqual({ id: "s", costUsd: 0.5, tokens: 80 });
    expect(settleUsage("codex", resumed.session, "s", { cumulativeTokens: 90 }).usage).toEqual({ costUsd: null, tokens: 10 });
    const claudeMissing = settleUsage("claude-code", previous, "s", {});
    const claudeResumed = settleUsage("claude-code", claudeMissing.session, "s", { costUsd: 0.7, tokens: 5 });
    expect(claudeResumed.usage).toEqual({ costUsd: null, tokens: 5 });
    expect(settleUsage("claude-code", claudeResumed.session, "s", { costUsd: 0.8, tokens: 7 }).usage?.costUsd).toBeCloseTo(0.1);
  });
});

// Lines recorded from claude 2.1.280 / 2.1.288 and codex 0.157.1 / 0.160.0.
describe("parseLine claude", () => {
  test("missing, empty and invalid usage is absent while explicit zeros remain reported", () => {
    const result = { type: "result", subtype: "success", is_error: false, result: "done" };
    expect(parseLine("claude-code", JSON.stringify(result)).usage).toBeUndefined();
    expect(parseLine("claude-code", JSON.stringify({ ...result, usage: {} })).usage).toBeUndefined();
    expect(parseLine("claude-code", JSON.stringify({ ...result, total_cost_usd: null, usage: { input_tokens: -1, output_tokens: "unknown" } })).usage).toBeUndefined();
    expect(parseLine("claude-code", JSON.stringify({ ...result, total_cost_usd: 0, usage: { input_tokens: 0, output_tokens: 0 } })).usage).toEqual({ costUsd: 0, tokens: 0 });
    expect(parseLine("claude-code", JSON.stringify({ ...result, total_cost_usd: 0.1 })).usage).toEqual({ costUsd: 0.1 });
    expect(parseLine("claude-code", JSON.stringify({ ...result, total_cost_usd: 0.1, usage: { input_tokens: 10 } })).usage).toEqual({ costUsd: 0.1 });
    expect(parseLine("claude-code", JSON.stringify({ ...result, usage: { output_tokens: 5 } })).usage).toBeUndefined();
  });
  test("ignores hook noise", () => {
    expect(parseLine("claude-code", '{"type":"system","subtype":"hook_started","hook_id":"x"}').logs).toEqual([]);
  });
  test("logs text and tool use, hides the StructuredOutput tool", () => {
    const line = JSON.stringify({
      type: "assistant",
      message: { content: [
        { type: "thinking", thinking: "" },
        { type: "text", text: "Looking around" },
        { type: "tool_use", name: "Bash", input: { command: "ls -la" } },
        { type: "tool_use", name: "StructuredOutput", input: { summary: "hi" } },
      ] },
    });
    expect(parseLine("claude-code", line).logs).toEqual([
      { kind: "text", text: "Looking around" },
      { kind: "tool", text: "Bash ls -la" },
    ]);
  });
  test("result carries structured output", () => {
    const line = '{"type":"result","subtype":"success","is_error":false,"result":"{\\"summary\\":\\"hi\\",\\"tasks\\":[\\"a\\"]}","structured_output":{"summary":"hi","tasks":["a"]}}';
    expect(parseLine("claude-code", line).final).toEqual({
      ok: true, text: '{"summary":"hi","tasks":["a"]}', structured: { summary: "hi", tasks: ["a"] }, error: undefined,
    });
  });
  test("init names the session; the result reports cost and tokens without cache reads", () => {
    expect(parseLine("claude-code", '{"type":"system","subtype":"init","session_id":"35c7f173-43b3-4c3d-b885-cd9044b3f3d6","model":"claude-haiku-4-5"}').sessionId)
      .toBe("35c7f173-43b3-4c3d-b885-cd9044b3f3d6");
    const line = '{"type":"result","subtype":"success","is_error":false,"result":"OK","session_id":"35c7f173-43b3-4c3d-b885-cd9044b3f3d6","total_cost_usd":0.0726687,"usage":{"input_tokens":9,"cache_creation_input_tokens":494,"cache_read_input_tokens":33887,"output_tokens":48}}';
    expect(parseLine("claude-code", line).usage).toEqual({ costUsd: 0.0726687, tokens: 551 });
  });
  test("error result fails", () => {
    const final = parseLine("claude-code", '{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}').final;
    expect(final?.ok).toBe(false);
    expect(final?.error).toContain("error_max_turns");
  });
});

describe("parseLine codex", () => {
  test("an absent or empty token report is unknown rather than zero", () => {
    expect(parseLine("codex", '{"type":"turn.completed"}').usage).toBeUndefined();
    expect(parseLine("codex", '{"type":"turn.completed","usage":{}}').usage).toBeUndefined();
    expect(parseLine("codex", '{"type":"turn.completed","usage":{"input_tokens":10}}').usage).toBeUndefined();
    expect(parseLine("codex", '{"type":"turn.completed","usage":{"input_tokens":0,"output_tokens":0}}').usage).toEqual({ cumulativeTokens: 0 });
  });
  test("agent message, commands and file changes", () => {
    expect(parseLine("codex", '{"type":"item.completed","item":{"id":"item_0","type":"agent_message","text":"done"}}').logs)
      .toEqual([{ kind: "text", text: "done" }]);
    expect(parseLine("codex", '{"type":"item.completed","item":{"type":"command_execution","command":"bun test","exit_code":0}}').logs)
      .toEqual([{ kind: "tool", text: "$ bun test → exit 0" }]);
    expect(parseLine("codex", '{"type":"item.completed","item":{"type":"file_change","changes":[{"path":"a.ts","kind":"add"}]}}').logs)
      .toEqual([{ kind: "tool", text: "edit a.ts" }]);
  });
  test("turn.failed is a failed final result", () => {
    const parsed = parseLine("codex", '{"type":"turn.failed","error":{"message":"rate limited"}}');
    expect(parsed.final).toEqual({ ok: false, text: "", error: "rate limited" });
  });
  test("turn.completed is not final (the -o file is) but reports the thread's tokens without cached input", () => {
    const line = '{"type":"turn.completed","usage":{"input_tokens":23735,"cached_input_tokens":8064,"cache_write_input_tokens":0,"output_tokens":5,"reasoning_output_tokens":0}}';
    expect(parseLine("codex", line)).toEqual({ logs: [], usage: { cumulativeTokens: 15676 } });
  });
  test("thread.started names the session", () => {
    expect(parseLine("codex", '{"type":"thread.started","thread_id":"01a1057b-4be9-7ff0-8cc0-1f07f63eb1af"}').sessionId)
      .toBe("01a1057b-4be9-7ff0-8cc0-1f07f63eb1af");
  });
  test("non-JSON output is surfaced as system log", () => {
    expect(parseLine("codex", "warning: something").logs).toEqual([{ kind: "system", text: "warning: something" }]);
  });
});
