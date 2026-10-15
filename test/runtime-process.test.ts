import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Runtime } from "../src/shared/types.ts";
import type { AgentResult } from "../src/server/runtimes.ts";

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
if (prompt === "wait") { console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"})); setInterval(() => {}, 1000); await new Promise(() => {}); }
else if (prompt === "children") {
  const child = Bun.spawn(["sh", "-c", "sleep 30"], { stdout: "inherit", stderr: "inherit" });
  await Bun.write("child.pid", String(child.pid));
  console.log(JSON.stringify({type:"thread.started",thread_id:"${sid}"}));
  await child.exited;
}
else if (prompt === "stderr") { console.error("diagnostic from CLI"); process.exit(3); }
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
const [runtime, cwd, prompt, resume, cancel] = process.argv.slice(2);
if (Bun.which(runtime === "codex" ? "codex" : "claude") !== ${JSON.stringify(bin)} + "/" + (runtime === "codex" ? "codex" : "claude")) throw new Error("Fixture binary was not selected");
const logs = [];
const result = await runAgent({ agent: {id:"a",name:"A",runtime,model:null,effort:null,role:"Engineer",skills:"",instructions:null,createdAt:0},
  mode:"readonly", cwd, prompt, schema:{type:"object"},
  resume: resume === "true" ? {id:"${sid}",costUsd:0.5,tokens:50} : undefined,
  signal: cancel === "true" ? AbortSignal.timeout(300) : undefined, onLog: (kind, text) => logs.push({kind,text}) });
console.log(JSON.stringify({result,logs}));
`);
async function invoke(runtime: Runtime, prompt: string, resume = false, cancel = false) {
  const cwd = join(root, `case-${sequence++}`);
  mkdirSync(cwd);
  const proc = Bun.spawn([process.execPath, harness, runtime, cwd, prompt, String(resume), String(cancel)],
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

/** A killed process nobody reaps stays a zombie (common in containers whose PID 1 doesn't reap), and `kill(pid, 0)` still finds it. */
function running(pid: number) {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    return readFileSync(`/proc/${pid}/stat`, "utf8").split(") ")[1]?.[0] !== "Z";
  } catch {
    return true;
  }
}
