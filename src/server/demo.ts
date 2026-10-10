import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { join } from "node:path";
import { DEMO_LIMITS, DEMO_PROMPT, demoReadiness } from "../shared/demo.ts";
import type { RuntimeInfo } from "../shared/types.ts";
import type { Db } from "./db.ts";
import { ConflictError, type Scheduler } from "./scheduler.ts";

export async function startDemo(opts: { db: Db; scheduler: Scheduler; root: string; runtimes: RuntimeInfo[] }) {
  const reason = demoReadiness(opts.db.listAgents(), opts.runtimes);
  if (reason) throw new ConflictError(reason);
  // Retain the scratch repository alongside the normal database for later review and resume.
  mkdirSync(opts.root, { recursive: true });
  const workdir = realpathSync(mkdtempSync(join(opts.root, "autonomy-demo-")));
  return opts.scheduler.startRun({ workdir, prompt: DEMO_PROMPT, autonomous: true, continuous: true, limits: { ...DEMO_LIMITS } });
}
