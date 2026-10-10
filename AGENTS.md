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
| `src/server/db.ts` | Schema and versioned migrations, row ↔ type mapping, all SQL |
| `src/server/runtimes.ts` | CLI detection, argv per runtime and mode, stream-JSON parsing, sessions and usage, `runAgent` |
| `src/server/director.ts` | Plan schema, `nextPlanning` (what the director plans next), director prompt per purpose, `validatePlan` |
| `src/server/review.ts` | Reviewer schema and prompt, `invokeReview` |
| `src/server/checks.ts` | `runCheck`: a plan's verify command in a worktree, with a timeout |
| `src/server/git.ts` | Workspace rules (`inspectWorkspace` decides, `prepareWorkspace` acts on it), folder listing for the project picker, worktrees, commit, merge, conflict handling, diffs |
| `src/server/scheduler.ts` | Run lifecycle: plan → approve → DAG execution (work → verify → review loop) → merge → verification; recovery, fix rounds, cancel, retry, plan edits |
| `src/web/` | React UI with hash routing (`App.tsx`), API client and WS hook (`api.ts`), pure view helpers (`model.ts`), shared components (`components/`), role presets (`roles.ts`), plain CSS |
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

**Tasks are checked before they merge.** After each pass the agent's work is committed, then the plan's `verify` command runs in the task worktree and the task's reviewer (if any) reviews the diff. Problems go back to the same agent session (`resume`); after `MAX_ITERATIONS` the task fails. A failed task keeps its worktree and session so a retry continues where it stopped.

**Loop caps are constants in `scheduler.ts`:** `MAX_ITERATIONS` per task attempt, `MAX_RECOVERIES` automatic re-plans per autonomous run, `MAX_FIX_ROUNDS` automatic verification fix rounds per cycle. Keep every automatic loop bounded. Exhaustion pauses with preserved work; never label unresolved work completed. Explicit user continuation must not reset consumed budgets or counters.

**Director output is untrusted**
- `validatePlan` is the gate. It checks the schema, known agents, unknown or self dependencies, duplicate or finished ids, branch-safe ids, the expected stage, and cycles.
- `PlanSchema` stays types-only and strict, because Codex structured output needs `additionalProperties: false` and every field required. `$schema` is stripped. Semantic rules belong in `validatePlan`, not in the JSON schema.

**One Director per team**
- The Director is the agent whose role equals `DIRECTOR_ROLE` (compared case-insensitively).
- `http.ts` rejects a second Director, and `scheduler.startRun` picks it.
- The Director is excluded from the roster it staffs (`teamOf`), so it never gets a task.

**Every plan goes through one path:** `plan()` → `invokeDirector` → `validatePlan`, then `approve()`, which validates again. `nextPlanning(tasks)` derives why the director plans next from the current cycle's tasks; the scheduler adds dependencies and taken keys from all cycles:
- no tasks: the first plan, `definition` or `build`
- failed or blocked tasks: a recovery plan in the same stage; approving it marks those tasks (and pending ones) `superseded`
- the latest batch is `definition`: the `build` plan
- the latest batch is `build` or `fix`: verification, a `fix` plan. Orchestra runs `verify` on the merged build first. A fix plan with no tasks accepts the build (its summary becomes `run.report`); it is the only plan allowed to be empty. An empty fix plan cannot accept a failed merged-build check.
New plans may depend on done task keys only and may not reuse any existing key (`UNIQUE(run_id, key)`). An autonomous run approves its own plans; an empty fix plan is approved in either mode. Continuous runs then use the improvement purpose: a nonempty build plan, or an empty fix plan when no worthwhile improvement remains. The Director stays within the original brief and its non-goals.

**Run checkpoints and budgets**
- Every agent call, including conflict resolution and review, goes through `metered()`. Reserve its call count before awaiting so parallel tasks cannot exceed the run cap.
- Persist task phases and evidence before advancing. Pause/resume preserves files, sessions, completed phases, active time and call counts. Repeat interrupted phases safely; never merge unchecked work.
- Only mark a run paused after its in-flight operations settle. Deadline cancellation stops the whole subprocess group. A restart requires explicit resume.
- Keep handoff evidence authoritative: files and automatic check/review results come from Orchestra; worker suggestions never schedule work directly.

