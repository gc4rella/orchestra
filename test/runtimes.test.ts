import { describe, expect, test } from "bun:test";
import { buildArgs, parseLine } from "../src/server/runtimes.ts";

const base = { cwd: "/w", schemaPath: "/t/schema.json", lastMessagePath: "/t/last.txt" };

describe("buildArgs", () => {
  test("claude director is read-only with a schema", () => {
    const argv = buildArgs({ ...base, runtime: "claude-code", mode: "director", model: "opus", schema: { type: "object" } });
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
  test("codex director is sandboxed read-only, reads the prompt from stdin", () => {
    const argv = buildArgs({ ...base, runtime: "codex", mode: "director", model: null, schema: {} });
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
});

// Lines recorded from claude 2.1.280 and codex 0.157.1.
describe("parseLine claude", () => {
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
  test("error result fails", () => {
    const final = parseLine("claude-code", '{"type":"result","subtype":"error_max_turns","is_error":true,"result":""}').final;
    expect(final?.ok).toBe(false);
    expect(final?.error).toContain("error_max_turns");
  });
});

describe("parseLine codex", () => {
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
  test("turn.completed is not final; the -o file is", () => {
    expect(parseLine("codex", '{"type":"turn.completed","usage":{}}')).toEqual({ logs: [] });
  });
  test("non-JSON output is surfaced as system log", () => {
    expect(parseLine("codex", "warning: something").logs).toEqual([{ kind: "system", text: "warning: something" }]);
  });
});
