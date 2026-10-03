# AGENTS.md

Guidance for coding agents working on Orchestra. For what the product does from a user's point of view, read `README.md`.

## What this is

Orchestra is a local web app that directs AI coding agents. The user registers local agent CLIs (Claude Code, Codex) as a team of roles. One agent is the **Director**: it plans the work and assigns it to the rest of the team. Agents then work in parallel in git worktrees, and their work is merged into a branch for the user to review.

It is one Bun process: a REST API plus WebSocket (`Bun.serve`), SQLite (`bun:sqlite`), agent processes started with `Bun.spawn`, and a React UI bundled by Bun's HTML import.

## Commands

```sh
bun install
bun run dev          # http://127.0.0.1:4321 (PORT, ORCHESTRA_HOME to override)
bun test             # all tests; fast, no real agent CLIs are called
bun run typecheck    # tsc --noEmit
```

Before you finish a change, `bun test` and `bun run typecheck` must both pass.

## Layout

| Path | Owns |
|---|---|
| `src/shared/types.ts` | Types shared by server and UI, `DIRECTOR_ROLE` / `isDirector`, `PLAN_STAGES` |
| `src/server/index.ts` | Entry point: wires the db, scheduler and HTTP server |
| `src/server/http.ts` | Routes, the request guard (`checkRequest`), zod body validation, the single-Director rule |
| `src/server/db.ts` | Schema, row ↔ type mapping, all SQL |
| `src/server/runtimes.ts` | CLI detection, argv per runtime and mode, stream-JSON parsing, `runAgent` |
| `src/server/director.ts` | Plan schema, director prompt (both stages), `validatePlan` |
| `src/server/git.ts` | Workspace preparation, worktrees, commit, merge, conflict handling |
| `src/server/scheduler.ts` | Run lifecycle: plan → approve → DAG execution → merge → finish; cancel, retry, two-stage re-planning |
| `src/web/` | React UI with hash routing (`App.tsx`), API client and WS hook (`api.ts`), role presets (`roles.ts`), plain CSS |
| `test/` | `bun:test` suites, one per server module |

`src/web` may import `src/shared` but never `src/server`.

## Invariants (do not break)

**Git safety: never touch the user's checkout**
- All work happens in worktrees under `$ORCHESTRA_HOME/worktrees/<runId>/`.
- The integration branch is `orchestra/<runId>`.
- Task branches are `orchestra/<runId>-<taskKey>`. They are siblings of the integration branch, never nested under it, because git refs can't be both a file and a directory.
- Orchestra never checks out, resets or merges into the user's branch.

**Orchestra commits, agents don't**
- Codex's `workspace-write` sandbox can't write the main repo's `.git` from inside a worktree.
- `commitAll` and `concludeMerge` commit with an explicit `-c user.name/-c user.email` identity.
- Worker prompts tell agents not to commit.

**Merges are serialized per run** through `withMergeLock` in `scheduler.ts`. Conflicts go back to the task's own agent. If conflict markers remain afterwards, the merge is aborted and the task fails.

**`execute()` marks the task `running` before its first `await`**, so a re-entrant `tick()` can't start the same task twice. Keep that line first.

**Director output is untrusted**
- `validatePlan` is the gate. It checks the schema, known agents, unknown or self dependencies, duplicate or finished ids, branch-safe ids, the expected stage, and cycles.
- `PlanSchema` stays types-only and strict, because Codex structured output needs `additionalProperties: false` and every field required. `$schema` is stripped. Semantic rules belong in `validatePlan`, not in the JSON schema.

**One Director per team**
- The Director is the agent whose role equals `DIRECTOR_ROLE` (compared case-insensitively).
- `http.ts` rejects a second Director, and `scheduler.startRun` picks it.
- The Director is excluded from the roster it staffs (`teamOf`), so it never gets a task.

**Two-stage planning**
- A plan with `stage: "definition"` causes `finish()` to re-plan once all its tasks are done.
- The build plan must have `stage: "build"`. It may depend on finished task keys but must not reuse them (`planRules`).

