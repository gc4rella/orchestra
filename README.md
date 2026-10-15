# 🎼 Orchestra

A local director for AI coding agents. Register the agent CLIs you have installed (Claude Code, Codex), describe what you want built, and a **director** agent plans the work like an engineering lead: it splits it into tasks, assigns each to the best-suited agent and orders them by dependency. The agents work in parallel where possible, each on its own git branch. Every task is checked (the project's verify command and a teammate's review) before it is merged, failures are re-planned, and the director verifies the finished build against the goal. In continuous mode the Director keeps choosing useful improvements within your brief until the budget runs out or no worthwhile work remains. You review one branch at the end, or approve every plan yourself if you prefer.

## Requirements

- [Bun](https://bun.sh) ≥ 1.2.3, git ≥ 2.28
- At least one agent CLI on `PATH` and logged in: `claude` (Claude Code) and/or `codex`

## Run

```sh
bun install
bun run dev        # prints the link to open, http://127.0.0.1:4321/auth?token=…  (PORT to change)
bun test           # unit + integration tests (no real agents)
bun run typecheck
```

The automated suite uses fake CLIs for process-level coverage and never calls a model. To check an installed, logged-in CLI against its actual output and sandbox behavior, run `bun run test:runtime codex` or `bun run test:runtime claude-code haiku`. This opt-in smoke test makes three real agent calls (worker, session resume, read-only structured output), uses a disposable scratch repository, and removes it afterwards. It uses your CLI's default model unless you pass one, and may incur usage charges.

## Workspace

Choose **System**, **Light**, or **Dark** in the top bar; Orchestra remembers your appearance preference. Runs can be searched by brief or project path and filtered by what needs attention. New-run drafts stay in the current browser session until a run is successfully created.

The run workspace brings plan review, task progress, agent output and the changes together. A bar at the top says what the run needs from you (a plan to approve, a failed task, a paused budget, changes to review) and takes you to the control for it. Each task shows where it is in Work → Commit → Check → Review → Merge, and why its last pass was sent back. Errors come with their likely cause and a next step. On phones, switch between **Tasks** and **Output**. Filter or search output, expand collapsed runs of tool calls, download a task's log, pause following to read earlier entries, or jump back to the latest output. When the live connection drops, the workspace reconnects and refreshes every 10 seconds in the meantime. The browser tab's title counts the runs that need you.

A run that is not working (finished, failed, cancelled or paused) can be deleted from its workspace. That removes its history, output, worktrees and task branches. Its `orchestra/<run>` branch is kept unless you also choose to delete it.

## How it works

1. **Team.**
   - Hire role presets on the Team page: Director, Product Manager, Product Designer, Tech Lead, Principal Engineer, Frontend, Backend and Full-stack Engineers, QA, DevOps.
   - Or register custom agents. Each agent is a CLI runtime plus a name, role, expertise, optional model and instructions, and the same CLI can be registered under many roles.
   - Give agents skills from the [skills.sh](https://skills.sh) marketplace: search in the agent's drawer and add them. Orchestra fetches each skill from its GitHub repository when you save, and the agent reads a skill's instructions when a task calls for it. Skills are third-party instructions the agent follows with full access to its workspace, so add only ones you trust. Role presets come with a few well-known skills.
   - With no team yet, **Hire a starter team** adds a Director, a Full-stack Engineer and a QA Engineer on the CLIs you have installed.
   - **Test** an agent to check that its CLI is signed in, not just installed. It makes one small read-only call.
   - Each agent card shows its track record: tasks done, how many passed the first time, average attempts, failures, usage and reviews.
2. **New run.** The home page is one prompt box. Describe what you want, choose a project folder (browse your folders or paste a path in the folder picker, or pick a recent project), a team and a mode: **Keep improving** (the default), **Autonomous** (the Director approves its own plans and finishes after the original goal) or **Approve plans**. The path is checked as you go, so you see whether it will be created, initialized or used from its current commit. The team's **Director** (the one agent with role `Director (product & engineering)`) plans and staffs every run; it delegates and never takes a task itself.
   - Under **Options**, optionally say how to check the project (for example `bun install && bun test`). The Director uses it as the plan's verify command unless it doesn't fit. Orchestra remembers it per project.
   - Also under **Options**, optionally list **non-goals**. They are added to the brief, and every plan, including continuous improvements, stays within them. Example briefs are offered while the brief is empty.
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
   - A failed task blocks its dependents. An autonomous run hands failures to the Director, which re-plans the remaining work (twice at most, then pauses for guidance). You can also retry a task, with instructions or a different assignee, or ask the Director to re-plan.
6. **Verification.** When the build is merged, Orchestra runs the verify command on it and the Director checks the result against the goal and the spec. Gaps become a round of fix tasks (two automatic rounds per cycle; unresolved gaps pause the run with a report). A failed verify command cannot be accepted as success.
7. **Review.** Read the Director's verification report and the changes, per run or per task, in the **Changes** tab. Comment on lines and send them to the Director for another round of fixes, or merge `orchestra/<run>` yourself. Orchestra never touches your checked-out branch.

## Continuous building and handoffs

New autonomous runs default to **Keep improving within the brief**, with **120 active minutes and 40 agent calls**. Pick the **Autonomous** mode to finish after the original goal, or edit the budget under **Options** before starting. Older runs retain their original single-goal behavior.

After each accepted build, the Director inspects the merged project and plans the next useful improvement: completeness, usability, reliability, tests or performance. It stays within your brief and explicit non-goals. If no worthwhile improvement remains, the run completes early. Each cycle retains its plan and verification report.

Agents pass a handoff to their dependents: changes, decisions, interfaces, remaining issues and guidance, accompanied by changed files, automatic check results, reviewer findings and the merge commit. The next agent receives both the handoff and the merged files. The workspace shows the current goal, task phase, cycle history, remaining budget and live team activity.

**Send a note to the team** while a run is planning, running or awaiting approval: the note joins the run's guidance, and every later agent call receives it, without pausing. An agent already working sees it at its next step.

**Pause** stops new operations and lets current operations save a checkpoint. **Resume** continues on the same branch, retaining files, sessions and completed work/check/review phases. Add guidance to steer subsequent calls or increase the total budget; used time and calls do not reset. Paused time does not count toward active time. Server restarts require explicit resume.

Every Director, worker, reviewer and conflict-resolution call counts. At the call limit, already-started calls finish but no more calls launch. At the time deadline, active agent and verify process groups are stopped. Both limits preserve work and pause the run. Budgets range from 1–1,440 minutes and 1–500 calls. Dollar usage remains informational because Codex does not report cost.

Exhausted recovery or fix limits also pause the run. Supplying guidance and explicitly resuming authorizes another bounded recovery plan or the saved fix batch, without resetting counters; it does not start an unlimited retry loop.

For an opt-in demonstration with real agents, run `bun run test:autonomy codex` or `bun run test:autonomy claude-code haiku`. It uses an isolated scratch project, a five-minute/12-call budget, and checks for a completed dependent-agent handoff, merged work and unchanged user checkout. Reaching a budget reports `PAUSED` with exit code 0, rather than claiming the handoff test passed; actual failures or a completed run with no dependent handoff still fail. This makes real model calls and may incur usage charges. The script prints and retains its scratch directory so you can inspect the branch, reports and paused checkpoints. It also prints an `ORCHESTRA_HOME=… PORT=4322 bun run dev` command to open that saved database in a separate UI. For a paused run, increase the total active minutes or call limit there and resume; the existing branch and checkpoints are reused. Automated tests use fake agents and never call a model.

Each task shows its duration, attempts and usage; the run shows its total cost (reported by Claude Code) and tokens (both CLIs). Turn on **Notify me** in the top bar to get a browser notification when a run needs you while Orchestra is in the background.

State lives in `~/.orchestra` (override with `ORCHESTRA_HOME`): `orchestra.db` (SQLite) and `worktrees/`.

## Security

Agents run **without permission prompts** so they can work unattended:
- Claude Code workers run with `--permission-mode bypassPermissions`, which is not OS-sandboxed.
- Codex workers run with `--sandbox workspace-write` and network access.
- The director and reviewers are read-only.
- The plan's verify command runs through `sh` without a sandbox, after every task and on the merged build. It comes from the Director (or your edit, or the check command you gave for the project). A command runs only if you typed it as the check command or approved it for the project, by approving a plan that uses it or by allowing it when an autonomous run pauses for it.
- Each agent invocation stops after 45 minutes and each verify run after 15.

Only point Orchestra at projects and prompts you trust.

The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't loopback, which blocks DNS rebinding. It also rejects requests whose `Origin` isn't the app itself, and mutations that aren't JSON, which blocks other websites from starting runs. Every API request and the live connection also need an access token, so other local users on the machine can't drive it. The token is created once in `~/.orchestra/token`, readable only by you, and `bun run dev` prints a link that carries it. Opening the link signs the browser in with a cookie.

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

The **autonomy demo** suggestion on the home page (shown while the brief is empty) launches the same autonomy exercise with your configured team (a Director and at least two workers). It uses real agent CLIs and their configured models, with a five-minute / twelve-call budget. Orchestra creates a separate persistent scratch project under `$ORCHESTRA_HOME/demos/`; the run appears in normal history with live activity, handoffs, diffs and pause/resume controls. The demo does not create or change your team. CLI installation is checked; the CLIs must also be signed in.
