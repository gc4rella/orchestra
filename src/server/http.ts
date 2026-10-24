import type { HTMLBundle, Server } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { ReviewComment, ServerEvent } from "../shared/types.ts";
import { DELIVERY_PROFILES, EFFORTS, MAX_MEMORY, PLAN_STAGES, RUNTIMES, RUN_TIMEOUT_BOUNDS } from "../shared/types.ts";
import { ContractSchema, RequirementSchema } from "./director.ts";
import { orchestraHome, type Db, type TeamInput } from "./db.ts";
import { startDemo } from "./demo.ts";
import { diffFiles, inspectWorkspace, listFolders, WorkspaceError } from "./git.ts";
import { detectRuntimes, probeAgent, type RunAgent } from "./runtimes.ts";
import { ConflictError, NotFoundError, type Scheduler } from "./scheduler.ts";
import { ensureSkills, searchSkills, SKILL_ID, SkillError } from "./skills.ts";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => v || null);

const RateLimitPolicyBody = z.strictObject({
  maxUsedPercent: z.number().int().min(1).max(100),
  window: z.enum(["5h", "weekly", "both"]),
});
const AgentBody = z.strictObject({
  rateLimitPolicy: RateLimitPolicyBody.nullable().default(null),
  name: z.string().trim().min(1).max(80),
  runtime: z.enum(RUNTIMES),
  // Passed to the CLI as an argv value; forbid anything that could read as a flag.
  model: optionalText(100).refine((v) => v === null || /^[A-Za-z0-9][\w.:/[\]-]*$/.test(v), "invalid model name"),
  role: z.string().trim().min(1).max(200),
  expertise: z.string().trim().max(2000).default(""),
  // Skill ids become a git URL and library paths; SKILL_ID keeps them to plain owner/repo/skill segments.
  skills: z.array(z.string().max(300).regex(SKILL_ID, "skill ids look like owner/repo/skill")).max(20)
    .refine((ids) => new Set(ids).size === ids.length, "skills must be unique").default([]),
  instructions: optionalText(10_000),
  // Also an argv value; only the levels the agent's CLI accepts.
  effort: optionalText(20),
}).refine((a) => a.effort === null || EFFORTS[a.runtime].includes(a.effort), { path: ["effort"], message: "unknown effort for this runtime" });
const TeamBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  directorId: z.string().min(1).max(100),
  memberIds: z.array(z.string().min(1).max(100)).min(1, "a team needs at least one member").max(50)
    .refine((ids) => new Set(ids).size === ids.length, "members must be unique"),
});
const LimitsBody = z.strictObject({
  maxDurationMs: z.number().int().min(60_000).max(24 * 60 * 60_000),
  maxAgentCalls: z.number().int().min(1).max(500),
});
const GuidanceBody = z.strictObject({ text: z.string().trim().min(1).max(10_000) });
const TimeoutsBody = z.strictObject({
  agentMs: z.number().int().min(RUN_TIMEOUT_BOUNDS.agentMinutes.min * 60_000).max(RUN_TIMEOUT_BOUNDS.agentMinutes.max * 60_000),
  checkMs: z.number().int().min(RUN_TIMEOUT_BOUNDS.checkMinutes.min * 60_000).max(RUN_TIMEOUT_BOUNDS.checkMinutes.max * 60_000),
});
const ResumeBody = z.strictObject({ autoContinueOnRateLimit: z.boolean().optional(), guidance: z.string().trim().max(10_000).optional(), limits: LimitsBody.optional(), timeouts: TimeoutsBody.optional() });
const TransferBody = z.strictObject({ transfers: z.array(z.strictObject({ taskId: z.string().min(1).max(100), kind: z.enum(["worker", "reviewer"]), fromAgentId: z.string().min(1).max(100), agentId: z.string().min(1).max(100) })).min(1).max(100) });
const EmptyBody = z.strictObject({});
const DemoBody = z.strictObject({ teamId: z.string().min(1).max(100) });
const DeleteRunBody = z.strictObject({ deleteBranch: z.boolean().default(false) });
const MergeCheckBody = z.strictObject({ target: z.string().trim().min(1).max(200).optional() });
const Workdir = z.string().trim().min(1).max(1000);
const PreviewBody = z.strictObject({
  enabled: z.boolean(),
  command: z.string().trim().max(1000).regex(/^[^\0\r\n]*$/, "preview command must be a single line").default(""),
});
const DeliveryBody = z.strictObject({ profile: z.enum(DELIVERY_PROFILES), strategy: z.enum(["auto", "single", "team", "native"]), maxParallel: z.number().int().min(1).max(6) });
const RunBody = z.strictObject({
  delivery: DeliveryBody.optional(),
  preview: PreviewBody.optional(),
  teamId: z.string().min(1).max(100),
  prompt: z.string().trim().min(1).max(20_000),
  workdir: Workdir,
  autonomous: z.boolean().default(false),
  continuous: z.boolean().default(false),
  autoContinueOnRateLimit: z.boolean().default(false),
  rateLimitPolicy: RateLimitPolicyBody.nullable().optional(),
  // Same bounds as a plan's verify command (see validatePlan): it runs through sh after every task.
  checkCommand: z.string().trim().max(500).regex(/^[^\0\r\n]*$/, "check command must be a single line").default(""),
  limits: LimitsBody.optional(),
  timeouts: TimeoutsBody.optional(),
});
const ReviseBody = z
  .strictObject({
    feedback: z.string().trim().max(10_000).default(""),
    comments: z
      .array(z.strictObject({ file: z.string().min(1).max(1000), line: z.number().int().min(1), text: z.string().trim().min(1).max(2000) }))
      .max(50)
      .default([]),
  })
  .refine((b) => b.feedback || b.comments.length, "feedback or comments are required");
