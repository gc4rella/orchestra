import type { HTMLBundle, Server } from "bun";
import { z } from "zod";
import type { ServerEvent } from "../shared/types.ts";
import { isDirector, RUNTIMES } from "../shared/types.ts";
import type { Db } from "./db.ts";
import { WorkspaceError } from "./git.ts";
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
const RunBody = z.strictObject({
  prompt: z.string().trim().min(1).max(20_000),
  workdir: z.string().trim().min(1).max(1000),
});
const ReviseBody = z.strictObject({ feedback: z.string().trim().min(1).max(10_000) });
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

async function body<T extends z.ZodType>(req: Request, schema: T): Promise<z.output<T>> {
  const json = await req.json().catch(() => {
    throw new HttpError(400, "invalid JSON body");
  });
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

export function startServer(opts: { db: Db; scheduler: Scheduler; port: number; index?: HTMLBundle; development?: boolean }) {
  const { db, scheduler } = opts;
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

      "/api/runtimes": { GET: route(() => detectRuntimes()) },

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
      "/api/runs/:id/approve": { POST: route((req) => scheduler.approve(idParam(req))) },
      "/api/runs/:id/revise": {
        POST: route(async (req) => scheduler.revise(idParam(req), (await body(req, ReviseBody)).feedback)),
      },
      "/api/runs/:id/cancel": { POST: route((req) => scheduler.cancel(idParam(req))) },
      "/api/tasks/:id/retry": { POST: route((req) => scheduler.retry(idParam(req))) },
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
