import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent, LogKind, Runtime, RuntimeInfo, Session, Usage } from "../shared/types.ts";
import { RUNTIMES } from "../shared/types.ts";

const BINARIES: Record<Runtime, string> = { "claude-code": "claude", codex: "codex" };

/** "readonly" inspects the project (the director, reviewers); "worker" edits it without permission prompts. */
export type Mode = "readonly" | "worker";

/** Wall-clock limit for one invocation, so a stuck agent can't hold a task forever. */
export const AGENT_TIMEOUT_MS = 45 * 60_000;

/** Session ids go into argv; only a UUID (Claude's or Codex's thread id) can't be read as a flag. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type AgentInvocation = {
  agent: Agent;
  mode: Mode;
  prompt: string;
  cwd: string;
  /** JSON Schema the final answer must match (readonly mode). */
  schema?: object;
  /** Continue this conversation instead of starting a new one. It must have been started in the same `cwd`. */
  resume?: Session;
  onLog: (kind: LogKind, text: string) => void;
  signal?: AbortSignal;
};

/** `usage` is this invocation's alone; `session` is the conversation to resume, with its running totals. */
export type AgentResult = { ok: boolean; text: string; structured?: unknown; error?: string; session?: Session; usage?: Usage };

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

type ArgsInput = {
  runtime: Runtime; mode: Mode; cwd: string; model: string | null; schema?: object; schemaPath: string; lastMessagePath: string;
  /** Claude: the id of a new session (`new`) or the one to continue (`resume`). Codex names its own threads. */
  session?: { id: string; resume: boolean };
};

/** argv for one headless invocation. The prompt is always written to stdin. */
export function buildArgs({ runtime, mode, cwd, model, schema, schemaPath, lastMessagePath, session }: ArgsInput): string[] {
  if (session && !SESSION_ID.test(session.id)) throw new Error(`invalid session id "${session.id}"`);
  if (runtime === "claude-code") {
    return [
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      ...(session ? [session.resume ? "--resume" : "--session-id", session.id] : []),
      ...(model ? ["--model", model] : []),
      ...(mode === "readonly"
        ? ["--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob"]
        : ["--permission-mode", "bypassPermissions"]),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
    ];
  }
  const tail = [...(model ? ["-m", model] : []), ...(schema ? ["--output-schema", schemaPath] : []), "-"];
  if (session?.resume) {
    // `exec resume` has no -s/-C: the sandbox is set through config and the directory is the process cwd.
    return [
      "codex", "exec", "resume", session.id, "--json", "--skip-git-repo-check", "-o", lastMessagePath,
      ...(mode === "readonly"
        ? ["-c", 'sandbox_mode="read-only"']
        : ["-c", 'sandbox_mode="workspace-write"', "-c", "sandbox_workspace_write.network_access=true"]),
      ...tail,
    ];
  }
  return [
    "codex", "exec", "--json", "-C", cwd, "--skip-git-repo-check", "-o", lastMessagePath,
    ...(model ? ["-m", model] : []),
    ...(mode === "readonly"
      ? ["-s", "read-only"]
      : ["-s", "workspace-write", "-c", "sandbox_workspace_write.network_access=true"]),
    ...(schema ? ["--output-schema", schemaPath] : []),
    "-",
  ];
}

/**
 * Usage as a CLI reports it. Claude's cost is the session's running total while its tokens are per invocation;
 * Codex's tokens are the thread's running total. Cache reads are left out of tokens.
 */
export type ReportedUsage = { costUsd?: number; tokens?: number; cumulativeTokens?: number };

export type ParsedLine = { logs: { kind: LogKind; text: string }[]; final?: AgentResult; sessionId?: string; usage?: ReportedUsage };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

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
    if (ev.type === "system" && ev.subtype === "init") {
      logs.push({ kind: "system", text: `session started (${ev.model ?? "default model"})` });
      if (typeof ev.session_id === "string") return { logs, sessionId: ev.session_id };
    }
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
      const u = ev.usage ?? {};
      return {
        logs,
        final: { ok, text, structured: ev.structured_output, error: ok ? undefined : `${ev.subtype}: ${clip(text)}` },
        usage: { costUsd: num(ev.total_cost_usd), tokens: num(u.input_tokens) + num(u.cache_creation_input_tokens) + num(u.output_tokens) },
      };
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
  if (ev.type === "thread.started") {
    logs.push({ kind: "system", text: "session started" });
    if (typeof ev.thread_id === "string") return { logs, sessionId: ev.thread_id };
  }
  if (ev.type === "turn.completed" && ev.usage) {
    const u = ev.usage;
    return { logs, usage: { cumulativeTokens: num(u.input_tokens) - num(u.cached_input_tokens) + num(u.output_tokens) } };
  }
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