// Shape only; validatePlan applies the plan rules.
const PlanBody = z.strictObject({
  version: z.literal(2).optional(),
  requirements: z.array(RequirementSchema).max(60).optional(),
  summary: z.string().max(10_000),
  stage: z.enum(PLAN_STAGES),
  verify: z.string().max(500),
  lessons: z.string().max(2000),
  tasks: z
    .array(
      z.strictObject({
        id: z.string().max(40),
        title: z.string().max(200),
        description: z.string().max(10_000),
        agentId: z.string().max(100),
        reviewerId: z.string().max(100),
        dependsOn: z.array(z.string().max(40)).max(20),
        acceptanceCriteria: z.string().max(5000),
        contract: ContractSchema.optional(),
      }),
    )
    .max(20),
});
// User-approved text that every agent prompt of the project's runs carries, like guidance.
const SettingsBody = z.strictObject({ rateLimitPolicy: RateLimitPolicyBody.nullable() });
const ProjectPolicyBody = z.strictObject({ workdir: Workdir, rateLimitPolicy: RateLimitPolicyBody.nullable() });
const ProjectDeliveryBody = z.strictObject({ workdir: Workdir, delivery: DeliveryBody });
const LessonBody = z.strictObject({ workdir: Workdir, id: z.string().min(1).max(100), status: z.enum(["accepted", "retired"]) });
const MemoryBody = z.strictObject({ workdir: Workdir, memory: z.string().trim().max(MAX_MEMORY) });
const RetryBody = z.strictObject({
  instructions: optionalText(10_000),
  agentId: z.string().max(100).optional(),
});

/** Review comments on the diff become one feedback message for the director. */
function reviewFeedback(feedback: string, comments: ReviewComment[]) {
  if (!comments.length) return feedback;
  const notes = comments.map((c) => `- ${c.file}:${c.line}: ${c.text}`).join("\n");
  return `${feedback ? `${feedback}\n\n` : ""}Review comments on the changes (file:line):\n${notes}`;
}
const Subscribe = z.strictObject({ subscribe: z.string().regex(/^(runs|run:[\w-]+)$/) });

