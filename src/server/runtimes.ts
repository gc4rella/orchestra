import { mkdtemp, rm } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import type { Agent, CliDefaults, LogKind, ProbeResult, Runtime, RuntimeCapabilities, RuntimeEnvironment, RuntimeInfo, Session, Usage } from "../shared/types.ts";
import { DEFAULT_RUN_TIMEOUTS, EFFORTS, RUNTIMES } from "../shared/types.ts";

const BINARIES: Record<Runtime, string> = { "claude-code": "claude", codex: "codex" };

/** "readonly" inspects the project (the director, reviewers); "worker" edits it without permission prompts. */
export type Mode = "readonly" | "worker";

/** Wall-clock limit for one invocation, so a stuck agent can't hold a task forever. */
export const AGENT_TIMEOUT_MS = DEFAULT_RUN_TIMEOUTS.agentMs;

/** Session ids go into argv; only a UUID (Claude's or Codex's thread id) can't be read as a flag. */
export const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type RuntimeEvent = { id: string; parentId: string | null; kind: "child-started" | "child-completed"; text: string };

/** Providers also report background shell tasks. Only a known child start establishes agent identity. */
export function childEventFilter() {
  const children = new Set<string>();
  return (event: RuntimeEvent): boolean => {
    if (event.kind === "child-started") {
      if (children.has(event.id)) return false;
      children.add(event.id);
      return true;
    }
    return event.parentId !== null && children.delete(event.parentId);
  };
}
export type InvocationControl = { steer: (text: string) => Promise<void>; interrupt: () => Promise<void> };

export type AgentInvocation = {
  agent: Agent;
  mode: Mode;
  prompt: string;
  cwd: string;
  /** JSON Schema the final answer must match in either mode. */
  schema?: object;
  /** Continue this conversation instead of starting a new one. It must have been started in the same `cwd`. */
  resume?: Session;
  onLog: (kind: LogKind, text: string) => void;
  signal?: AbortSignal;
  timeoutMs?: number;
  transport?: "batch" | "app-server";
  /** Native child usage is not independently metered; Orchestra must disclose this before enabling it. */
  nativeDelegation?: boolean;
  maxNativeChildren?: number;
  onEvent?: (event: RuntimeEvent) => void;
  onControl?: (control: InvocationControl | null) => void;
};

/** `usage` is this invocation's alone; `session` is the conversation to resume, with its running totals. */
export type AgentResult = { ok: boolean; text: string; structured?: unknown; error?: string; session?: Session; usage?: Usage };

function structuredResult(result: AgentResult, schema: object | undefined): AgentResult {
  if (!schema || !result.ok || result.structured !== undefined) return result;
  try { return { ...result, structured: JSON.parse(result.text) }; }
  catch { return { ...result, ok: false, error: "Agent returned invalid JSON for the requested structured output schema" }; }
}

/** Spawns an agent and resolves with its final answer. Injected so tests can swap in a fake. */
export type RunAgent = (inv: AgentInvocation) => Promise<AgentResult>;

/** Adapter capabilities, rather than every feature an interactive CLI happens to offer. */
export function runtimeCapabilities(runtime: Runtime, transport: "batch" | "app-server" = "batch"): RuntimeCapabilities {
  return {
    transport: runtime === "codex" ? transport : "batch", structuredOutput: true, resume: true,
    steering: runtime === "codex" && transport === "app-server", childEvents: true, delegationControl: true, accounting: "invocation",
  };
}

