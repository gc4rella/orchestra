import type { HTMLBundle, Server } from "bun";
import { join } from "node:path";
import { homedir } from "node:os";
import { z } from "zod";
import type { ReviewComment, ServerEvent } from "../shared/types.ts";
import { isDirector, PLAN_STAGES, RUNTIMES } from "../shared/types.ts";
import { orchestraHome, type Db } from "./db.ts";
import { startDemo } from "./demo.ts";
import { diffFiles, inspectWorkspace, listFolders, WorkspaceError } from "./git.ts";
import { detectRuntimes } from "./runtimes.ts";
import { ConflictError, NotFoundError, type Scheduler } from "./scheduler.ts";

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const optionalText = (max: number) =>
  z.string().trim().max(max).nullable().optional().transform((v) => v || null);

const AgentBody = z.strictObject({
  name: z.string().trim().min(1).max(80),
  runtime: z.enum(RUNTIMES),
  // Passed to the CLI as an argv value; forbid anything that could read as a flag.
  model: optionalText(100).refine((v) => v === null || /^[A-Za-z0-9][\w.:/[\]-]*$/.test(v), "invalid model name"),
  role: z.string().trim().min(1).max(200),
  skills: z.string().trim().max(2000).default(""),
  instructions: optionalText(10_000),
});
const LimitsBody = z.strictObject({
  maxDurationMs: z.number().int().min(60_000).max(24 * 60 * 60_000),
  maxAgentCalls: z.number().int().min(1).max(500),
});
const ResumeBody = z.strictObject({ guidance: z.string().trim().max(10_000).optional(), limits: LimitsBody.optional() });
const EmptyBody = z.strictObject({});
const RunBody = z.strictObject({
  prompt: z.string().trim().min(1).max(20_000),
  workdir: z.string().trim().min(1).max(1000),
  autonomous: z.boolean().default(false),
  continuous: z.boolean().default(false),
  limits: LimitsBody.optional(),
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
  summary: z.string().max(10_000),
  stage: z.enum(PLAN_STAGES),
  verify: z.string().max(500),
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
      }),
    )
    .max(20),
});
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
        : e instanceof WorkspaceError ? 400
        : 500;
      if (status === 500) console.error(e);
      return Response.json({ error: e instanceof Error ? e.message : String(e) }, { status });
    }
  };
}

/** A team has one director; `id` is the agent being saved, if it already exists. */
function assertSingleDirector(db: Db, role: string, id?: string) {
  const current = db.listAgents().find((a) => isDirector(a) && a.id !== id);
  if (current && isDirector({ role })) throw new HttpError(409, `${current.name} is already the team's Director; there can only be one.`);
}

export function publishEvent(server: Server, runId: string, ev: ServerEvent) {
  const msg = JSON.stringify(ev);
  server.publish(`run:${runId}`, msg);
  if (ev.type === "run") server.publish("runs", msg);
}

export function startServer(opts: { db: Db; scheduler: Scheduler; port: number; index?: HTMLBundle; development?: boolean; demoRoot?: string; detectRuntimes?: typeof detectRuntimes }) {
  const { db, scheduler } = opts;
  const runtimes = opts.detectRuntimes ?? detectRuntimes;
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

      "/api/agents": {
        GET: route(() => db.listAgents()),
        POST: route(async (req) => {
          const input = await body(req, AgentBody);
          assertSingleDirector(db, input.role);
          return db.createAgent(input);
        }),
      },
      "/api/agents/:id": {
        PUT: route(async (req) => {
          const input = await body(req, AgentBody);
          assertSingleDirector(db, input.role, idParam(req));
          if (!db.updateAgent(idParam(req), input)) throw new HttpError(404, "Agent not found");
          return db.getAgent(idParam(req));
        }),
        DELETE: route((req) => {
          if (db.agentInUse(idParam(req))) throw new HttpError(409, "Agent is part of a run and cannot be deleted");
          if (!db.deleteAgent(idParam(req))) throw new HttpError(404, "Agent not found");
        }),
      },

      "/api/demo": { POST: route(async (req) => {
        await body(req, EmptyBody);
        return startDemo({ db, scheduler, root: opts.demoRoot ?? join(orchestraHome(), "demos"), runtimes: await runtimes() });
      }) },

      "/api/runs": {
        GET: route(() => db.listRuns()),
        POST: route(async (req) => scheduler.startRun(await body(req, RunBody))),
      },
      "/api/runs/:id": {
        GET: route((req) => {
          const run = db.getRun(idParam(req));
          if (!run) throw new HttpError(404, "Run not found");
          return { run, tasks: db.listTasks(run.id) };
        }),
      },
      "/api/runs/:id/logs": {
        GET: route((req) => db.listLogs(idParam(req), new URL(req.url).searchParams.get("taskId"))),
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
      "/api/runs/:id/pause": { POST: route(async (req) => { await body(req, EmptyBody); return scheduler.pause(idParam(req)); }) },
      "/api/runs/:id/resume": { POST: route(async (req) => scheduler.resume(idParam(req), await body(req, ResumeBody))) },
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
