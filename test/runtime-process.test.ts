import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../src/shared/types.ts";
import type { AgentResult } from "../src/server/runtimes.ts";
import { handoffJsonSchema, workerHandoff } from "../src/server/handoff.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-runtime-test-")));
const bin = join(root, "bin");
mkdirSync(bin);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const sid = "11111111-2222-4333-8444-555555555555";

// Exercise the real process/stream adapter without calling agent CLIs or a model.
const fixture = `#!${process.execPath}
const args = process.argv.slice(2);
const prompt = await Bun.stdin.text();
await Bun.write("invocation.json", JSON.stringify({ args, prompt, cwd: process.cwd(),
  schema: args.includes("--output-schema") ? JSON.parse(await Bun.file(args[args.indexOf("--output-schema") + 1]).text()) : null }));
if (prompt === "timeout") {
  await Bun.write("agent.pid", String(process.pid));
  const child = Bun.spawn(["sh", "-c", "sleep 30"], { stdout: "inherit", stderr: "inherit" });
  await Bun.write("child.pid", String(child.pid));
  if (args.includes("--output-format")) {
    console.log(JSON.stringify({type:"system",subtype:"init",session_id:"${sid}"}));
    console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"partial",total_cost_usd:0.7,usage:{input_tokens:10,output_tokens:5}}));
  } else {
    console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
    console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5}}));
  }
  await child.exited;
}
else if (prompt === "wait") { console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"})); setInterval(() => {}, 1000); await new Promise(() => {}); }
else if (prompt === "children") {
  const child = Bun.spawn(["sh", "-c", "sleep 30"], { stdout: "inherit", stderr: "inherit" });
  await Bun.write("child.pid", String(child.pid));
  console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
  await child.exited;
}
else if (prompt === "stderr") { console.error("diagnostic from CLI"); process.exit(3); }
else if (["no-usage", "empty-usage", "zero-usage", "cost-only", "partial-usage"].includes(prompt)) {
  const usage = prompt === "zero-usage" ? {input_tokens:0,output_tokens:0} : prompt === "empty-usage" ? {} : prompt === "partial-usage" ? {input_tokens:10} : undefined;
  if (args.includes("--output-format")) {
    console.log(JSON.stringify({type:"system",subtype:"init",session_id:"${sid}"}));
    console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:JSON.stringify({summary:"done"}),usage,
      ...(prompt === "zero-usage" ? {total_cost_usd:0} : ["cost-only", "partial-usage"].includes(prompt) ? {total_cost_usd:0.7} : {})}));
  } else {
    console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
    console.log(JSON.stringify({type:"turn.completed",usage}));
    await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({summary:"done"}));
  }
}
else if (["handoff", "invalid-claim", "malformed-schema"].includes(prompt)) {
  const payload = {summary:"Delivered",decisions:["Keep the interface"],interfaces:["src/ui.tsx"],blockers:[],verified:["Focused browser check"],skillIds:[prompt === "invalid-claim" ? "owner/repo/unassigned" : "owner/repo/frontend"]};
  const text = prompt === "malformed-schema" ? "not JSON" : JSON.stringify(payload);
  if (args.includes("--output-format")) {
    console.log(JSON.stringify({type:"system",subtype:"init",session_id:"${sid}"}));
    console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:text,total_cost_usd:0.7,usage:{input_tokens:10,output_tokens:5}}));
  } else {
    console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
    console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5}}));
    await Bun.write(args[args.indexOf("-o")+1], text);
  }
}
else if (args.includes("--output-format")) {
  console.log(JSON.stringify({type:"system",subtype:"init",session_id:"${sid}"}));
  console.log(JSON.stringify({type:"result",subtype:"success",is_error:false,result:"done",structured_output:{verdict:"approve",findings:""},total_cost_usd:0.7,usage:{input_tokens:10,output_tokens:5}}));
} else {
  const line = Buffer.from(JSON.stringify({type:"item.completed",item:{type:"agent_message",text:"café"}}) + "\\n");
  const split = line.indexOf(Buffer.from("é")) + 1;
  process.stdout.write(line.subarray(0, split));
  await Bun.sleep(10);
  process.stdout.write(line.subarray(split));
  console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
  console.log(JSON.stringify({type:"turn.completed",usage:{input_tokens:100,cached_input_tokens:20,output_tokens:5}}));
  if (prompt === "failed") console.log(JSON.stringify({type:"turn.failed",error:{message:"rate limited"}}));
  else await Bun.write(args[args.indexOf("-o")+1], JSON.stringify({value:"café"}));
  if (prompt === "nonzero") process.exit(2);
}
`;
for (const name of ["codex", "claude"]) {
  const file = join(bin, name);
  writeFileSync(file, fixture);
  chmodSync(file, 0o755);
}
let sequence = 0;
const harness = join(root, "harness.ts");
writeFileSync(harness, `
import { runAgent } from ${JSON.stringify(new URL("../src/server/runtimes.ts", import.meta.url).pathname)};
import { handoffJsonSchema } from ${JSON.stringify(new URL("../src/server/handoff.ts", import.meta.url).pathname)};
const [runtime, cwd, prompt, resume, cancel, timeout, mode] = process.argv.slice(2);
if (Bun.which(runtime === "codex" ? "codex" : "claude") !== ${JSON.stringify(bin)} + "/" + (runtime === "codex" ? "codex" : "claude")) throw new Error("Fixture binary was not selected");
const logs = [];
const result = await runAgent({ agent: {id:"a",name:"A",runtime,model:null,effort:null,role:"Engineer",expertise:"",skills:[],instructions:null,createdAt:0},
  mode, cwd, prompt, schema: ["handoff", "invalid-claim", "malformed-schema"].includes(prompt) ? handoffJsonSchema : {type:"object"},
  resume: resume === "true" ? {id:"${sid}",costUsd:0.5,tokens:50} : undefined,
  signal: cancel === "true" ? AbortSignal.timeout(300) : timeout ? AbortSignal.timeout(3000) : undefined, timeoutMs: timeout ? Number(timeout) : undefined,
  onLog: (kind, text) => logs.push({kind,text}) });
console.log(JSON.stringify({result,logs}));
`);
async function invoke(runtime: Runtime, prompt: string, resume = false, cancel = false, timeoutMs?: number, mode: "readonly" | "worker" = "readonly") {
  const cwd = join(root, `case-${sequence++}`);
  mkdirSync(cwd);
  const proc = Bun.spawn([process.execPath, harness, runtime, cwd, prompt, String(resume), String(cancel), timeoutMs === undefined ? "" : String(timeoutMs), mode],
    { env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stdout: "pipe", stderr: "pipe" });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(err);
  const { result, logs } = JSON.parse(out) as { result: AgentResult; logs: { kind: string; text: string }[] };
  const captured = JSON.parse(await Bun.file(join(cwd, "invocation.json")).text());
  return { result, logs, captured, cwd };
}