/** Turns what the CLI reported into this invocation's usage and the session's new running totals. */
export function settleUsage(runtime: Runtime, previous: Session | undefined, sessionId: string | undefined, reported: ReportedUsage) {
  const prev = previous ?? { costUsd: 0, tokens: 0 };
  const sessionCost = reported.costUsd ?? prev.costUsd;
  const sessionTokens = reported.cumulativeTokens ?? prev.tokens + (reported.tokens ?? 0);
  const usage: Usage = {
    costUsd: runtime === "claude-code" ? Math.max(0, sessionCost - prev.costUsd) : null,
    tokens: Math.max(0, sessionTokens - prev.tokens),
  };
  const session = sessionId ? { id: sessionId, costUsd: sessionCost, tokens: sessionTokens } : undefined;
  return { usage, session };
}

export const runAgent: RunAgent = async (inv) => {
  const { runtime, model } = inv.agent;
  const tmp = await mkdtemp(join(tmpdir(), "orchestra-"));
  try {
    const schemaPath = join(tmp, "schema.json");
    const lastMessagePath = join(tmp, "last-message.txt");
    if (inv.schema) await Bun.write(schemaPath, JSON.stringify(inv.schema));
    // Claude takes the id we choose for a new session; Codex announces its thread id on stdout.
    const session = inv.resume
      ? { id: inv.resume.id, resume: true }
      : runtime === "claude-code" ? { id: crypto.randomUUID(), resume: false } : undefined;
    const argv = buildArgs({ runtime, mode: inv.mode, cwd: inv.cwd, model, schema: inv.schema, schemaPath, lastMessagePath, session });

    const timeout = AbortSignal.timeout(AGENT_TIMEOUT_MS);
    const signal = inv.signal ? AbortSignal.any([inv.signal, timeout]) : timeout;
    // Separate process group: deadlines stop agent-launched commands as well as the CLI.
    const options = { cwd: inv.cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true } as const;
    const proc = Bun.spawn(argv, options as Omit<typeof options, "detached">);
    const kill = () => {
      try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
    };
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    proc.stdin.write(inv.prompt);
    proc.stdin.end();
    const stderr = new Response(proc.stderr).text();

    let final: AgentResult | undefined;
    // Only a session the CLI reports as started can be resumed.
    let sessionId = inv.resume?.id;
    const reported: ReportedUsage = {};
    for await (const line of lines(proc.stdout)) {
      const parsed = parseLine(runtime, line);
      for (const l of parsed.logs) inv.onLog(l.kind, l.text);
      if (parsed.final) final = parsed.final;
      if (parsed.sessionId && SESSION_ID.test(parsed.sessionId)) sessionId = parsed.sessionId;
      Object.assign(reported, parsed.usage);
    }
    const code = await proc.exited;
    signal.removeEventListener("abort", kill);
    const settled = settleUsage(runtime, inv.resume, sessionId, reported);

    if (inv.signal?.aborted) return { ok: false, text: "", error: "cancelled", ...settled };
    if (timeout.aborted) return { ok: false, text: "", error: `timed out after ${AGENT_TIMEOUT_MS / 60_000} minutes`, ...settled };
    if (runtime === "codex" && !final) {
      const last = Bun.file(lastMessagePath);
      final = { ok: true, text: (await last.exists()) ? await last.text() : "" };
    }
    if (code !== 0 || !final) {
      const tail = (await stderr).trim().split("\n").slice(-5).join("\n");
      const error = final?.error ?? `${BINARIES[runtime]} exited with code ${code}${tail ? `: ${tail}` : ""}`;
      return { ok: false, text: final?.text ?? "", error, ...settled };
    }
    return { ...final, ...settled };
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};
