import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEMO_CHECK, DEMO_LIMITS, DEMO_PROMPT, demoReadiness } from "../shared/demo.ts";
import type { RuntimeInfo } from "../shared/types.ts";
import type { Db } from "./db.ts";
import { ConflictError, type Scheduler } from "./scheduler.ts";

export async function startDemo(opts: { db: Db; scheduler: Scheduler; teamId: string; root: string; runtimes: RuntimeInfo[] }) {
  const team = opts.db.getTeam(opts.teamId);
  if (!team) throw new ConflictError("Pick a team for the demo.");
  const members = team.memberIds.filter((id) => id !== team.directorId).flatMap((id) => opts.db.getAgent(id) ?? []);
  const reason = demoReadiness(opts.db.getAgent(team.directorId) ?? undefined, members, opts.runtimes);
  if (reason) throw new ConflictError(reason);
  // Retain the scratch repository alongside the normal database for later review and resume.
  mkdirSync(opts.root, { recursive: true });
  const workdir = realpathSync(mkdtempSync(join(opts.root, "autonomy-demo-")));
  return opts.scheduler.startRun({ teamId: team.id, workdir, prompt: DEMO_PROMPT, checkCommand: DEMO_CHECK, autonomous: true, continuous: true, limits: { ...DEMO_LIMITS } });
}
