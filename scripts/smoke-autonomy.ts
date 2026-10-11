import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DIRECTOR_ROLE, RUNTIMES, type Runtime } from "../src/shared/types.ts";
import { DEMO_LIMITS, DEMO_PROMPT, describeDemoResult } from "../src/shared/demo.ts";
import { openDb } from "../src/server/db.ts";
import { headCommit } from "../src/server/git.ts";
import { runAgent } from "../src/server/runtimes.ts";
import { createScheduler } from "../src/server/scheduler.ts";

const [runtime = "codex", model] = process.argv.slice(2);
if (!RUNTIMES.includes(runtime as Runtime)) throw new Error("Usage: bun run test:autonomy [codex|claude-code] [model]");
if (model && !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]*$/.test(model)) throw new Error("Invalid model name");
const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-autonomy-smoke-")));
const db = openDb(join(root, "orchestra.db"));
const [director, ...members] = [["Director", DIRECTOR_ROLE], ["Engineer", "Engineer"], ["QA", "QA"]].map(([name, role]) =>
  db.createAgent({ name: name!, role: role!, runtime: runtime as Runtime, model: model ?? null, expertise: "Bun and TypeScript", skills: [], instructions: null }));
const team = db.createTeam({ name: "Demo team", directorId: director!.id, memberIds: members.map((m) => m.id) });
const scheduler = createScheduler({
  db, runAgent, worktreeRoot: join(root, "worktrees"),
  publish: (_, event) => {
    if (event.type === "log" && ["system", "error"].includes(event.log.kind)) console.log(event.log.text);
    if (event.type === "run") console.log(`[${event.run.status}] cycle ${event.run.cycle}, ${event.run.agentCalls} calls`);
  },
});
const run = await scheduler.startRun({
  teamId: team.id, workdir: join(root, "project"), autonomous: true, continuous: true,
  limits: { ...DEMO_LIMITS },
  prompt: DEMO_PROMPT,
});
while (!["completed", "paused", "failed"].includes(db.getRun(run.id)!.status)) await Bun.sleep(250);
await scheduler.waitForCleanup();
const final = db.getRun(run.id)!;
const tasks = db.listTasks(run.id);
const graph = Bun.spawnSync(["git", "log", "--oneline", "--graph", run.branch], { cwd: run.workdir });
console.log(graph.stdout.toString());
console.log(`Scratch project and checkpoints retained at ${root}`);
const shellQuote = (value: string) => "'" + value.replaceAll("'", "'\"'\"'") + "'";
console.log(`Open this saved run in a separate Orchestra UI:\nORCHESTRA_HOME=${shellQuote(root)} PORT=4322 bun run dev\nThen open http://127.0.0.1:4322/#/runs/${run.id}`);
try {
  if (await headCommit(run.workdir) !== run.baseCommit) throw new Error("User checkout changed");
  console.log(describeDemoResult(final, tasks));
} finally {
  db.close();
}