test("Codex process receives stdin EOF, cwd and schema; split UTF-8 JSONL and final file survive", async () => {
  const { result, logs, captured, cwd } = await invoke("codex", "schema");
  expect(captured).toMatchObject({ prompt: "schema", cwd, schema: { type: "object" } });
  expect(logs).toContainEqual({ kind: "text", text: "café" });
  expect(result).toMatchObject({ ok: true, text: '{"value":"café"}', session: { id: sid, tokens: 85 }, usage: { costUsd: null, tokens: 85 } });
  expect(result.structured).toEqual({ value: "café" });
  expect(await Bun.file(captured.args[captured.args.indexOf("-o") + 1]).exists()).toBe(false);
});

test("Codex resume preserves argv and settles cumulative usage once", async () => {
  const { result, captured } = await invoke("codex", "resume", true);
  expect(captured.args.slice(0, 3)).toEqual(["exec", "resume", sid]);
  expect(captured.args).toContain('sandbox_mode="read-only"');
  expect(result.usage).toEqual({ costUsd: null, tokens: 35 });
});

test("Claude process returns structured output and invocation usage on resume", async () => {
  const { result, captured } = await invoke("claude-code", "review", true);
  expect(captured.args).toContain("--resume");
  expect(result.structured).toEqual({ verdict: "approve", findings: "" });
  expect(result.usage?.costUsd).toBeCloseTo(0.2);
  expect(result.usage?.tokens).toBe(15);
  expect(result.session?.tokens).toBe(65);
});

for (const runtime of ["codex", "claude-code"] as const) {
  test(`${runtime} batch worker JSON handoffs are normalized and validated for fresh and resumed sessions`, async () => {
    for (const resume of [false, true]) {
      const { result, captured } = await invoke(runtime, "handoff", resume, false, undefined, "worker");
      expect(result).toMatchObject({ ok: true, structured: { summary: "Delivered", interfaces: ["src/ui.tsx"], skillIds: ["owner/repo/frontend"] }, session: { id: sid } });
      expect(workerHandoff(result, ["owner/repo/frontend"])).toMatchObject({ text: "Delivered", details: { decisions: ["Keep the interface"], skillIds: ["owner/repo/frontend"] } });
      if (runtime === "codex") expect(captured.schema).toEqual(handoffJsonSchema);
      else expect(JSON.parse(captured.args[captured.args.indexOf("--json-schema") + 1])).toEqual(handoffJsonSchema);
      if (resume) expect(captured.args).toContain(runtime === "codex" ? "resume" : "--resume");
    }
    const invalidClaim = await invoke(runtime, "invalid-claim", false, false, undefined, "worker");
    expect(() => workerHandoff(invalidClaim.result, ["owner/repo/frontend"])).toThrow("outside its assigned skill pack");
  });

  test(`${runtime} malformed schema output fails while retaining resumed usage and session`, async () => {
    const { result } = await invoke(runtime, "malformed-schema", true, false, undefined, "worker");
    expect(result).toMatchObject({ ok: false, text: "not JSON", error: "Agent returned invalid JSON for the requested structured output schema", session: { id: sid, tokens: runtime === "codex" ? 85 : 65 }, usage: { tokens: runtime === "codex" ? 35 : 15 } });
    if (runtime === "claude-code") expect(result.usage?.costUsd).toBeCloseTo(0.2);
  });
}

