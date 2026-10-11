import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { RUNTIMES, type Agent } from "../src/shared/types.ts";
import { headCommit, prepareWorkspace } from "../src/server/git.ts";
import { runAgent } from "../src/server/runtimes.ts";

const [runtime = "codex", model] = process.argv.slice(2);
if (!RUNTIMES.some((r) => r === runtime)) throw new Error("Usage: bun run test:runtime [codex|claude-code] [model]");
if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new Error("Invalid model name");
const cwd = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-runtime-smoke-")));
const agent: Agent = { id: "smoke", name: "Smoke", runtime: runtime as Agent["runtime"], model: model ?? null, effort: null,
  role: "Engineer", expertise: "", skills: [], instructions: null, createdAt: 0 };
const signal = AbortSignal.timeout(180_000);
const onLog = (kind: string, text: string) => { if (kind === "error") console.error(text); };

try {
  const { baseCommit } = await prepareWorkspace(cwd);
  console.log(`${runtime}: testing worker, session resume and read-only structured output in ${cwd}`);
  const first = await runAgent({ agent, mode: "worker", cwd, signal, onLog,
    prompt: "Create probe.txt containing exactly ONE followed by a newline. Do not commit. Reply only DONE." });
  if (!first.ok || !first.session) throw new Error(first.error ?? "Worker returned no session");
  if (await Bun.file(join(cwd, "probe.txt")).text() !== "ONE\n") throw new Error("Worker did not create expected contents");
  console.log("Worker passed; session announced.");

  const second = await runAgent({ agent, mode: "worker", cwd, signal, onLog, resume: first.session,
    prompt: "Replace probe.txt contents with exactly TWO followed by a newline. Do not commit. Reply only DONE." });
  if (!second.ok || second.session?.id !== first.session.id) throw new Error(second.error ?? "Resume changed or lost session");
  if (await Bun.file(join(cwd, "probe.txt")).text() !== "TWO\n") throw new Error("Resumed worker did not edit file");
  console.log(`Resume passed; ${second.usage?.tokens ?? 0} additional tokens reported.`);

  const third = await runAgent({ agent, mode: "readonly", cwd, signal, onLog,
    prompt: "Read probe.txt. Return its trimmed contents in the value field. Do not edit files.",
    schema: { type: "object", properties: { value: { type: "string" } }, required: ["value"], additionalProperties: false } });
  if (!third.ok) throw new Error(third.error ?? "Read-only invocation failed");
  const answer = third.structured ?? JSON.parse(third.text);
  if (answer.value !== "TWO") throw new Error("Read-only structured answer was incorrect");
  if (await Bun.file(join(cwd, "probe.txt")).text() !== "TWO\n" || await headCommit(cwd) !== baseCommit) {
    throw new Error("Probe file or git HEAD changed unexpectedly");
  }
  console.log("PASS: worker, resume, schema and unchanged git HEAD.");
} finally {
  rmSync(cwd, { recursive: true, force: true });
}