**Security boundary: agents run without permission prompts** (Claude `bypassPermissions`, Codex `workspace-write` with network)
- Every API route goes through `route()` → `checkRequest`: loopback `Host`, same-origin `Origin`, JSON content type for mutations. The `/ws` upgrade goes through the same check in `fetch`.
- Never add a route that bypasses this check, and never bind to anything other than `127.0.0.1`.
- Validate every request body with zod.
- Any user value that reaches CLI argv must be validated so it can't be read as a flag (see `model` in `AgentBody`).

**Prompts go to the CLIs on stdin, and stdin is then closed.** Codex blocks waiting on stdin otherwise.

**In-flight agent processes exist only in memory.** On startup `db.failInterrupted()` marks running tasks and planning/running runs as failed so they can be retried. That's why `dev` does not use `bun --hot`: a reload would orphan the agent processes.

## Conventions

**TypeScript and imports**
- TypeScript is `strict` with `noUncheckedIndexedAccess` and `verbatimModuleSyntax`.
- Use `import type` for types and keep the explicit `.ts`/`.tsx` extensions on imports.
- The only runtime dependencies are `react`, `react-dom` and `zod`. Prefer Bun and Node built-ins; adding a dependency needs a clear reason.

**Pinned Bun types**
- `@types/bun` is pinned to the runtime version (1.2.15). Don't upgrade it on its own.
- The HTML route needs one cast in `http.ts`, because those types leave HTML bundles out of `RouteValue`.

**Where logic lives**
- Keep logic in the module that owns it: SQL in `db.ts`, git in `git.ts`, CLI specifics in `runtimes.ts`, prompts in `director.ts`/`scheduler.ts`.
- Errors that map to HTTP statuses (in `api()` in `http.ts`) are `HttpError`, `NotFoundError` (404), `ConflictError` (409) and `WorkspaceError` (400). Throw these instead of building responses in the business logic. `PlanError` stays inside the scheduler: planning failures become a failed run, and `approve` rethrows them as `ConflictError`.

**UI**
- Plain CSS in `styles.css` using the existing custom properties.
- Status is always shown as text, never by color alone.
- No browser dialogs (`alert`/`confirm`); use inline two-step confirms.

**Comments and naming**
- Keep comments sparse and explain *why*.
- Match the surrounding naming. User-facing copy says "Director", "team", "run" and "task".

## Testing

- Tests never spawn real agents. `createScheduler` takes a `runAgent` function; the tests pass a fake that writes files into the worktree. Git tests use real git in temp dirs (`mkdtempSync` + `realpathSync`; on macOS `/tmp` is a symlink).
- Use `openDb(":memory:")` and isolated `worktreeRoot`/`ORCHESTRA_HOME` paths. Never touch `~/.orchestra` from tests.
- The fixtures in `test/runtimes.test.ts` were recorded from claude 2.1.280 and codex 0.157.1.
  - If a CLI's output format changes, re-probe with a trivial prompt plus schema, then update `parseLine`, `buildArgs` and the fixtures together.
  - Example probes: `claude -p --output-format stream-json --verbose --json-schema …` and `codex exec --json --output-schema … - </dev/null`.
- A manual end-to-end run with real agents costs money.
  - Use a throwaway `ORCHESTRA_HOME=/tmp/...`, a scratch project dir and a cheap model.
  - Afterwards, verify with `git log --graph orchestra/<runId>` that the user's `main` is unchanged.

## Common changes

**Add an agent runtime**
- Extend `RUNTIMES` in `shared/types.ts`.
- In `runtimes.ts`, add it to `BINARIES` and add `buildArgs` and `parseLine` branches for both director (read-only) and worker modes.
- Add the label to `RUNTIME_LABEL` in `web/pages/Agents.tsx`.
- Add argv and parse tests.

**Change the plan shape**
- Update `PlanSchema` in `director.ts` and `Plan` in `shared/types.ts` together.
- Keep the schema strict. Extend `validatePlan` and the strict-schema test in `test/director.test.ts`.

**Change roles**
- Presets live in `web/roles.ts`.
- The definition-stage document paths (`docs/product/spec.md`, `docs/design/ux.md`, `docs/engineering/design.md`, `docs/engineering/decisions.md`) are named in the director prompt in `director.ts`. Keep the prompt and the presets consistent.

**Add a route**
- Register it in `startServer` through `route(...)` and give it a zod body schema.
- Map new failure cases to the existing error classes.
