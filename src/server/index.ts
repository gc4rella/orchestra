import type { Server } from "bun";
import { join } from "node:path";
import index from "../web/index.html";
import { openDb, orchestraHome } from "./db.ts";
import { loadToken, publishEvent, startServer } from "./http.ts";
import { runAgent } from "./runtimes.ts";
import { createScheduler } from "./scheduler.ts";

const db = openDb();
db.failInterrupted();
const token = loadToken(orchestraHome());

let server: Server | undefined;
const scheduler = createScheduler({
  db,
  runAgent,
  worktreeRoot: join(orchestraHome(), "worktrees"),
  publish: (runId, ev) => server && publishEvent(server, runId, ev),
});

server = startServer({
  db,
  scheduler,
  runAgent,
  index,
  token,
  port: Number(process.env.PORT ?? 4321),
  development: process.env.NODE_ENV !== "production",
});

// The link carries the access token; anyone who can read it can drive the agents.
console.log(`🎼 Orchestra running. Open http://127.0.0.1:${server.port}/auth?token=${token}`);
