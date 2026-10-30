import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Plan } from "../src/shared/types.ts";
import { DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { runCheck } from "../src/server/checks.ts";
import { createScheduler } from "../src/server/scheduler.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-artifact-resume-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
async function wait(predicate: () => boolean) {
  for (let count = 0; count < 1000; count++) { if (predicate()) return; await Bun.sleep(5); }
  throw new Error("Artifact resume fixture did not settle");
}

for (const shared of [false, true]) for (const retained of [false, true]) {
  test(`acceptance resume ${retained ? "restores retained artifacts" : "reruns missing retained artifacts"}${shared ? " when the producer shares generic verification" : ""}`, async () => {
    const dir = join(root, `${shared}-${retained}`), worktreeRoot = join(dir, "worktrees");
    const db = openDb(":memory:");
    const make = (name: string, role: string) => db.createAgent({ name, role, runtime: "codex", model: null, effort: null, expertise: "", skills: [], instructions: null });
    const director = make("Director", DIRECTOR_ROLE), engineer = make("Engineer", "Engineer"), reviewer = make("Reviewer", "QA");
    const team = db.createTeam({ name: "Team", directorId: director.id, memberIds: [engineer.id, reviewer.id] });
    const producer = "mkdir -p evidence && printf 'retained artifact fixture' > evidence/desktop.png";
    const plan: Plan = { version: 2, summary: "Deliver fixture", stage: "build", verify: shared ? producer : "true", lessons: "", requirements: [
      { id: "browser", title: "Browser evidence", description: "Produce evidence/desktop.png", kind: "command", check: producer, required: true, inputs: [], artifacts: ["evidence/desktop.png"] },
      { id: "visual", title: "Independent evidence inspection", description: "Inspect evidence/desktop.png", kind: "review", check: "", required: true, inputs: [], artifacts: [] },
    ], tasks: [{ id: "feature", title: "Feature", description: "Write feature.txt", acceptanceCriteria: "The fixture is delivered", agentId: engineer.id, reviewerId: "", dependsOn: [], contract: { requirementIds: ["browser", "visual"], inputs: [], outputs: ["feature.txt"], resources: [] } }] };
    let paused = false, producerCalls = 0, reviewCalls = 0;
    const scheduler = createScheduler({ db, worktreeRoot, runCheck: async (cwd, command, signal, timeout) => {
      if (command === producer) producerCalls++;
      return runCheck(cwd, command, signal, timeout);
    }, publish: (_id, event) => {
      if (!paused && event.type === "evidence" && event.evidence.scope === "acceptance" && event.evidence.requirementIds.includes("browser")) {
        paused = true;
        scheduler.pause(event.evidence.runId);
      }
    }, runAgent: async (inv) => {
      if (inv.mode === "worker") { await Bun.write(join(inv.cwd, "feature.txt"), "Done"); return { ok: true, text: "Done" }; }
      if (inv.prompt.includes("reviewing a teammate")) {
        reviewCalls++;
        expect(readFileSync(join(inv.cwd, "evidence", "desktop.png"), "utf8")).toBe("retained artifact fixture");
        return { ok: true, text: "", structured: { verdict: "approve", findings: "Fixture artifact is readable" } };
      }
      return { ok: true, text: "", structured: inv.prompt.includes("## Verification") ? { ...plan, stage: "fix", requirements: [], tasks: [] } : plan };
    } });
    try {
      const run = await scheduler.startRun({ teamId: team.id, workdir: join(dir, "project"), prompt: "Deliver the artifact fixture", autonomous: true });
      await wait(() => db.getRun(run.id)!.status === "paused");
      const callsBefore = db.getRun(run.id)!.agentCalls, checksBefore = producerCalls;
      expect(reviewCalls).toBe(0);
      const receipt = db.listEvidence(run.id).findLast((entry) => entry.scope === "acceptance" && entry.requirementIds.includes("browser"))!;
      expect(receipt.status).toBe("passed");
      if (!retained) for (const artifact of receipt.artifacts) unlinkSync(join(worktreeRoot, run.id, ".artifacts", artifact));
      scheduler.resume(run.id);
      await wait(() => ["completed", "failed", "paused"].includes(db.getRun(run.id)!.status));
      expect(db.getRun(run.id)!.status).toBe("completed");
      expect(db.getRun(run.id)!.agentCalls).toBe(callsBefore + 2);
      expect(reviewCalls).toBe(1);
      expect(producerCalls).toBe(checksBefore + (retained ? 0 : 1));
      expect(db.listEvidence(run.id).findLast((entry) => entry.requirementIds.includes("visual"))).toMatchObject({ scope: "acceptance", status: "passed", commit: db.getRun(run.id)!.acceptedCommit });
    } finally { await scheduler.waitForCleanup(); await scheduler.shutdownPreviews(); db.close(); }
  });
}
