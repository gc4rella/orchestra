# 🎼 Orchestra

A local director for AI coding agents. Register the agent CLIs you have installed (Claude Code, Codex), describe what you want built, and a **Director** plans requirements, assigns tasks and orders them by dependency. Agents work in isolated git worktrees. Orchestra checks each task, tests its combination with the latest integrated work, and records evidence against requirements before accepting a build. Choose how much parallel work and independent review to use, then review one branch at the end or approve every plan yourself. In continuous mode the Director keeps choosing useful improvements within your brief until the budget runs out or no worthwhile work remains.

New runs keep a **Live preview** updated as the team makes runnable changes. Open **Preview** in the run workspace to see work in progress automatically, without waiting for a task to finish or merge. Active task files are checked for changes every second; compatible parallel changes appear together and conflicting drafts wait for integration. Draft previews are labeled **Work in progress · checks pending**, then replaced by the integrated version as checked tasks merge; the previous version stays available until its replacement responds successfully. Switching workspace views keeps the preview’s navigation and form state. Preview failures do not fail or pause the run. Turn this off under the new run's Options, or start/stop it from any run's workspace.

Preview detects root Vite, Next.js and Astro `dev` scripts (and installs dependencies using the lockfile's package manager), or serves a root `index.html` directly. For another stack or a monorepo, set **Preview settings & output → Start command** in the run, for example `cd web && bun install && bun run dev --host 127.0.0.1 --port "$PORT"`. Custom commands must install their own dependencies and bind to `127.0.0.1` at `$PORT`. Commands run with your user permissions in separate preview worktrees, using isolated snapshots of run files; local `.env` files are not copied. Each runnable update reloads the embedded preview, so browser state may reset. Unchanged snapshots do not reload it. Startup and dependency installation can delay an update; newer changes supersede an older startup. Preview servers stay up when runs pause or finish, stop when you stop the preview, delete the run or exit Orchestra, and require starting again after an Orchestra restart.

**Preview → Secrets → Open secrets** keeps app login details accessible while the app runs in the background. Values start hidden; **Reveal** shows a value for 30 seconds and **Copy** copies it directly. Closing Secrets or leaving Preview clears revealed values. Add, replace or delete saved values for the project; enable **Pass to the preview as an environment variable** for configuration the app reads from its environment. Restart the preview to apply changes. These values are shared by runs of the same project, but are not injected into agents or verification commands. Saving a password does not create or reset an account in the app.

Preview setup can report actual generated login details by writing a JSON object of string values, such as `{"username":"preview-user","password":"generated-value"}`, to the private file named by `ORCHESTRA_SECRETS_FILE` when `ORCHESTRA_PREVIEW=1`. The team receives this convention in its instructions. The file lives outside the preview worktree; credentials from a failed replacement never replace the running preview's details. Older launchers using the run's `.preview-login.json` are also supported. Reported values are kept separately from saved configuration, scoped to that run and labeled with their source revision when available. They are the app's report, not a login check, and may become stale if the app changes its accounts. Apps must report the details; Orchestra cannot recover an unknown password from its hash.

Secret values are encrypted in SQLite with a local key stored beside the database as `orchestra.db.secrets-key` (owner-only permissions). Back up both files to retain access. Preview credential reports remain private local files. Values are excluded from normal run responses and WebSocket events, and known values are masked in captured preview output; apps should still avoid logging secrets. Orchestra remains a local app without authentication: processes and users with access to its local API can reveal secrets. Do not expose its port to other machines.

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

The run workspace has four views: **Work** for plans, tasks and agent output; **Preview** for the working app; **Changes** for diffs and the final handoff; and **Checks** for requirements, evidence and run history. Its delivery overview shows verified outcomes, unresolved requirements, the accepted integration revision and remaining call/time budgets. A bar at the top says what the run needs from you (a plan to approve, a failed task, a paused budget, changes to review) and opens the view with the control for it. Each task shows where it is in Work → Commit → Check → Review → Merge, and why its last pass was sent back. Errors come with their likely cause and a next step. On phones, switch between **Tasks** and **Output**. Filter or search output, expand collapsed runs of tool calls, download a task's log, pause following to read earlier entries, or jump back to the latest output. When the live connection drops, the workspace reconnects and refreshes every 10 seconds in the meantime. The browser tab's title counts the runs that need you.

Choose **Chat with Director** to open a side conversation at any point in a run, including while paused, awaiting approval or finished. Ask about the plan, progress or decisions without leaving Work, Preview, Changes or Checks. The Director sees the run's current tasks and evidence and can inspect a read-only snapshot of the integrated work. Questions and replies survive refreshes. Each message authorizes one agent call, recorded separately from the team's work budget; its model usage is included in the run's totals. Chats retain provider usage safeguards, shared concurrency limits and the agent timeout, and never automatically retry or resume work. To change the work, use **Send a note to the team** or the plan controls; chat itself does not change instructions or tasks.

A run that is not working (finished, failed, cancelled or paused) can be deleted from its workspace. That removes its history, output, worktrees and task branches. Its `orchestra/<run>` branch is kept unless you also choose to delete it.

For a completed run, open **Changes → Check before merging** to compare the accepted revision with a local target branch. The check leaves your checkout, staged changes and branches untouched, and shows any conflicting paths. A clean result offers a manual merge command pinned to the checked commit. This is a local conflict check; it does not fetch remote changes or rerun tests on the combined result. Git 2.38 or newer is required.

## How it works

1. **Team.**
   - Hire role presets on the Team page: Director, Product Manager, Product Designer, Tech Lead, Principal Engineer, Frontend, Backend and Full-stack Engineers, QA, DevOps.
   - Or register custom agents. Each agent is a CLI runtime plus a name, role, expertise, optional model and instructions, and the same CLI can be registered under many roles.
   - Give agents skills from the [skills.sh](https://skills.sh) marketplace: search in the agent's drawer and add them. Orchestra fetches each skill from its GitHub repository when you save, and the agent reads a skill's instructions when a task calls for it. Skills are third-party instructions the agent follows with full access to its workspace, so add only ones you trust. Role presets come with a few well-known skills.
   - With no team yet, **Hire a starter team** adds a Director, a Full-stack Engineer and a QA Engineer on the CLIs you have installed.
   - **Test** an agent to check that its CLI is signed in, not just installed. It makes one small read-only call.
   - Each agent card shows its track record: tasks done, how many passed the first time, average attempts, failures, usage and reviews.
2. **New run.** The home page is one prompt box. Describe what you want, choose a project folder (browse your folders or paste a path in the folder picker, or pick a recent project), a team and a mode: **Keep improving** (the default), **Autonomous** (the Director approves its own plans and finishes after the original goal) or **Approve plans**. The path is checked as you go, so you see whether it will be created, initialized or used from its current commit. The team's named **Director** plans and staffs every run; it delegates and never takes a task itself.
   - Choose **Balanced**, **Quality**, **Speed** or **Economy**, an execution strategy and a parallel-worker ceiling. These preferences are saved per project; see below.
   - Under **Options**, optionally say how to check the project (for example `bun install && bun test`). The Director uses it as the plan's verify command unless it doesn't fit. Orchestra remembers it per project.
   - **Options → Agent & check timeouts** controls the time allowed for one agent call (45 minutes by default) and one check command (15 minutes). Adjust these again when resuming a paused run. The run's total time and call budgets still apply; parallelism remains part of the delivery preferences.
   - Also under **Options**, optionally list **non-goals**. They are added to the brief, and every plan, including continuous improvements, stays within them. Example briefs are offered while the brief is empty.
   - A missing or empty directory becomes a new git repo.
   - An existing repo must be given by its root and is used from its current `HEAD` (uncommitted changes are not included).
3. **Optional definition.** Clear briefs, including new CRUD apps and dashboards, go directly to a build plan with an early usable journey. When unresolved decisions block implementation, the Director plans focused groundwork (you approve it in supervised mode), choosing only the roles needed:
   - The PM writes `docs/product/spec.md`.
   - The designer writes `docs/design/ux.md`.
   - The tech lead writes `docs/engineering/design.md` and scaffolds the project.
   - The principal engineer reviews the design and records decisions in `docs/engineering/decisions.md`.
   - A supplied PRD guides implementation; it does not need to be rewritten into another document chain.
4. **Stage 2, build.** Once the definition work is merged, the Director reads those documents and plans implementation, QA and the final review. Plans declare stable acceptance requirements and tasks connect to them through contracts: input/output paths and exclusive resource claims. Each plan names a **verify command** (install, test, build) and a **reviewer** for the tasks that need one. In a supervised run you approve each plan, edit it (including requirements and acceptance commands) or send feedback for a revision.
5. **Execution.**
   - Tasks run when their dependencies are done and their declared paths/resources can be used together. The delivery policy limits parallel work; the scheduler also caps active workers at six globally and three per runtime. Each task runs in its own worktree on `orchestra/<run>-<task>`, branched from the current run branch.
   - When an agent finishes, Orchestra commits its work, runs the verify command and asks its assigned reviewer to review the diff. Reviewers receive Orchestra's check results for that revision so they can focus on uncovered behavior and targeted probes. Problems return to the same conversation, up to three attempts.
   - Orchestra then combines the task with the latest accepted revision in a separate integration candidate. It reruns verification and eligible requirement checks. Conflicts return to the same worker, and the resolved candidate receives fresh checks and an independent review. Only the checked candidate advances `orchestra/<run>` and releases dependent tasks. If its combined check fails, bounded diagnostic replays compare the accepted baseline and isolated task; reproduction evidence goes back to the worker.
   - If a declared input changed while the worker was busy, publication is withheld. Orchestra supplies the new revision and input contents, and the worker must reconcile its result and rerun checks. Observed changed files extend the task's scheduling claims; these claims guide coordination and do not sandbox file access.
   - A failed task blocks its dependents. An autonomous run hands failures to the Director, which re-plans the remaining work (twice at most, then pauses). Choose **Continue remaining work** to request another attempt. You can also retry a task, with instructions or a different assignee, or ask the Director to re-plan.
6. **Verification.** Orchestra checks a detached snapshot of the integrated build: the combined verify command, each command requirement and independent inspection for review requirements. Requirements with identical commands share one execution within a verification pass, with separate artifact validation and evidence for each requirement. Candidate and final acceptance checks still run separately. The Director reads those results against the goal and spec. Gaps become fix tasks (two automatic rounds per cycle; unresolved gaps pause with a report). Acceptance requires current evidence for every required outcome; a failed check or evidence for another revision cannot establish success.
7. **Review.** Read the Director's verification report and the changes, per run or per task, in the **Changes** tab. Comment on lines and send them to the Director for another round of fixes, or merge `orchestra/<run>` yourself. Orchestra never touches your checked-out branch.

## Delivery preferences and evidence

| Profile | Default parallel ceiling | Behavior |
|---|---:|---|
| **Balanced** | 3 | Starts with focused work and uses a team for independent assignments. |
| **Quality** | 2 | Adds independent reviewers to build/fix tasks where another team member is available, and asks the Director for broader verification. |
| **Speed** | 6 | Favors independent work and prioritizes tasks that block the remaining dependency chain. |
| **Economy** | 1 | Keeps one task active and asks for concise handoffs and targeted escalation. |

**Let Orchestra choose** recommends one active worker or a parallel team from the dependency graph, including parallel work unlocked by shared prerequisites. With enough comparable project history it also considers recorded acceptance, time and usage; the workspace shows its reason and sample count. These are retrospective observations. **One worker** serializes task execution while retaining the Director and independent reviews. **Parallel team** permits safe concurrency up to the selected ceiling. You can override the recommendation before starting; all profiles retain required acceptance checks and Git safety.

**Native delegation** is unavailable for normal runs: Orchestra cannot yet reserve native child calls against the persistent call budget or independently account for their usage. Both adapters disable native spawning. Agent capabilities describe Orchestra's active transport, and the runtime inventory exposes discovered configuration paths/counts without returning settings contents or credentials. Undiscovered managed policy and dynamic includes remain possible.

Requirements retain stable ids and versioned acceptance definitions. Requirement ids may use uppercase or lowercase letters, digits and hyphens, start with a letter or digit, and contain at most 40 characters (for example `R-VERIFY`). They are case-sensitive: task references must match exactly and later plans reuse the original spelling. Task ids remain lowercase because they become Git branch and worktree names. The workspace labels each **Satisfied**, **Failed**, **Stale** or **Unverified**. Only acceptance evidence for the accepted integration revision and current requirement version establishes an outcome. Task checks and candidate checks remain visible as progress evidence. The Director cannot automatically weaken an existing requirement; explicit plan edits retain history and invalidate older evidence.

Evidence records identify the revision, check or independent reviewer, requirement versions, duration and output. Requirements can name project-relative artifacts such as browser screenshots or test reports. Orchestra copies bounded regular files out of disposable worktrees and offers downloads; missing or unsupported expected files fail that check. Browser journeys use the project's own test commands and tooling. The live preview remains available for manual exploration; it does not establish acceptance by itself.

When the Director accepts a build, its proposed lessons retain the source run, revision and saved evidence references. **Project memory → Lessons with evidence** lets you remember or retire them. Only you add lessons to project memory. Retiring a lesson stops proposing it; edit memory separately to remove wording already saved.

## Skills and runtime integration

Skills are copied into Orchestra's library without silently updating existing installations. New installs record the source Git commit and bundled files. Older installations remain usable with unknown provenance. Compatibility notices identify references outside the copied folder, repository hooks/plugin/agent configuration that was omitted, declared tools and instructions that conflict with Orchestra-owned Git operations.

Superpowers and ECC profiles adapt their selected procedures to Orchestra's planning and integration rules. Installing a skill folder does not activate the complete upstream plugin: Superpowers' startup bootstrap and ECC's observation hooks, learning capture and commands require their own integration. Declared tool requirements are reported; inherited MCP/plugin tool availability is not fully determined.

Codex uses the [stdio app-server protocol](https://learn.chatgpt.com/docs/app-server) when a cached local help probe finds support. Otherwise it uses the batch CLI. Transport selection happens before work starts; a failed app-server invocation is reported without replaying it through the batch CLI. Claude Code uses batch stream-JSON. Both support session resume, structured output and cancellation; live steering is available through the Codex app-server adapter.

## Account usage safeguard

Open **Settings → Usage safeguard** in the sidebar to set one global ceiling for all agents and projects. Save it once; agents without an explicit override inherit it automatically, including existing agents. Global changes are read before each call and at the next periodic quota check of active calls. Paused runs still require their scheduled refill check or explicit Resume.

For exceptions, in an agent’s setup, enable **Usage safeguard** and choose a maximum used percentage and **5 hours**, **Weekly**, or **All available windows**. Under **New run → Options**, the same setting overrides the agents’ defaults for that project’s new runs and is saved on the server. Precedence is **project override → agent override → global setting**. Existing runs retain their project policy.

For example, 50% pauses the run when the provider reports 50% total account usage, including usage outside Orchestra. Orchestra reads subscription quota before every agent call and every minute during calls. On reaching the ceiling it stops in-flight processes, retains files, sessions and checkpoints, and waits until the affected window reports 0% used (100% available). It then resumes automatically, independently of the option to retry provider rate-limit errors. Manual Resume also checks for a full refill. If another window has reached its ceiling, that window must refill too.

This is a periodically checked safeguard: usage may cross the ceiling between checks or while concurrent calls are running. It requires a signed-in subscription with readable quota; API-key-only accounts, unavailable windows, login failures and unreadable quota pause for attention. Codex uses its [documented app-server quota API](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt); Claude uses the subscription usage endpoint used by its installed CLI, which may change between versions. No model calls are made to read quota, and credentials never reach the browser. Refill checks stop after five unsuccessful attempts. Waiting does not consume active time or agent calls, exhausted run budgets still require an increase, and a server restart requires explicit Resume.

## Continuous building and handoffs

New autonomous runs default to **Keep improving within the brief**, with **120 active minutes and 40 agent calls**. Pick the **Autonomous** mode to finish after the original goal, or edit the budget under **Options** before starting. Older runs retain their original single-goal behavior.

After each accepted build, the Director inspects the merged project and plans the next useful improvement: completeness, usability, reliability, tests or performance. It stays within your brief and explicit non-goals. If no worthwhile improvement remains, the run completes early. Each cycle retains its plan and verification report.

Agents pass a handoff to their dependents: changes, decisions, interfaces, remaining issues and guidance, accompanied by changed files, automatic check results, reviewer findings and the merge commit. The next agent receives both the handoff and the merged files. The workspace shows Plan → Build (or Improve) → Final checks → Ready. Finishing the assigned tasks starts combined checks and the Director's final review; that review may create follow-up tasks. Continuous runs show the already verified result separately from the improvement round in progress. Current tasks appear first, with completed and replaced tasks collapsed.

Long runs summarize older cycles and clip verbose handoff/check output in agent prompts while retaining revision references and acceptance requirements. Complete handoffs, history and evidence remain saved with the run.

**Send a note to the team** while a run is planning, running or awaiting approval: the note joins the run's guidance, and every later agent call receives it, without pausing. Active Codex app-server calls also receive a steering request; the invocation history records an acknowledgement when delivery succeeds. That acknowledgement confirms delivery, not that the agent has acted on the note. Batch calls, or failed live delivery, receive the saved note at their next invocation.

**Options → Continue automatically after rate limits reset** is an opt-in choice remembered for each project. When a Director, worker or reviewer hits a provider limit, the run pauses and continues after the reported reset time (including its timezone), with a one-minute buffer. If no usable reset time is reported, it retries after 15 minutes. There are at most five automatic retries per run, and the existing call/time budgets still apply. Waiting uses no active-time budget. Keep Orchestra running; restarting the server requires manual resume.

Provider limits also pause when automatic retry is off. **Move work to available agents** proposes replacements for unfinished worker and reviewer assignments using live subscription quota. Agents using the same CLI share the limited account and are excluded; unreadable, expired or exhausted quota never counts as available. Review the roles, choose independent reviewers, then **Apply transfers** and continue the run. Orchestra rechecks capacity before applying, keeps files, task phases, evidence and consumed budgets, and gives new workers fresh conversations with the saved context. Later plans avoid the transferred-away runtime. If no eligible teammate has confirmed capacity, add one to the run's team and check again. The Director is fixed for the run: if its account is limited too, transferring tasks still leaves the run waiting for that account to recover. Run budgets must still be increased separately when exhausted.

**Pause** stops new operations and lets current operations save a checkpoint. **Continue remaining work** continues on the same branch, retaining files, sessions and completed work/check/review phases. Instructions are optional; the team already receives its saved failures and review feedback. **Adjust budget** lets you increase the total budget; used time and calls do not reset. Paused time does not count toward active time. Server restarts require explicit continuation. Full reports remain under **Technical details**.

Every Director, worker, reviewer and conflict-resolution call counts. At the call limit, already-started calls finish but no more calls launch. At the time deadline, active agent and verify process groups are stopped. Both limits preserve work and pause the run. Budgets range from 1–1,440 minutes and 1–500 calls. Dollar usage remains informational because Codex does not report cost.

Exhausted recovery or fix limits also pause the run. Clicking **Continue remaining work** authorizes another bounded recovery plan or the saved fix batch, without resetting counters. If the attempt fails, the run pauses again. Extra instructions are optional.

For an opt-in demonstration with real agents, run `bun run test:autonomy codex` or `bun run test:autonomy claude-code haiku`. It uses an isolated scratch project, a five-minute/12-call budget, and checks for a completed dependent-agent handoff, merged work and unchanged user checkout. Reaching a budget reports `PAUSED` with exit code 0, rather than claiming the handoff test passed; actual failures or a completed run with no dependent handoff still fail. This makes real model calls and may incur usage charges. The script prints and retains its scratch directory so you can inspect the branch, reports and paused checkpoints. It also prints an `ORCHESTRA_HOME=… PORT=4322 bun run dev` command to open that saved database in a separate UI. For a paused run, increase the total active minutes or call limit there and resume; the existing branch and checkpoints are reused. Automated tests use fake agents and never call a model.

Each task shows its duration, attempts and usage; the run shows its total cost (reported by Claude Code) and tokens (both CLIs). Turn on **Notify me** in the top bar to get a browser notification when a run needs you while Orchestra is in the background.

State lives in `~/.orchestra` (override with `ORCHESTRA_HOME`): `orchestra.db` (SQLite) and `worktrees/`.

## Compare delivery strategies

The benchmark harness compares pinned source commits with the same independently executed acceptance commands. It supports direct Codex, direct Claude Code, native Codex and all four Orchestra profiles, optional models/skills, repeated trials, a wall-clock budget and an outer-agent-call budget. It provides comparison infrastructure; no measured superiority is claimed.

Create a version 1 JSON manifest, replacing the repository and full commit SHA with your case:

```json
{
  "version": 1,
  "cases": [{
    "id": "feature",
    "repo": "/absolute/path/to/project",
    "commit": "0123456789abcdef0123456789abcdef01234567",
    "prompt": "Implement the requested feature and preserve existing behavior.",
    "check": "bun test && bun run typecheck",
    "requirements": [{ "id": "journey", "check": "bun run test:e2e" }]
  }],
  "variants": [
    { "id": "direct-codex" },
    { "id": "direct-claude" },
    { "id": "orchestra-balanced", "runtime": "codex" },
    { "id": "orchestra-quality", "runtime": "claude-code" }
  ],
  "repeat": 2,
  "limits": { "maxDurationMs": 300000, "maxAgentCalls": 12 }
}
```

```sh
bun run test:benchmark manifest.json                         # dry run; no clones, installs, checks or agent calls
bun run test:benchmark manifest.json --allow-paid --output /tmp/orchestra-comparison
```

Each variant may specify `model` and skills.sh `skills` ids. Orchestra variants default to Codex; also available are `orchestra-speed` and `orchestra-economy`. Skill revisions are frozen within the comparison. Acceptance commands run with your user permissions, so supply commands and repositories you trust. Output directories must be empty; omitted `--output` creates a retained temporary directory.

The harness retains scratch repositories, baseline checks, exact delivered commits, acceptance worktrees, logs, configuration inventories, skill provenance and Orchestra databases/checkpoints. `results.json` and `results.csv` report accepted outcomes, regressions from initially passing checks, elapsed time, outer calls, reported tokens/dollars and rework where known. Trials run unattended, so human interventions are zero; missing usage and direct-worker rework remain unknown. A trial is accepted only when execution completes and every external acceptance check passes. Deadline exhaustion leaves unchecked outcomes unverified.

To compare the separately labeled `native-codex` baseline, add it to the manifest and pass both `--allow-paid` and `--allow-unmetered-native`. Its optional `maxNativeChildren` caps concurrent children (default two, maximum six). Its descendant call count and independent usage remain unknown, and the call limit counts outer invocations. This explicit benchmark exception does not enable native delegation in normal runs. Do not compare reported dollars, token counts and account subscription quotas as interchangeable measures.

## Security

Agents run **without permission prompts** so they can work unattended:
- Claude Code workers run with `--permission-mode bypassPermissions`, which is not OS-sandboxed.
- Codex workers run with `--sandbox workspace-write` and network access.
- The director and reviewers are read-only.
- The plan's verify command runs through `sh` without a sandbox, after every task and on the merged build. It comes from the Director (or your edit, or the check command you gave for the project) and, in an autonomous run, runs without anyone approving it first.
- Each agent invocation stops after 45 minutes and each verify run after 15.

Only point Orchestra at projects and prompts you trust.

The server binds to `127.0.0.1` only. It rejects requests whose `Host` isn't loopback, which blocks DNS rebinding. It also rejects requests whose `Origin` isn't the app itself, and mutations that aren't JSON, which blocks other websites from starting runs. There is no authentication, so other local users on the machine can reach it.

## Layout

```
src/shared/types.ts      types shared by server and UI
src/server/index.ts      entry: wires db, scheduler, HTTP server
src/server/http.ts       REST + WebSocket API, request guard, input validation
src/server/db.ts         SQLite schema and queries
src/server/runtimes.ts   capability detection, batch/app-server adapters, sessions, steering and usage
src/server/director.ts   plan schema, what to plan next, director prompts, plan validation
src/server/review.ts     reviewer schema and prompt
src/server/checks.ts     runs a plan's verify command
src/server/delivery.ts   delivery policies, requirement freshness, strategy recommendations and resource claims
src/server/artifacts.ts  bounded evidence-file capture from worktrees
src/server/skills.ts     skill installation, source provenance and compatibility reports
src/server/git.ts        workspace setup, worktrees, commit, verified candidate publication
src/server/scheduler.ts  plan → approve → work/check/review → candidate checks → acceptance
scripts/benchmark.ts     opt-in pinned-source delivery comparisons and retained results
src/web/                 React UI (served by Bun's HTML bundler); roles.ts holds the team presets
```

The **autonomy demo** suggestion on the home page (shown while the brief is empty) launches the same autonomy exercise with your configured team (a Director and at least two workers). It uses real agent CLIs and their configured models, with a five-minute / twelve-call budget. Orchestra creates a separate persistent scratch project under `$ORCHESTRA_HOME/demos/`; the run appears in normal history with live activity, handoffs, diffs and pause/resume controls. The demo does not create or change your team. CLI installation is checked; the CLIs must also be signed in.