for (const runtime of ["codex", "claude-code"] as const) {
  test(`${runtime} real adapter retains unknown missing/empty metrics without resetting session totals`, async () => {
    for (const prompt of ["no-usage", "empty-usage"]) {
      const { result } = await invoke(runtime, prompt, true);
      expect(result.ok).toBe(true);
      expect(result.usage).toBeUndefined();
      expect(result.session).toMatchObject({ id: sid, costUsd: 0.5, tokens: 50, usageUnknown: { tokens: true } });
    }
    const zero = (await invoke(runtime, "zero-usage")).result;
    expect(zero.usage).toEqual({ costUsd: runtime === "codex" ? null : 0, tokens: 0 });
  });
}

test("Claude real adapter reports known cost without inventing a token count", async () => {
  for (const prompt of ["cost-only", "partial-usage"]) {
    const { result } = await invoke("claude-code", prompt);
    expect(result.usage).toEqual({ costUsd: 0.7, tokens: 0, tokensReported: false });
    expect(result.session).toMatchObject({ usageUnknown: { tokens: true } });
  }
  expect((await invoke("codex", "partial-usage")).result.usage).toBeUndefined();
});

test("Codex failure events are failures even when the CLI exits zero", async () => {
  expect((await invoke("codex", "failed")).result).toMatchObject({ ok: false, error: "rate limited" });
});

test("nonzero exits cannot be accepted just because a final file exists", async () => {
  expect((await invoke("codex", "nonzero")).result).toMatchObject({ ok: false, error: "codex exited with code 2" });
});

test("CLI startup diagnostics reach the caller", async () => {
  expect((await invoke("claude-code", "stderr")).result).toMatchObject({ ok: false, error: "claude exited with code 3: diagnostic from CLI" });
});

test("cancellation stops the process and preserves an announced session", async () => {
  expect((await invoke("codex", "wait", false, true)).result).toMatchObject({ ok: false, error: "cancelled", session: { id: sid } });
});


test("cancellation terminates agent subprocess descendants and closes inherited streams", async () => {
  const started = Date.now();
  const { result, cwd } = await invoke("codex", "children", false, true);
  expect(result).toMatchObject({ ok: false, error: "cancelled" });
  expect(Date.now() - started).toBeLessThan(5000);
  const child = Number(await Bun.file(join(cwd, "child.pid")).text());
  let alive = true;
  for (let i = 0; i < 50 && alive; i++) {
    alive = running(child);
    if (alive) await Bun.sleep(10);
  }
  expect(alive).toBe(false);
});

for (const runtime of ["codex", "claude-code"] as const) {
  test(`${runtime} custom timeout kills the process group and settles reported usage and session once`, async () => {
    const started = Date.now();
    const { result, cwd } = await invoke(runtime, "timeout", true, false, 500);
    expect(result.ok).toBe(false);
    expect(result.error).toContain("timed out");
    expect(result.session?.id).toBe(sid);
    expect(result.usage?.tokens).toBe(runtime === "codex" ? 35 : 15);
    expect(result.session?.tokens).toBe(runtime === "codex" ? 85 : 65);
    if (runtime === "claude-code") expect(result.usage?.costUsd).toBeCloseTo(0.2);
    else expect(result.usage?.costUsd).toBeNull();
    expect(Date.now() - started).toBeLessThan(5000);
    for (const name of ["agent.pid", "child.pid"]) {
      const pid = Number(await Bun.file(join(cwd, name)).text());
      for (let attempt = 0; attempt < 50 && running(pid); attempt++) await Bun.sleep(10);
      expect(running(pid)).toBe(false);
    }
  });
}

/** Containers may leave killed children as zombies, which `kill(pid, 0)` still finds. */
function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(") ") + 2)[0] !== "Z";
  } catch {
    return true;
  }
}