**Security boundary: agents run without permission prompts** (Claude `bypassPermissions`, Codex `workspace-write` with network)
- Every API route goes through `route()` → `checkRequest`: loopback `Host`, same-origin `Origin`, JSON content type for mutations. The `/ws` upgrade goes through the same check in `fetch`.
- Never add a route that bypasses this check, and never bind to anything other than `127.0.0.1`.
- Validate every request body with zod.
- Any user value that reaches CLI argv must be validated so it can't be read as a flag (see `model` in `AgentBody`).

**Workspace rules live in one place.** `inspectWorkspace` is read-only and is what both the picker's live check (`GET /api/workspace`) and `prepareWorkspace` use, so the UI and run creation can't disagree. `GET /api/folders` lists directory names only, never file contents.

**Prompts go to the CLIs on stdin, and stdin is then closed.** Codex blocks waiting on stdin otherwise.

**Migrations are additive and versioned.** `MIGRATIONS` in `db.ts` runs on top of the v0 `SCHEMA`, tracked in `PRAGMA user_version`, one transaction each. Only add columns with defaults (so an older build still runs on a migrated database) and normalize old JSON in the row mappers (see `normalizePlan`). Never edit a shipped migration; append a new one.

**Sessions and usage.** Claude sessions get an id Orchestra chooses (`--session-id`, later `--resume`); Codex announces its thread id. Session ids must match `SESSION_ID` (a UUID) before they reach argv. Claude reports cost as a running total per session and Codex reports tokens that way, so `settleUsage` turns reports into per-invocation usage. Every agent call goes through `metered()` in the scheduler, which adds usage to the run and task.

**Verify commands run unsandboxed** through `sh` with the user's privileges, like the agents themselves. They may come from the director's output, so the same trust note applies; `validatePlan` only bounds their length and keeps them to one line. The user's optional `checkCommand` (stored in `RunControl`) is only a suggestion in the director prompt; it reaches `sh` only as a plan's `verify`, through `validatePlan`.

**Guidance accumulates per run** through `appendGuidance` in `scheduler.ts` (20k cap), whether it comes from `revise`, `resume` or a note while running (`addGuidance`). `metered()` appends it to every agent prompt.

**Deleting a run** (`scheduler.deleteRun`) is refused while it plans, runs or pauses. It removes the run's rows, its worktree dir and its task branches; `orchestra/<runId>` only on explicit request. Branches git refuses to delete are reported back, never forced.

**In-flight agent processes exist only in memory.** On startup `db.failInterrupted()` marks interrupted tasks and active runs as failed, retaining checkpoints and settling active time so they can be resumed explicitly. That's why `dev` does not use `bun --hot`: a reload would orphan the agent processes.

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
- The fixtures in `test/runtimes.test.ts` were recorded from claude 2.1.280/2.1.288 and codex 0.157.1/0.160.0.
  - If a CLI's output format changes, re-probe with a trivial prompt plus schema, then update `parseLine`, `buildArgs` and the fixtures together.
  - Example probes: `claude -p --output-format stream-json --verbose --json-schema …` and `codex exec --json --output-schema … - </dev/null`.
  - Resume probes: `claude -p --resume <id> …` and `codex exec resume <id> --json -c 'sandbox_mode="read-only"' -`. `codex exec resume` has no `-s` or `-C`.
- `test/db.test.ts` migrates a hand-built v0 database; add a case there for every migration.
- `bun run test:autonomy [codex|claude-code] [model]` is an opt-in scratch-project handoff demonstration with a five-minute/12-call budget and retained inspection artifacts.
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
- Update `PlanSchema` in `director.ts`, `Plan` in `shared/types.ts` and `PlanBody` in `http.ts` together, and default the new field for stored plans in `normalizePlan`.
- Keep the schema strict. Extend `validatePlan` and the strict-schema test in `test/director.test.ts`.

**Change roles**
- Presets live in `web/roles.ts`.
- The definition-stage document paths (`docs/product/spec.md`, `docs/design/ux.md`, `docs/engineering/design.md`, `docs/engineering/decisions.md`) are named in the director prompt in `director.ts`. Keep the prompt and the presets consistent.

**Add a route**
- Register it in `startServer` through `route(...)` and give it a zod body schema.
- Map new failure cases to the existing error classes.