const transportProbes = new Map<string, Promise<"batch" | "app-server">>();
/** Help is local and free. A failed handshake during actual work must never replay a paid invocation. */
export async function preferredTransport(runtime: Runtime): Promise<"batch" | "app-server"> {
  if (runtime !== "codex") return "batch";
  const bin = Bun.which(BINARIES.codex);
  if (!bin) return "batch";
  let probe = transportProbes.get(bin);
  if (!probe) {
    probe = (async () => {
      try {
        const proc = Bun.spawn([bin, "app-server", "--help"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
        const help = await new Response(proc.stdout).text();
        return await proc.exited === 0 && /stdio/.test(help) ? "app-server" as const : "batch" as const;
      } catch { return "batch" as const; }
    })();
    transportProbes.set(bin, probe);
  }
  return probe;
}

export async function detectRuntimes(): Promise<RuntimeInfo[]> {
  return Promise.all(
    RUNTIMES.map(async (runtime) => {
      const bin = Bun.which(BINARIES[runtime]);
      const defaults = await cliDefaults(runtime);
      const capabilities = runtimeCapabilities(runtime, await preferredTransport(runtime));
      const environment = await runtimeEnvironment(runtime);
      if (!bin) return { runtime, installed: false, version: null, defaults, capabilities, environment };
      const proc = Bun.spawn([bin, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore" });
      const out = await new Response(proc.stdout).text();
      await proc.exited;
      return { runtime, installed: true, version: out.trim().split("\n")[0] || null, defaults, capabilities, environment };
    }),
  );
}

/** Each CLI's user config directory; the env vars are the CLIs' own overrides. */
const configDir = (runtime: Runtime) =>
  runtime === "claude-code"
    ? process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude")
    : process.env.CODEX_HOME || join(homedir(), ".codex");

/** Paths and counts only: settings values, hook commands and credential files never leave this process. */
export async function runtimeEnvironment(runtime: Runtime, cwd?: string, userDir = configDir(runtime)): Promise<RuntimeEnvironment> {
  const sources: RuntimeEnvironment["sources"] = [];
  const notices = ["Inventory describes discovered configuration; managed policy, plugins and dynamic includes may add further instructions.", "Native child usage is not independently metered. Orchestra controls its own invocation count."];
  const add = (kind: RuntimeEnvironment["sources"][number]["kind"], scope: "user" | "project", path: string, count = 1) => {
    if (existsSync(path) && !sources.some((source) => source.kind === kind && source.path === path)) sources.push({ kind, scope, path, count });
  };
  const count = (dir: string, wanted: (name: string) => boolean, depth = 0): number => {
    try { return readdirSync(dir, { withFileTypes: true }).reduce((n, entry) => n + (entry.isFile() && wanted(entry.name) ? 1 : entry.isDirectory() && depth < 6 ? count(join(dir, entry.name), wanted, depth + 1) : 0), 0); }
    catch { return 0; }
  };
  const inspect = async (dir: string, scope: "user" | "project") => {
    const settings = join(dir, runtime === "codex" ? "config.toml" : "settings.json");
    add("settings", scope, settings);
    if (runtime === "claude-code") add("settings", scope, join(dir, "settings.local.json"));
    for (const path of [settings, ...(runtime === "claude-code" ? [join(dir, "settings.local.json")] : [])]) {
      try {
        const config = runtime === "codex" ? Bun.TOML.parse(await Bun.file(path).text()) : await Bun.file(path).json();
        const hooks = config.hooks;
        if (hooks && typeof hooks === "object") add("hooks", scope, path, Object.values(hooks).reduce<number>((n, value) => n + (Array.isArray(value) ? value.length : 1), 0));
        if (runtime === "claude-code" && config.enabledPlugins && typeof config.enabledPlugins === "object") add("plugins", scope, path, Object.values(config.enabledPlugins).filter(Boolean).length);
        if (runtime === "codex" && config.agents && typeof config.agents === "object") add("agents", scope, path, Object.values(config.agents).filter((value) => !!value && typeof value === "object").length);
      } catch { if (existsSync(path)) notices.push(`Could not inspect ${path}; its effective behavior is unknown.`); }
    }
    for (const [kind, directory, predicate] of [
      ["skills", "skills", (name: string) => name === "SKILL.md"],
      ["agents", "agents", (name: string) => /\.(?:md|toml)$/.test(name)],
      ["plugins", "plugins", (name: string) => name === "plugin.json"],
      ["memory", "memories", (name: string) => /\.md$/.test(name)],
    ] as const) add(kind, scope, join(dir, directory), count(join(dir, directory), predicate));
    add("hooks", scope, join(dir, "hooks.json"));
  };
  await inspect(userDir, "user");
  add("memory", "user", join(userDir, runtime === "codex" ? "AGENTS.md" : "CLAUDE.md"));
  if (runtime === "codex") {
    const sharedSkills = join(dirname(userDir), ".agents", "skills");
    add("skills", "user", sharedSkills, count(sharedSkills, (name) => name === "SKILL.md"));
  }
  if (cwd) {
    let path = resolve(cwd);
    while (true) {
      await inspect(join(path, runtime === "codex" ? ".codex" : ".claude"), "project");
      if (runtime === "codex") add("skills", "project", join(path, ".agents/skills"), count(join(path, ".agents/skills"), (name) => name === "SKILL.md"));
      for (const name of runtime === "codex" ? ["AGENTS.md", "AGENTS.override.md"] : ["CLAUDE.md", "CLAUDE.local.md", ".claude/CLAUDE.md"]) add("memory", "project", join(path, name));
      if (dirname(path) === path) break;
      path = dirname(path);
    }
  }
  return { sources, notices };
}

/** The top-level model and effort from a CLI's user config. Missing or unreadable config means unknown. */
export async function cliDefaults(runtime: Runtime, dir = configDir(runtime)): Promise<CliDefaults> {
  const str = (v: unknown) => (typeof v === "string" && v.trim() ? v.trim() : null);
  try {
    if (runtime === "claude-code") {
      const settings = await Bun.file(join(dir, "settings.json")).json();
      return { model: str(settings.model), effort: str(settings.effortLevel) };
    }
    const config = Bun.TOML.parse(await Bun.file(join(dir, "config.toml")).text()) as Record<string, unknown>;
    return { model: str(config.model), effort: str(config.model_reasoning_effort) };
  } catch {
    return { model: null, effort: null };
  }
}

type ArgsInput = {
  runtime: Runtime; mode: Mode; cwd: string; model: string | null; effort?: string | null; schema?: object; schemaPath: string; lastMessagePath: string;
  /** Claude: the id of a new session (`new`) or the one to continue (`resume`). Codex names its own threads. */
  session?: { id: string; resume: boolean };
  delegation?: "disabled" | "native";
};

/** argv for one headless invocation. The prompt is always written to stdin. */
export function buildArgs({ runtime, mode, cwd, model, effort, schema, schemaPath, lastMessagePath, session, delegation }: ArgsInput): string[] {
  if (session && !SESSION_ID.test(session.id)) throw new Error(`invalid session id "${session.id}"`);
  if (effort && !EFFORTS[runtime].includes(effort)) throw new Error(`invalid effort "${effort}"`);
  if (runtime === "claude-code") {
    return [
      "claude", "-p", "--output-format", "stream-json", "--verbose",
      ...(session ? [session.resume ? "--resume" : "--session-id", session.id] : []),
      ...(model ? ["--model", model] : []),
      ...(effort ? ["--effort", effort] : []),
      ...(mode === "readonly"
        ? ["--permission-mode", "dontAsk", "--allowedTools", "Read,Grep,Glob"]
        : ["--permission-mode", "bypassPermissions"]),
      ...(schema ? ["--json-schema", JSON.stringify(schema)] : []),
      ...(delegation === "disabled" ? ["--disallowedTools", "Agent,Task,TeamCreate,SendMessage"] : []),
    ];
  }
  const tuning = [...(model ? ["-m", model] : []), ...(effort ? ["-c", `model_reasoning_effort="${effort}"`] : []),
    ...(delegation === "disabled" ? ["-c", "agents.enabled=false", "-c", "features.multi_agent=false", "-c", "features.multi_agent_v2=false"] : [])];
  const tail = [...tuning, ...(schema ? ["--output-schema", schemaPath] : []), "-"];
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
    ...tuning,
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

export type ParsedLine = { logs: { kind: LogKind; text: string }[]; final?: AgentResult; sessionId?: string; usage?: ReportedUsage; events?: RuntimeEvent[] };

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
const metric = (v: unknown): number | undefined => typeof v === "number" && Number.isFinite(v) && v >= 0 ? v : undefined;
function tokenCount(input: unknown, output: unknown, cached?: unknown, created?: unknown): number | undefined {
  const incoming = metric(input), outgoing = metric(output);
  // Both primary counters establish a total; the CLIs omit optional cache counters when zero.
  return incoming === undefined || outgoing === undefined ? undefined : Math.max(0, incoming + outgoing + (metric(created) ?? 0) - (metric(cached) ?? 0));
}

const clip = (s: string, n = 300) => (s.length > n ? `${s.slice(0, n)}…` : s);

function describeToolInput(input: unknown): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  const key = ["command", "file_path", "path", "pattern", "url", "description"].find((k) => typeof i[k] === "string");
  return clip(key ? String(i[key]) : JSON.stringify(i), 200);
}

function nativeEvents(runtime: Runtime, ev: any): RuntimeEvent[] {
  if (runtime === "claude-code") {
    if (ev.type !== "system" || typeof ev.task_id !== "string") return [];
    if (ev.subtype === "task_started" && ev.task_type === "local_agent") return [{
      id: ev.task_id, parentId: typeof ev.parent_tool_use_id === "string" ? ev.parent_tool_use_id : null,
      kind: "child-started", text: clip(typeof ev.description === "string" ? ev.description : "Native Claude child started", 1000),
    }];
    if (ev.subtype === "task_notification" && ["completed", "failed", "stopped"].includes(ev.status) && typeof ev.tool_use_id === "string") return [{
      id: `${ev.task_id}:${ev.status}`, parentId: ev.task_id, kind: "child-completed",
      text: clip(`${ev.status}: ${typeof ev.summary === "string" ? ev.summary : "Native task finished"}`, 1000),
    }];
    return [];
  }
  const item = ev.item ?? ev.params?.item;
  if (!item) return [];
  if (["subAgentActivity", "sub_agent_activity"].includes(item.type) && typeof (item.agentThreadId ?? item.agent_thread_id) === "string") {
    const id = item.agentThreadId ?? item.agent_thread_id;
    if (!["started", "completed", "interrupted"].includes(item.kind)) return [];
    return [{ id: item.kind === "started" ? id : `${id}:${item.kind}`, parentId: item.kind === "started" ? ev.params?.threadId ?? null : id, kind: item.kind === "started" ? "child-started" : "child-completed", text: `Native Codex child ${item.agentPath ?? item.agent_path ?? id}: ${item.kind}` }];
  }
  if (!["collabAgentToolCall", "collab_agent_tool_call"].includes(item.type)) return [];
  const states = item.agentsStates ?? item.agents_states ?? {};
  const sender = item.senderThreadId ?? item.sender_thread_id;
  return Object.entries(states).flatMap(([id, raw]) => {
    if (!raw || typeof raw !== "object") return [];
    const status = (raw as Record<string, unknown>).status;
    const terminal = ["completed", "errored", "shutdown", "interrupted", "notFound"].includes(String(status));
    const spawn = ["spawnAgent", "spawn_agent"].includes(item.tool) && status === "running";
    if (!spawn && !terminal) return [];
    return [{ id: spawn ? id : `${id}:${status}`, parentId: spawn ? typeof sender === "string" ? sender : null : id, kind: spawn ? "child-started" as const : "child-completed" as const, text: `Native Codex child ${id}: ${status}; independent usage unknown` }];
  });
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
  const events = nativeEvents(runtime, ev);
  const observed = events.length ? { events } : {};

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
      const usage: ReportedUsage = {};
      const costUsd = metric(ev.total_cost_usd);
      const tokens = tokenCount(u.input_tokens, u.output_tokens, undefined, u.cache_creation_input_tokens);
      if (costUsd !== undefined) usage.costUsd = costUsd;
      if (tokens !== undefined) usage.tokens = tokens;
      return {
        logs,
        final: { ok, text, structured: ev.structured_output, error: ok ? undefined : `${ev.subtype}: ${clip(text)}` },
        ...(Object.keys(usage).length ? { usage } : {}),
      };
    }
    return { logs, ...observed };
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
    const cumulativeTokens = tokenCount(u.input_tokens, u.output_tokens, u.cached_input_tokens);
    return { logs, ...(cumulativeTokens !== undefined ? { usage: { cumulativeTokens } } : {}) };
  }
  if (ev.type === "error") logs.push({ kind: "error", text: ev.message ?? "error" });
  if (ev.type === "turn.failed") {
    const msg = ev.error?.message ?? "turn failed";
    logs.push({ kind: "error", text: msg });
    return { logs, final: { ok: false, text: "", error: msg } };
  }
  return { logs, ...observed };
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
  const cost = runtime === "claude-code" ? metric(reported.costUsd) : undefined;
  const cumulative = metric(reported.cumulativeTokens);
  const tokens = metric(reported.tokens);
  const sessionCost = cost ?? prev.costUsd;
  const sessionTokens = cumulative ?? prev.tokens + (tokens ?? 0);
  const hasTokens = cumulative !== undefined || tokens !== undefined;
  const knownTokens = tokens !== undefined || cumulative !== undefined && !previous?.usageUnknown?.tokens;
  const knownCost = cost !== undefined && !previous?.usageUnknown?.cost;
  const usage: Usage | undefined = cost !== undefined || hasTokens ? {
    costUsd: knownCost ? Math.max(0, sessionCost - prev.costUsd) : null,
    tokens: knownTokens ? Math.max(0, sessionTokens - prev.tokens) : 0,
    ...(!knownTokens ? { tokensReported: false as const } : {}),
  } : undefined;
  const usageUnknown: NonNullable<Session["usageUnknown"]> = {};
  if (!hasTokens || cumulative === undefined && previous?.usageUnknown?.tokens) usageUnknown.tokens = true;
  if (runtime === "claude-code" && cost === undefined) usageUnknown.cost = true;
  const session: Session | undefined = sessionId ? { id: sessionId, costUsd: sessionCost, tokens: sessionTokens, ...(Object.keys(usageUnknown).length ? { usageUnknown } : {}) } : undefined;
  return { usage, session };
}

/** Small JSON-RPC seam shared by the live adapter and protocol tests. It never opens a socket. */
export function codexRpc(send: (message: object) => void, notify: (message: any) => void) {
  let sequence = 0;
  let closed: Error | null = null;
  const pending = new Map<number, { resolve: (value: any) => void; reject: (error: Error) => void }>();
  return {
    request(method: string, params: object = {}): Promise<any> {
      if (closed) return Promise.reject(closed);
      const id = ++sequence;
      return new Promise((resolve, reject) => {
        pending.set(id, { resolve, reject });
        try { send({ id, method, params }); } catch (error) { pending.delete(id); reject(error); }
      });
    },
    receive(message: any) {
      if (typeof message.id === "number" && !message.method) {
        const entry = pending.get(message.id);
        if (!entry) return;
        pending.delete(message.id);
        if (message.error) entry.reject(new Error(typeof message.error.message === "string" ? message.error.message : "Codex protocol request failed"));
        else entry.resolve(message.result);
      } else if (typeof message.method === "string" && message.id !== undefined) {
        // Never let an unattended adapter hang waiting for interactive approvals or tool input.
        if (["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(message.method)) send({ id: message.id, result: { decision: "decline" } });
        else send({ id: message.id, error: { code: -32601, message: "Orchestra does not handle interactive requests" } });
      } else notify(message);
    },
    close(error = new Error("Codex app-server connection closed")) {
      closed = error;
      for (const entry of pending.values()) entry.reject(error);
      pending.clear();
    },
  };
}

type AppServerProcess = {
  pid: number; stdin: { write: (chunk: string) => unknown; end: () => unknown };
  stdout: ReadableStream<Uint8Array>; stderr: ReadableStream<Uint8Array>; exited: Promise<number>; kill: (signal?: "SIGKILL") => unknown;
};
const spawnAppServer = (argv: string[], cwd: string): AppServerProcess => {
  const options = { cwd, stdin: "pipe", stdout: "pipe", stderr: "pipe", detached: true } as const;
  return Bun.spawn(argv, options as Omit<typeof options, "detached">);
};

/** Stable stdio app-server protocol: https://learn.chatgpt.com/docs/app-server */
export async function runCodexAppServer(inv: AgentInvocation, spawn = spawnAppServer): Promise<AgentResult> {
  const timeoutMs = inv.timeoutMs ?? AGENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { ok: false, text: "", error: "Invalid agent timeout" };
  if (inv.agent.runtime !== "codex") return { ok: false, text: "", error: "App-server transport is supported only by Codex" };
  if (inv.resume && !SESSION_ID.test(inv.resume.id)) return { ok: false, text: "", error: "Invalid Codex session id" };
  if (inv.agent.effort && !EFFORTS.codex.includes(inv.agent.effort)) return { ok: false, text: "", error: "Invalid Codex effort" };
  const children = inv.maxNativeChildren ?? 2;
  if (!Number.isInteger(children) || children < 1 || children > 6) return { ok: false, text: "", error: "Native concurrency must be between 1 and 6" };
  const enabled = !!inv.nativeDelegation;
  const argv = ["codex", "app-server", "-c", `agents.enabled=${enabled}`, "-c", `features.multi_agent=${enabled}`,
    "-c", "features.multi_agent_v2=false", "-c", `agents.max_concurrent_threads_per_session=${children}`, "-c", `agents.max_threads=${children}`];
  const proc = spawn(argv, inv.cwd);
  const stderr = new Response(proc.stderr).text();
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = inv.signal ? AbortSignal.any([inv.signal, timeout]) : timeout;
  const send = (message: object) => { proc.stdin.write(`${JSON.stringify(message)}\n`); };
  let threadId = inv.resume?.id;
  let turnId: string | undefined;
  let text = "";
  let finished = false;
  const reported: ReportedUsage = {};
  let settle!: (result: AgentResult) => void;
  const completion = new Promise<AgentResult>((resolve) => { settle = resolve; });
  const finish = (result: AgentResult) => { if (!finished) { finished = true; settle(result); } };
  const isChild = childEventFilter();
  const rpc = codexRpc(send, (message) => {
    const params = message.params ?? {};
    if (threadId && params.threadId && params.threadId !== threadId) return;
    if (message.method === "turn/started" && typeof params.turn?.id === "string") turnId = params.turn.id;
    if (message.method === "thread/tokenUsage/updated") {
      const u = params.tokenUsage?.total;
      const cumulativeTokens = u ? tokenCount(u.inputTokens, u.outputTokens, u.cachedInputTokens) : undefined;
      if (cumulativeTokens !== undefined) reported.cumulativeTokens = cumulativeTokens;
    }
    if (message.method === "item/completed") {
      const item = params.item ?? {};
      if (item.type === "agentMessage" && typeof item.text === "string") { text = item.text; inv.onLog("text", item.text); }
      if (item.type === "commandExecution") inv.onLog("tool", `$ ${clip(item.command ?? "", 200)} → exit ${item.exitCode ?? "?"}`);
      if (item.type === "fileChange") inv.onLog("tool", `edit ${(item.changes ?? []).map((change: any) => change.path).join(", ")}`);
    }
    if (["item/started", "item/completed"].includes(message.method)) for (const event of nativeEvents("codex", message)) if (isChild(event)) inv.onEvent?.({ ...event, parentId: event.parentId === threadId ? null : event.parentId });
    if (message.method === "turn/completed" && (!turnId || params.turn?.id === turnId)) {
      const ok = params.turn?.status === "completed";
      finish(structuredResult({ ok, text, ...(ok ? {} : { error: params.turn?.error?.message ?? `Codex turn ${params.turn?.status ?? "failed"}` }) }, inv.schema));
    }
    if (message.method === "error" && !params.willRetry) finish({ ok: false, text, error: params.error?.message ?? "Codex app-server failed" });
  });
  const kill = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
  };
  const abort = () => {
    const error = new Error(inv.signal?.aborted ? "cancelled" : `timed out after ${timeoutMs / 60_000} minutes`);
    rpc.close(error); finish({ ok: false, text, error: error.message }); kill();
  };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const pump = (async () => {
    try {
      for await (const line of lines(proc.stdout)) {
        let message: unknown;
        try { message = JSON.parse(line); } catch { continue; }
        rpc.receive(message);
      }
      if (!finished) {
        const error = new Error("Codex app-server exited before completing its turn");
        rpc.close(error); finish({ ok: false, text, error: error.message });
      }
    } catch (error) {
      rpc.close(error as Error); finish({ ok: false, text, error: (error as Error).message });
    }
  })();
  try {
    if (enabled) inv.onLog("system", `Native Codex delegation enabled with ${children} concurrent children. Child calls and usage are not independently metered; Orchestra's call budget counts outer invocations.`);
    await rpc.request("initialize", { clientInfo: { name: "orchestra", title: "Orchestra", version: "0.1.0" } });
    send({ method: "initialized", params: {} });
    const config = { "agents.enabled": enabled, "features.multi_agent": enabled, "features.multi_agent_v2": false,
      "agents.max_concurrent_threads_per_session": children, "agents.max_threads": children, "sandbox_workspace_write.network_access": inv.mode === "worker" };
    const thread = await rpc.request(inv.resume ? "thread/resume" : "thread/start", {
      ...(inv.resume ? { threadId: inv.resume.id } : {}), cwd: inv.cwd, model: inv.agent.model,
      approvalPolicy: "never", sandbox: inv.mode === "worker" ? "workspace-write" : "read-only", config,
    });
    if (!SESSION_ID.test(thread.thread?.id)) throw new Error("Codex app-server returned an invalid thread id");
    threadId = thread.thread.id;
    inv.onLog("system", "Codex app-server session started");
    const started = await rpc.request("turn/start", {
      threadId, input: [{ type: "text", text: inv.prompt }],
      ...(inv.agent.effort ? { effort: inv.agent.effort } : {}), ...(inv.schema ? { outputSchema: inv.schema } : {}),
      sandboxPolicy: inv.mode === "worker" ? { type: "workspaceWrite", writableRoots: [inv.cwd], networkAccess: true } : { type: "readOnly", networkAccess: false },
    });
    turnId = started.turn?.id ?? turnId;
    if (!finished && turnId) inv.onControl?.({
      steer: async (guidance) => {
        if (finished) throw new Error("Codex turn has finished");
        await rpc.request("turn/steer", { threadId, expectedTurnId: turnId, input: [{ type: "text", text: guidance }] });
      },
      interrupt: async () => { if (!finished) await rpc.request("turn/interrupt", { threadId, turnId }); },
    });
    const result = await completion;
    return { ...result, ...settleUsage("codex", inv.resume, threadId, reported) };
  } catch (error) {
    return { ok: false, text, error: (error as Error).message, ...settleUsage("codex", inv.resume, threadId, reported) };
  } finally {
    signal.removeEventListener("abort", abort);
    inv.onControl?.(null);
    rpc.close();
    try { proc.stdin.end(); } catch { /* A failed server can close stdin before cleanup. */ }
    kill();
    await Promise.all([pump, proc.exited, stderr]);
  }
}

export const runAgent: RunAgent = async (inv) => {
  const timeoutMs = inv.timeoutMs ?? AGENT_TIMEOUT_MS;
  if (!Number.isInteger(timeoutMs) || timeoutMs <= 0 || timeoutMs > 2_147_483_647) return { ok: false, text: "", error: "Invalid agent timeout" };
  if (inv.transport === "app-server") {
    if (inv.agent.runtime !== "codex") return { ok: false, text: "", error: "App-server transport is supported only by Codex" };
    return runCodexAppServer(inv);
  }
  if (inv.nativeDelegation) return { ok: false, text: "", error: "Native delegation requires the Codex app-server adapter; batch child usage cannot be controlled independently" };
  const { runtime, model, effort } = inv.agent;
  const tmp = await mkdtemp(join(tmpdir(), "orchestra-"));
  try {
    const schemaPath = join(tmp, "schema.json");
    const lastMessagePath = join(tmp, "last-message.txt");
    if (inv.schema) await Bun.write(schemaPath, JSON.stringify(inv.schema));
    // Claude takes the id we choose for a new session; Codex announces its thread id on stdout.
    const session = inv.resume
      ? { id: inv.resume.id, resume: true }
      : runtime === "claude-code" ? { id: crypto.randomUUID(), resume: false } : undefined;
    const argv = buildArgs({ runtime, mode: inv.mode, cwd: inv.cwd, model, effort, schema: inv.schema, schemaPath, lastMessagePath, session, delegation: "disabled" });

    const timeout = AbortSignal.timeout(timeoutMs);
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
    const isChild = childEventFilter();
    for await (const line of lines(proc.stdout)) {
      const parsed = parseLine(runtime, line);
      for (const l of parsed.logs) inv.onLog(l.kind, l.text);
      for (const event of parsed.events ?? []) if (isChild(event)) inv.onEvent?.(event);
      if (parsed.final) final = parsed.final;
      if (parsed.sessionId && SESSION_ID.test(parsed.sessionId)) sessionId = parsed.sessionId;
      Object.assign(reported, parsed.usage);
    }
    const code = await proc.exited;
    signal.removeEventListener("abort", kill);
    const settled = settleUsage(runtime, inv.resume, sessionId, reported);

    if (inv.signal?.aborted) return { ok: false, text: "", error: "cancelled", ...settled };
    if (timeout.aborted) return { ok: false, text: "", error: `timed out after ${timeoutMs / 60_000} minutes`, ...settled };
    if (runtime === "codex" && !final) {
      const last = Bun.file(lastMessagePath);
      final = { ok: true, text: (await last.exists()) ? await last.text() : "" };
    }
    if (code !== 0 || !final) {
      const tail = (await stderr).trim().split("\n").slice(-5).join("\n");
      const error = final?.error ?? `${BINARIES[runtime]} exited with code ${code}${tail ? `: ${tail}` : ""}`;
      return { ok: false, text: final?.text ?? "", error, ...settled };
    }
    return structuredResult({ ...final, ...settled }, inv.schema);
  } finally {
    await rm(tmp, { recursive: true, force: true });
  }
};

/** Detection only proves a CLI is installed; one tiny read-only call shows it is also signed in. */
export const PROBE_TIMEOUT_MS = 90_000;

export async function probeAgent(run: RunAgent, agent: Agent): Promise<ProbeResult> {
  const cwd = await mkdtemp(join(tmpdir(), "orchestra-probe-"));
  const signal = AbortSignal.timeout(PROBE_TIMEOUT_MS);
  const started = Date.now();
  try {
    const res = await run({ agent, mode: "readonly", prompt: "Reply with the single word OK.", cwd, onLog: () => {}, signal });
    const error = res.ok ? null : signal.aborted ? `no answer within ${PROBE_TIMEOUT_MS / 1000} seconds` : (res.error ?? "agent failed");
    return { ok: res.ok, ms: Date.now() - started, error, usage: res.usage ?? null };
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
}

/** Quota is account-wide, not derived from this run's token counts. */
export function parseQuota(runtime: Runtime, raw: unknown): import("../shared/types.ts").QuotaWindow[] {
  const result: import("../shared/types.ts").QuotaWindow[] = [];
  const add = (window: "5h" | "weekly", usedPercent: unknown, resetsAt: unknown) => {
    if (typeof usedPercent !== "number" || !Number.isFinite(usedPercent) || usedPercent < 0 || usedPercent > 100 ||
        typeof resetsAt !== "number" || !Number.isFinite(resetsAt) || resetsAt <= 0) return;
    result.push({ window, usedPercent, resetsAt });
  };
  if (!raw || typeof raw !== "object") return result;
  const data = raw as Record<string, any>;
  if (runtime === "codex") {
    // Never assume primary means 5h: some subscriptions only have a weekly window.
    const snapshot = data.rateLimitsByLimitId?.codex ?? data.rateLimits;
    for (const value of [snapshot?.primary, snapshot?.secondary]) {
      const window = value?.windowDurationMins === 300 ? "5h" : value?.windowDurationMins === 10080 ? "weekly" : null;
      if (window) add(window, value.usedPercent, typeof value.resetsAt === "number" ? value.resetsAt * 1000 : null);
    }
  } else {
    for (const [key, window] of [["five_hour", "5h"], ["seven_day", "weekly"]] as const) {
      const value = data[key];
      add(window, value?.utilization, typeof value?.resets_at === "string" ? Date.parse(value.resets_at) : null);
    }
  }
  return result;
}

/** No inference calls. Credentials stay in this process and are never returned or logged. */
export async function readQuota(agent: Agent): Promise<import("../shared/types.ts").QuotaWindow[]> {
  if (agent.runtime === "codex") {
    const proc = Bun.spawn(["codex", "app-server"], { stdin: "pipe", stdout: "pipe", stderr: "ignore" });
    const timeout = setTimeout(() => proc.kill(), 15_000);
    try {
      const send = (message: object) => proc.stdin.write(JSON.stringify(message) + "\n");
      send({ id: 1, method: "initialize", params: { clientInfo: { name: "orchestra", version: "0.1.0" } } });
      for await (const line of lines(proc.stdout)) {
        let message: any;
        try { message = JSON.parse(line); } catch { continue; }
        if (message.id === 1) {
          if (message.error) break;
          send({ method: "initialized" });
          send({ id: 2, method: "account/rateLimits/read" });
        }
        if (message.id === 2) {
          if (message.error) break;
          return parseQuota("codex", message.result);
        }
      }
      throw new Error("Codex quota unavailable; sign in with a ChatGPT subscription");
    } finally {
      clearTimeout(timeout);
      proc.stdin.end();
      proc.kill();
      await proc.exited;
    }
  }
  if (process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN || process.env.CLAUDE_CODE_USE_BEDROCK || process.env.CLAUDE_CODE_USE_VERTEX || process.env.CLAUDE_CODE_USE_FOUNDRY) {
    throw new Error("Claude subscription quota is unavailable for API-key or cloud-provider authentication");
  }
  let credentials: any;
  try { credentials = await Bun.file(join(configDir("claude-code"), ".credentials.json")).json(); } catch { /* macOS uses Keychain. */ }
  if (process.platform === "darwin" && !process.env.CLAUDE_CONFIG_DIR) {
    const proc = Bun.spawn(["security", "find-generic-password", "-s", "Claude Code-credentials", "-w"], { stdout: "pipe", stderr: "ignore", stdin: "ignore" });
    const timeout = setTimeout(() => proc.kill(), 5000);
    try {
      const value = await new Response(proc.stdout).text();
      if (await proc.exited === 0) credentials = JSON.parse(value);
    } catch { /* Report unavailable below, never credential content. */ }
    finally { clearTimeout(timeout); }
  }
  const token = process.env.CLAUDE_CODE_OAUTH_TOKEN || credentials?.claudeAiOauth?.accessToken;
  if (typeof token !== "string" || !token) throw new Error("Claude quota unavailable; sign in with a Claude subscription");
  const response = await fetch("https://api.anthropic.com/api/oauth/usage", {
    headers: { Authorization: `Bearer ${token}`, "anthropic-beta": "oauth-2025-04-20" },
    signal: AbortSignal.timeout(15_000),
    redirect: "error",
  });
  if (!response.ok) throw new Error(`Claude quota unavailable (HTTP ${response.status}); refresh your CLI login`);
  return parseQuota("claude-code", await response.json());
}