/**
 * The server launches agents that run shell commands unprompted, so only this app's own pages may drive it:
 * Host must be loopback (blocks DNS rebinding) and Origin, when a browser sends one, must be ours (blocks CSRF).
 */
export function checkRequest(req: Request, port: number): string | null {
  const allowed = [`127.0.0.1:${port}`, `localhost:${port}`];
  if (!allowed.includes(req.headers.get("host") ?? "")) return "forbidden host";
  const origin = req.headers.get("origin");
  if (origin && !allowed.some((h) => origin === `http://${h}`)) return "forbidden origin";
  if (!["GET", "HEAD"].includes(req.method) && !req.headers.get("content-type")?.startsWith("application/json")) {
    return "content-type must be application/json";
  }
  return null;
}

/** Validates a JSON body; an empty body counts as `{}`, for routes whose fields are all optional. */
async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  const text = await req.text();
  let json: unknown;
  try {
    json = text.trim() ? JSON.parse(text) : {};
  } catch {
    throw new HttpError(400, "invalid JSON body");
  }
  const parsed = schema.safeParse(json);
  if (!parsed.success) throw new HttpError(400, z.prettifyError(parsed.error));
  return parsed.data;
}

/** Path param `:id` of the matched route. */
const idParam = (req: Request) => (req as Bun.BunRequest<"/:id">).params.id;

