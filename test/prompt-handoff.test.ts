import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import type { Plan } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { createScheduler } from "../src/server/scheduler.ts";

test("dependent workers get compact evidence while saved handoffs retain the full text and checked revisions", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-prompt-")));
  const db = openDb(":memory:");
  const agent = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
  const director = agent("Director", "Director");
  const engineer = agent("Engineer", "Engineer");
  const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [engineer.id] });
  const plan: Plan = {
    summary: "Build the foundation and its dependent feature", stage: "build", verify: "printf 'checked result'", lessons: "",
    tasks: ["foundation", "feature"].map((id, index) => ({ id, title: id, description: `Write ${id}.txt`, agentId: engineer.id, reviewerId: "", dependsOn: index ? ["foundation"] : [], acceptanceCriteria: `${id}.txt exists` })),
  };
  const handoff = `Foundation interface: foundation.txt\n${"detailed handoff ".repeat(3_000)}END OF SAVED HANDOFF`;
  let dependentPrompt = "";
  const scheduler = createScheduler({ db, worktreeRoot: join(root, "worktrees"), publish: () => {}, runAgent: async (invocation) => {
    if (invocation.mode === "readonly") return { ok: true, text: "", structured: invocation.prompt.includes("## Verification") ? { ...plan, summary: "Verified", stage: "fix", tasks: [] } : plan };
    const key = basename(invocation.cwd);
    if (key === "feature") dependentPrompt = invocation.prompt;
    await Bun.write(join(invocation.cwd, `${key}.txt`), key);
    return { ok: true, text: key === "foundation" ? handoff : "Feature complete" };
  } });
  try {
    const run = await scheduler.startRun({ teamId: team.id, prompt: "Build both pieces", workdir: join(root, "project"), autonomous: true });
    for (let attempt = 0; attempt < 600 && !["completed", "failed", "paused"].includes(db.getRun(run.id)!.status); attempt++) await Bun.sleep(10);
    expect(db.getRun(run.id)!.status).toBe("completed");
    const foundation = db.listTasks(run.id).find((task) => task.key === "foundation")!;
    expect(foundation.summary).toBe(handoff);
    expect(foundation.handoff?.text).toBe(handoff);
    expect(dependentPrompt).toContain("Foundation interface: foundation.txt");
    expect(dependentPrompt).not.toContain("END OF SAVED HANDOFF");
    expect(dependentPrompt.length).toBeLessThan(15_000);
    expect(dependentPrompt).toContain(`Merged commit: ${foundation.mergeCommit}`);
    expect(dependentPrompt).toContain(`"candidateCommit":"${foundation.handoff!.integration!.candidateCommit}"`);
    expect(dependentPrompt).toContain(`"baselineCommit":"${foundation.handoff!.integration!.baselineCommit}"`);
    expect(dependentPrompt).toContain('"producer":"orchestra:integration"');
    expect(dependentPrompt).toContain('"output":"checked result"');
  } finally {
    await scheduler.waitForCleanup();
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
