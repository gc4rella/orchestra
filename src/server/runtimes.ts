import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, LogKind, Runtime, RuntimeInfo } from "../shared/types.ts";
import { RUNTIMES } from "../shared/types.ts";

const BINARIES: Record<Runtime, string> = { "claude-code": "claude", codex: "codex" };

export type Mode = "director" | "worker";

export type AgentInvocation = {
  agent: Agent;
  mode: Mode;
  prompt: string;
  cwd: string;
  /** JSON Schema the final answer must match (director only). */
  schema?: object;
  onLog: (kind: LogKind, text: string) => void;
  signal?: AbortSignal;
};

export type AgentResult = { ok: boolean; text: string; structured?: unknown; error?: string };

/** Spawns an agent and resolves with its final answer. Injected so tests can swap in a fake. */
export type RunAgent = (inv: AgentInvocation) => Promise<AgentResult>;

export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  return Promise.all(
    RUNTIMES.map(async (runtime) => {
      const bin = Bun.which(BINARIES[runtime]);
      if (!bin) return { runtime, installed: false, version: null };
      const proc = Bun.spawn([bin, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return { runtime, installed: true, version: out.trim().split("\n")[0] || null };
    }),
  );
}

type ArgsInput = { runtime: Runtime; mode: Mode; cwd: string; model: string | null; schema?: object; schemaPath: string; lastMessagePath: string };

/** argv for one headless invocation. The prompt is always written to stdin. */
export function buildArgs({ runtime, mode, cwd, model, schema, schemaPath, lastMessagePath }: ArgsInput): string[] {
  if (runtime === "claude-code") {
    return [
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      ...(model ? ["--model", model] : []),
      ...(mode === "director"
        ? ["--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob"]
        : ["--permission-mode", "bypassPermissions"]),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    ];
  }
  return [
    "codex", "exec", "--json", "-C", cwd, "--skip-git-repo-check", "-o", lastMessagePath,
    ...(model ? ["-m", model] : []),
    ...(mode === "director"
      ? ["-s", "read-only"]
      : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]),
    ...(schema ? ["--output-schema", schemaPath] : []),
    "-",
  ];
}

export type ParsedLine = { logs: { kind: LogKind; text: string }[]; final?: AgentResult };

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url", "description"].find((k) => typeof i[k] === "string");
  return clip(key ? String(i[key]) : JSON.stringify(i), 200);
}

/** Normalizes one stdout JSONL line from either CLI. Unknown lines are ignored. */
export function parseLine(runtime: Runtime, line: string): ParsedLine {
  let ev: any;
  try {
    ev = JSON.parse(line);
  } catch {
    return { logs: line.trim() ? [{ kind: "system", text: clip(line) }] : [] };
  }
  const logs: ParsedLine["logs"] = [];

  if (runtime === "claude-code") {
    if (ev.type === "system" && ev.subtype === "init") logs.push({ kind: "system", text: `session started (${ev.model ?? "default model"})` });
    if (ev.type === "assistant") {
      for (const block of ev.message?.content ?? []) {
        if (block.type === "text" && block.text?.trim()) logs.push({ kind: "text", text: block.text });
        if (block.type === "tool_use" && block.name !== "StructuredOutput") {
          logs.push({ kind: "tool", text: `${block.name} ${describeToolInput(block.input)}`.trim() });
        }
      }
    }
    if (ev.type === "result") {
      const ok = ev.is_error === false && ev.subtype === "success";
      const text = typeof ev.result === "string" ? ev.result : "";
      const shown = ev.structured_output !== undefined ? "returned structured output" : clip(text, 2000);
      logs.push({ kind: ok ? "result" : "error", text: ok ? shown : `failed: ${ev.subtype} ${clip(text)}` });
      return { logs, final: { ok, text, structured: ev.structured_output, error: ok ? undefined : `${ev.subtype}: ${clip(text)}` } };
    }
    return { logs };
  }

  // codex exec --json
  if (ev.type === "item.completed") {
    const item = ev.item ?? {};
    if (item.type === "agent_message" && item.text?.trim()) logs.push({ kind: "text", text: item.text });
    if (item.type === "command_execution") logs.push({ kind: "tool", text: `$ ${clip(item.command ?? "", 200)} → exit ${item.exit_code ?? "?"}` });
    if (item.type === "file_change") logs.push({ kind: "tool", text: `edit ${(item.changes ?? []).map((c: any) => c.path).join(", ")}` });
    if (item.type === "mcp_tool_call") logs.push({ kind: "tool", text: `${item.server ?? "mcp"}.${item.tool ?? "?"}` });
    if (item.type === "web_search") logs.push({ kind: "tool", text: `web search ${item.query ?? ""}`.trim() });
    if (item.type === "error") logs.push({ kind: "error", text: item.message ?? "error" });
  }
  if (ev.type === "thread.started") logs.push({ kind: "system", text: "session started" });
  if (ev.type === "error") logs.push({ kind: "error", text: ev.message ?? "error" });
  if (ev.type === "turn.failed") {
    const msg = ev.error?.message ?? "turn failed";
    logs.push({ kind: "error", text: msg });
    return { logs, final: { ok: false, text: "", error: msg } };
  }
  return { logs };
}

async function* lines(stream: ReadableStream<Uint8Array>) {
  const decoder = new TextDecoder();
  let buf = "";
  for await (const chunk of stream) {
    buf += decoder.decode(chunk, { stream: true });
    let nl: number;
    while ((nl = buf.indexOf("\n")) >= 0) {
      yield buf.slice(0, nl);
      buf = buf.slice(nl + 1);
    }
  }
  if (buf) yield buf;
}

export const runAgent: RunAgent = async (inv) => {
  const { runtime, model } = inv.agent;
  const tmp = await mkdtemp(join(tmpdir(), "orchestra-"));
  try {
    const schemaPath = join(tmp, "schema.json");
    const lastMessagePath = join(tmp, "last-message.txt");
    if (inv.schema) await Bun.write(schemaPath, JSON.stringify(inv.schema));
    const argv = buildArgs({ runtime, mode: inv.mode, cwd: inv.cwd, model, schema: inv.schema, schemaPath, lastMessagePath });

    const proc = Bun.spawn(argv, { cwd: inv.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe" });
    const kill = () => proc.kill();
    inv.signal?.addEventListener("abort", kill, { once: true });
    proc.stdin.write(inv.prompt);
    proc.stdin.end();
    const stderr = new Response(proc.stderr).text();

    let final: AgentResult | undefined;
    for await (const line of lines(proc.stdout)) {
      const parsed = parseLine(runtime, line);
      for (const l of parsed.logs) inv.onLog(l.kind, l.text);
      if (parsed.final) final = parsed.final;
    }
    const code = await proc.exited;
    inv.signal?.removeEventListener("abort", kill);

    if (inv.signal?.aborted) return { ok: false, text: "", error: "cancelled" };
    if (runtime === "codex" && !final) {
      const last = Bun.file(lastMessagePath);
      final = { ok: true, text: (await last.exists()) ? await last.text() : "" };
    }
    if (code !== 0 || !final) {
      const tail = (await stderr).trim().split("\n").slice(-5).join("\n");
      return { ok: false, text: final?.text ?? "", error: final?.error ?? `${BINARIES[runtime]} exited with code ${code}${tail ? `: ${tail}` : ""}` };
    }
    return final;
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};