function api(port: () => number, fn: (req: Request) => unknown) {
  return async (req: Request) => {
    const denied = checkRequest(req, port());
    if (denied) return Response.json({ error: denied }, { status: 403 });
    try {
      const result = await fn(req);
      return result instanceof Response ? result : Response.json(result ?? { ok: true });
    } catch (e) {
      const status =
        e instanceof HttpError ? e.status
        : e instanceof NotFoundError ? 404
        : e instanceof ConflictError ? 409
        : e instanceof WorkspaceError || e instanceof SkillError ? 400
        : 500;
      if (status === 500) console.error(e);
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  };
}

/** A team is hired agents only, with its Director kept out of the members it staffs. */
function assertTeam(db: Db, team: TeamInput) {
  if (!db.getAgent(team.directorId)) throw new HttpError(400, "The Director must be a hired agent");
  if (team.memberIds.includes(team.directorId)) throw new HttpError(400, "The Director leads the team and can't also be a member");
  if (team.memberIds.some((id) => !db.getAgent(id))) throw new HttpError(400, "Every member must be a hired agent");
}

export function publishEvent(server: Server, runId: string, ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  server.publish(`run:${runId}`, msg);
  if (ev.type === "run" || ev.type === "deleted") server.publish("runs", msg);
}

export function startServer(opts: {
  db: Db; scheduler: Scheduler; runAgent: RunAgent; port: number; index?: HTMLBundle; development?: boolean; demoRoot?: string;
  detectRuntimes?: typeof detectRuntimes; ensureSkills?: typeof ensureSkills; searchSkills?: typeof searchSkills;
}) {
  const { db, scheduler } = opts;
  const runtimes = opts.detectRuntimes ?? detectRuntimes;
  const skills = { ensure: opts.ensureSkills ?? ensureSkills, search: opts.searchSkills ?? searchSkills };
  /** Saving an agent installs the skills it was given, so its prompts only ever name skills in the library. */
  const agentInput = async (req: Request) => {
    const input = await body(req, AgentBody);
    return { ...input, skills: await skills.ensure(input.skills) };
  };
  let server: Server;
  const port = () => server.port ?? opts.port;
  const route = (fn: (req: Request) => unknown) => api(port, fn);

  server = Bun.serve({
    hostname: "127.0.0.1",
    port: opts.port,
    development: opts.development ?? false,
    routes: {
      // bun-types 1.2.15 omit HTMLBundle from RouteValue although the runtime serves it.
      ...(opts.index ? { "/": opts.index as unknown as Response } : {}),

      "/api/runtimes": { GET: route(() => runtimes()) },

      // Project picker: read-only checks of local folders, behind the same loopback/origin guard.
      "/api/workspace": {
        GET: route((req) => {
          const path = new URL(req.url).searchParams.get("path");
          if (!path) throw new HttpError(400, "path is required");
          return inspectWorkspace(path);
        }),
      },
      "/api/folders": {
        GET: route((req) => listFolders(new URL(req.url).searchParams.get("path") || homedir())),
      },

      "/api/settings": {
        GET: route(() => ({ rateLimitPolicy: db.getGlobalRateLimitPolicy() })),
        PUT: route(async (req) => {
          const { rateLimitPolicy } = await body(req, SettingsBody);
          db.setGlobalRateLimitPolicy(rateLimitPolicy);
          return { rateLimitPolicy };
        }),
      },

      "/api/projects/rate-limit": {
        GET: route((req) => {
          const workdir = new URL(req.url).searchParams.get("workdir");
          if (!workdir) throw new HttpError(400, "workdir is required");
          return { rateLimitPolicy: db.getRateLimitPolicy(workdir) };
        }),
        PUT: route(async (req) => {
          const { workdir, rateLimitPolicy } = await body(req, ProjectPolicyBody);
          db.setRateLimitPolicy(workdir, rateLimitPolicy);
          return { rateLimitPolicy };
        }),
      },
      "/api/projects/delivery": {
        GET: route((req) => {
          const workdir = new URL(req.url).searchParams.get("workdir");
          if (!workdir) throw new HttpError(400, "workdir is required");
          return { delivery: db.getDeliveryPolicy(workdir) };
        }),
        PUT: route(async (req) => {
          const { workdir, delivery } = await body(req, ProjectDeliveryBody);
          if (delivery.strategy === "native") throw new ConflictError("Native delegation is unavailable until child calls can share the persistent run budget. Choose one worker or an Orchestra team.");
          db.setDeliveryPolicy(workdir, delivery);
          return { delivery };
        }),
      },
      "/api/projects/lessons": {
        GET: route((req) => {
          const workdir = new URL(req.url).searchParams.get("workdir");
          if (!workdir) throw new HttpError(400, "workdir is required");
          return { lessons: db.listLessons(workdir) };
        }),
        PUT: route(async (req) => {
          const { workdir, id, status } = await body(req, LessonBody);
          const lesson = db.listLessons(workdir).find((l) => l.id === id);
          if (!lesson) throw new NotFoundError("Lesson not found");
          if (status === "accepted") {
            const before = db.getMemory(workdir);
            const memory = before.split("\n").some((line) => line.replace(/^\s*[-*\d.)]+\s*/, "").trim() === lesson.text) ? before : [before, lesson.text].filter(Boolean).join("\n");
            if (memory.length > MAX_MEMORY) throw new ConflictError("Project memory is full; edit it before accepting this lesson.");
            db.setMemory(workdir, memory);
          }
          db.setLessonStatus(workdir, id, status);
          return { memory: db.getMemory(workdir), lessons: db.listLessons(workdir) };
        }),
      },
      "/api/projects/memory": {
        GET: route((req) => {
          const workdir = new URL(req.url).searchParams.get("workdir");
          if (!workdir) throw new HttpError(400, "workdir is required");
          return { memory: db.getMemory(workdir) };
        }),
        PUT: route(async (req) => {
          const { workdir, memory } = await body(req, MemoryBody);
          db.setMemory(workdir, memory);
          return { memory };
        }),
      },

      "/api/agents": {
        GET: route(() => db.listAgents()),
        POST: route(async (req) => db.createAgent(await agentInput(req))),
      },
      "/api/agents/stats": { GET: route(() => db.agentStats()) },
      "/api/agents/:id": {
        PUT: route(async (req) => {
          if (!db.getAgent(idParam(req))) throw new HttpError(404, "Agent not found");
          if (!db.updateAgent(idParam(req), await agentInput(req))) throw new HttpError(404, "Agent not found");
          return db.getAgent(idParam(req));
        }),
        DELETE: route((req) => {
          if (db.agentInUse(idParam(req))) throw new HttpError(409, "Agent is part of a run and cannot be deleted");
          const directs = db.teamsDirectedBy(idParam(req));
          if (directs.length) throw new HttpError(409, `This agent directs ${directs.map((t) => t.name).join(", ")}; choose another Director first`);
          if (!db.deleteAgent(idParam(req))) throw new HttpError(404, "Agent not found");
        }),
      },

      // Marketplace search, proxied because skills.sh doesn't serve this origin; results are names and counts only.
      "/api/skills/search": {
        GET: route((req) => {
          const q = new URL(req.url).searchParams.get("q")?.trim() ?? "";
          if (q.length < 2 || q.length > 100) throw new HttpError(400, "search for 2 to 100 characters");
          return skills.search(q);
        }),
      },

      "/api/teams": {
        GET: route(() => db.listTeams()),
        POST: route(async (req) => {
          const input = await body(req, TeamBody);
          assertTeam(db, input);
          return db.createTeam(input);
        }),
      },
      "/api/teams/:id": {
        PUT: route(async (req) => {
          const input = await body(req, TeamBody);
          assertTeam(db, input);
          if (!db.updateTeam(idParam(req), input)) throw new HttpError(404, "Team not found");
          return db.getTeam(idParam(req));
        }),
        DELETE: route((req) => {
          if (db.teamInUse(idParam(req))) throw new HttpError(409, "Team has runs and cannot be deleted");
          if (!db.deleteTeam(idParam(req))) throw new HttpError(404, "Team not found");
        }),
      },

      // One small read-only agent call: shows whether the CLI is signed in, not just installed.
      "/api/agents/:id/test": {
        POST: route(async (req) => {
          await body(req, EmptyBody);
          const agent = db.getAgent(idParam(req));
          if (!agent) throw new HttpError(404, "Agent not found");
          return probeAgent(opts.runAgent, agent);
        }),
      },

      "/api/demo": { POST: route(async (req) => {
        const { teamId } = await body(req, DemoBody);
        return startDemo({ db, scheduler, teamId, root: opts.demoRoot ?? join(orchestraHome(), "demos"), runtimes: await runtimes() });
      }) },

      "/api/runs": {
        GET: route(() => db.listRuns()),
        POST: route(async (req) => scheduler.startRun(await body(req, RunBody))),
      },
      "/api/runs/:id": {
        GET: route((req) => {
          const run = db.getRun(idParam(req));
          if (!run) throw new HttpError(404, "Run not found");
          return { run, tasks: db.listTasks(run.id), preview: scheduler.getPreview(run.id) };
        }),
        DELETE: route(async (req) => scheduler.deleteRun(idParam(req), await body(req, DeleteRunBody))),
      },
      "/api/runs/:id/logs": {
        GET: route((req) => db.listLogs(idParam(req), new URL(req.url).searchParams.get("taskId"))),
      },
      "/api/runs/:id/evidence": { GET: route((req) => {
        if (!db.getRun(idParam(req))) throw new NotFoundError("Run not found");
        return db.listEvidence(idParam(req));
      }) },
      "/api/runs/:id/events": { GET: route((req) => {
        if (!db.getRun(idParam(req))) throw new NotFoundError("Run not found");
        return db.listAgentEvents(idParam(req));
      }) },
      "/api/runs/:id/artifacts": { GET: route((req) => {
        const query = new URL(req.url).searchParams;
        const index = Number(query.get("index"));
        if (!query.has("index") || !Number.isInteger(index) || index < 0) throw new HttpError(400, "artifact index is required");
        const path = scheduler.evidenceArtifact(idParam(req), query.get("evidence") ?? "", index);
        return new Response(Bun.file(path), { headers: { "Content-Type": "application/octet-stream", "Content-Disposition": "attachment", "X-Content-Type-Options": "nosniff" } });
      }) },
      "/api/runs/:id/preview": {
        GET: route((req) => scheduler.getPreview(idParam(req))),
        PUT: route(async (req) => scheduler.configurePreview(idParam(req), await body(req, PreviewBody))),
      },
      "/api/runs/:id/merge-check": {
        POST: route(async (req) => scheduler.checkMerge(idParam(req), (await body(req, MergeCheckBody)).target)),
      },
      "/api/runs/:id/diff": {
        GET: route((req) => {
          const run = db.getRun(idParam(req));
          if (!run) throw new HttpError(404, "Run not found");
          const taskId = new URL(req.url).searchParams.get("taskId");
          if (!taskId) return diffFiles(run.workdir, run.baseCommit, run.branch);
          const task = db.getTask(taskId);
          if (!task || task.runId !== run.id) throw new HttpError(404, "Task not found");
          return task.mergeCommit ? diffFiles(run.workdir, `${task.mergeCommit}^1`, task.mergeCommit) : [];
        }),
      },
      "/api/runs/:id/plan": {
        PUT: route(async (req) => scheduler.editPlan(idParam(req), await body(req, PlanBody))),
      },
      "/api/runs/:id/approve": { POST: route((req) => scheduler.approve(idParam(req))) },
      "/api/runs/:id/revise": {
        POST: route(async (req) => {
          const { feedback, comments } = await body(req, ReviseBody);
          return scheduler.revise(idParam(req), reviewFeedback(feedback, comments));
        }),
      },
      "/api/runs/:id/activity": { GET: route((req) => {
        if (!db.getRun(idParam(req))) throw new HttpError(404, "Run not found");
        return db.listActivity(idParam(req));
      }) },
      "/api/runs/:id/guidance": {
        POST: route(async (req) => scheduler.addGuidance(idParam(req), (await body(req, GuidanceBody)).text)),
      },
      "/api/runs/:id/chat": {
        GET: route((req) => scheduler.directorChat(idParam(req))),
        POST: route(async (req) => scheduler.sendDirectorChat(idParam(req), (await body(req, GuidanceBody)).text)),
      },
      "/api/runs/:id/pause": { POST: route(async (req) => { await body(req, EmptyBody); return scheduler.pause(idParam(req)); }) },
      "/api/runs/:id/resume": { POST: route(async (req) => scheduler.resume(idParam(req), await body(req, ResumeBody))) },
      "/api/runs/:id/capacity": { GET: route((req) => scheduler.capacityProposal(idParam(req))) },
      "/api/runs/:id/transfer": { POST: route(async (req) => scheduler.transferCapacity(idParam(req), (await body(req, TransferBody)).transfers)) },
      "/api/runs/:id/cancel": { POST: route((req) => scheduler.cancel(idParam(req))) },
      "/api/tasks/:id/retry": {
        POST: route(async (req) => {
          const { instructions, agentId } = await body(req, RetryBody);
          return scheduler.retry(idParam(req), { instructions: instructions ?? undefined, agentId });
        }),
      },
    },
    fetch(req, srv) {
      if (new URL(req.url).pathname !== "/ws") return Response.json({ error: "not found" }, { status: 404 });
      const denied = checkRequest(req, port());
      if (denied) return Response.json({ error: denied }, { status: 403 });
      return srv.upgrade(req) ? undefined : new Response("upgrade failed", { status: 400 });
    },
    websocket: {
      message(ws, raw) {
        try {
          ws.subscribe(Subscribe.parse(JSON.parse(String(raw))).subscribe);
        } catch {
          ws.close(1008, "invalid subscription");
        }
      },
    },
  });
  return server;
}
