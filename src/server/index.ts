import type { Server } from "bun";
import { join } from "node:path";
import index from "../web/index.html";
import { openDb, orchestraHome } from "./db.ts";
import { publishEvent, startServer } from "./http.ts";
import { runAgent } from "./runtimes.ts";
import { createScheduler } from "./scheduler.ts";

const db = openDb();
db.failInterrupted();

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
  port: Number(process.env.PORT ?? 4321),
  development: process.env.NODE_ENV !== "production",
});

console.log(`🎼 Orchestra running at http://127.0.0.1:${server.port}`);
