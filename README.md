# 🎼 Orchestra

A local director for AI coding agents. Register the agent CLIs you have installed (Claude Code, Codex), describe what you want built, and a **director** agent plans the work like an engineering lead: it splits it into tasks, assigns each to the best-suited agent and orders them by dependency. You approve the plan, then the agents work, in parallel where possible, each on its own git branch, and their work is merged into one branch for you to review.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2.3, git ≥ 2.28
- At least one agent CLI on `PATH` and logged in: `claude` (Claude Code) and/or `codex`

## Run

```sh
bun install
bun run dev        # http://127.0.0.1:4321  (PORT to change)
bun test           # unit + integration tests (no real agents)
bun run typecheck
```

## Workspace

Choose **System**, **Light**, or **Dark** in the top bar; Orchestra remembers your appearance preference. Runs can be searched by brief or project path and filtered by what needs attention. New-run drafts stay in the current browser session until a run is successfully created.

The run workspace brings plan review, task progress, and agent output together. On phones, switch between **Tasks** and **Output**. Filter output by kind, pause following to read earlier entries, or jump back to the latest output. When the live connection drops, the workspace reconnects and refreshes every 10 seconds in the meantime.

## How it works

1. **Team.**
   - Hire role presets on the Team page: Director, Product Manager, Product Designer, Tech Lead, Principal Engineer, Frontend, Backend and Full-stack Engineers, QA, DevOps.
   - Or register custom agents. Each agent is a CLI runtime plus a name, role, skills, optional model and instructions, and the same CLI can be registered under many roles.
2. **New run.** Give a prompt and add a project folder: browse your folders (or paste a path) in the folder picker, or pick a recent project. The path is checked as you go, so you see whether it will be created, initialized or used from its current commit. The team's **Director** (the one agent with role `Director (product & engineering)`) plans and staffs every run; it delegates and never takes a task itself.
   - A missing or empty directory becomes a new git repo.
   - An existing repo must be given by its root and is used from its current `HEAD` (uncommitted changes are not included).
3. **Stage 1, definition.** The director plans the groundwork like a product team does, and you approve it:
   - The PM writes `docs/product/spec.md`.
   - The designer writes `docs/design/ux.md`.
   - The tech lead writes `docs/engineering/design.md` and scaffolds the project.
   - The principal engineer reviews the design and records decisions in `docs/engineering/decisions.md`.
   - Small, clear goals skip this stage.
4. **Stage 2, build.** Once the definition work is merged, the director reads those documents and plans implementation, QA and the final review. You approve that too, or send feedback for a revision.
5. **Execution.**
   - Tasks run as soon as their dependencies are done, up to 3 at once. Each runs in its own worktree on `orchestra/<run>-<task>`, branched from the current run branch.
   - When an agent finishes, Orchestra commits its work and merges it into `orchestra/<run>`. If the merge conflicts, the same agent is asked to resolve it.
   - A failed task blocks its dependents until you retry it.
6. **Review.** When everything is merged, review `orchestra/<run>` and merge it yourself. Orchestra never touches your checked-out branch.

State lives in `~/.orchestra` (override with `ORCHESTRA_HOME`): `orchestra.db` (SQLite) and `worktrees/`.

## Security

Agents run **without permission prompts** so they can work unattended:
- Claude Code workers run with `--permission-mode bypassPermissions`, which is not OS-sandboxed.
- Codex workers run with `--sandbox workspace-write` and network access.
- The director is read-only.

Only point Orchestra at projects and prompts you trust.

The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't loopback, which blocks DNS rebinding. It also rejects requests whose `Origin` isn't the app itself, and mutations that aren't JSON, which blocks other websites from starting runs. There is no authentication, so other local users on the machine can reach it.

## Layout

```
src/shared/types.ts      types shared by server and UI
src/server/index.ts      entry: wires db, scheduler, HTTP server
src/server/http.ts       REST + WebSocket API, request guard, input validation
src/server/db.ts         SQLite schema and queries
src/server/runtimes.ts   CLI detection, argv building, stream parsing, process spawning
src/server/director.ts   plan schema, director prompt, plan validation
src/server/git.ts        workspace setup, worktrees, commit, merge
src/server/scheduler.ts  run lifecycle: plan → approve → parallel execution → merge
src/web/                 React UI (served by Bun's HTML bundler); roles.ts holds the team presets
```
