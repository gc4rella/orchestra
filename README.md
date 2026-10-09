# 🎼 Orchestra

A local director for AI coding agents. Register the agent CLIs you have installed (Claude Code, Codex), describe what you want built, and a **director** agent plans the work like an engineering lead: it splits it into tasks, assigns each to the best-suited agent and orders them by dependency. The agents work in parallel where possible, each on its own git branch. Every task is checked (the project's verify command and a teammate's review) before it is merged, failures are re-planned, and the director verifies the finished build against the goal. You review one branch at the end, or approve every plan yourself if you prefer.

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

The automated suite uses fake CLIs for process-level coverage and never calls a model. To check an installed, logged-in CLI against its actual output and sandbox behavior, run `bun run test:runtime codex` or `bun run test:runtime claude-code haiku`. This opt-in smoke test makes three real agent calls (worker, session resume, read-only structured output), uses a disposable scratch repository, and removes it afterwards. It uses your CLI's default model unless you pass one, and may incur usage charges.

## Workspace

Choose **System**, **Light**, or **Dark** in the top bar; Orchestra remembers your appearance preference. Runs can be searched by brief or project path and filtered by what needs attention. New-run drafts stay in the current browser session until a run is successfully created.

The run workspace brings plan review, task progress, agent output and the changes together. On phones, switch between **Tasks** and **Output**. Filter output by kind, pause following to read earlier entries, or jump back to the latest output. When the live connection drops, the workspace reconnects and refreshes every 10 seconds in the meantime.

## How it works

1. **Team.**
   - Hire role presets on the Team page: Director, Product Manager, Product Designer, Tech Lead, Principal Engineer, Frontend, Backend and Full-stack Engineers, QA, DevOps.
   - Or register custom agents. Each agent is a CLI runtime plus a name, role, skills, optional model and instructions, and the same CLI can be registered under many roles.
2. **New run.** Give a prompt, choose whether the run is **autonomous** (on by default: the Director approves its own plans) and add a project folder: browse your folders (or paste a path) in the folder picker, or pick a recent project. The path is checked as you go, so you see whether it will be created, initialized or used from its current commit. The team's **Director** (the one agent with role `Director (product & engineering)`) plans and staffs every run; it delegates and never takes a task itself.
   - A missing or empty directory becomes a new git repo.
   - An existing repo must be given by its root and is used from its current `HEAD` (uncommitted changes are not included).
3. **Stage 1, definition.** The director plans the groundwork like a product team does (you approve it in supervised mode):
   - The PM writes `docs/product/spec.md`.
   - The designer writes `docs/design/ux.md`.
   - The tech lead writes `docs/engineering/design.md` and scaffolds the project.
   - The principal engineer reviews the design and records decisions in `docs/engineering/decisions.md`.
   - Small, clear goals skip this stage.
4. **Stage 2, build.** Once the definition work is merged, the director reads those documents and plans implementation, QA and the final review. Each plan names a **verify command** (install, test, build) and a **reviewer** for the tasks that need one. In a supervised run you approve each plan, edit it (titles, briefs, assignees, reviewers, the verify command) or send feedback for a revision.
5. **Execution.**
   - Tasks run as soon as their dependencies are done, up to 3 at once. Each runs in its own worktree on `orchestra/<run>-<task>`, branched from the current run branch.
   - When an agent finishes, Orchestra commits its work, runs the verify command and asks the reviewer to review the diff. Problems go back to the same agent conversation, up to 3 attempts. Then the work is merged into `orchestra/<run>`; if the merge conflicts, the same agent resolves it.
   - A failed task blocks its dependents. An autonomous run hands failures to the Director, which re-plans the remaining work (twice at most). You can also retry a task, with instructions or a different assignee, or ask the Director to re-plan.
6. **Verification.** When the build is merged, Orchestra runs the verify command on it and the Director checks the result against the goal and the spec. Gaps become a round of fix tasks (two rounds at most; anything still open is listed in the report).
7. **Review.** Read the Director's verification report and the changes, per run or per task, in the **Changes** tab. Comment on lines and send them to the Director for another round of fixes, or merge `orchestra/<run>` yourself. Orchestra never touches your checked-out branch.

Each task shows its duration, attempts and usage; the run shows its total cost (reported by Claude Code) and tokens (both CLIs). Turn on **Notify me** in the top bar to get a browser notification when a run needs you while Orchestra is in the background.

State lives in `~/.orchestra` (override with `ORCHESTRA_HOME`): `orchestra.db` (SQLite) and `worktrees/`.

## Security

Agents run **without permission prompts** so they can work unattended:
- Claude Code workers run with `--permission-mode bypassPermissions`, which is not OS-sandboxed.
- Codex workers run with `--sandbox workspace-write` and network access.
- The director and reviewers are read-only.
- The plan's verify command runs through `sh` without a sandbox, after every task and on the merged build. It comes from the Director (or your edit) and, in an autonomous run, runs without anyone approving it first.
- Each agent invocation stops after 45 minutes and each verify run after 15.

Only point Orchestra at projects and prompts you trust.

The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't loopback, which blocks DNS rebinding. It also rejects requests whose `Origin` isn't the app itself, and mutations that aren't JSON, which blocks other websites from starting runs. There is no authentication, so other local users on the machine can reach it.

## Layout

```
src/shared/types.ts      types shared by server and UI
src/server/index.ts      entry: wires db, scheduler, HTTP server
src/server/http.ts       REST + WebSocket API, request guard, input validation
src/server/db.ts         SQLite schema and queries
src/server/runtimes.ts   CLI detection, argv building, stream parsing, process spawning
src/server/director.ts   plan schema, what to plan next, director prompts, plan validation
src/server/review.ts     reviewer schema and prompt
src/server/checks.ts     runs a plan's verify command
src/server/git.ts        workspace setup, worktrees, commit, merge
src/server/scheduler.ts  run lifecycle: plan → approve → work/verify/review → merge → verification
src/web/                 React UI (served by Bun's HTML bundler); roles.ts holds the team presets
```
