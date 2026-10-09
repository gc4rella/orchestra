import { z } from "zod";
import type { Agent, LogKind, Plan, PlanStage, Task } from "../shared/types.ts";
import { PLAN_STAGES } from "../shared/types.ts";
import type { RunAgent } from "./runtimes.ts";

// Types only: constraints both CLIs' structured-output modes accept. Semantic rules live in validatePlan.
const PlanSchema = z.strictObject({
  summary: z.string(),
  stage: z.enum(PLAN_STAGES),
  verify: z.string(),
  tasks: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      agentId: z.string(),
      reviewerId: z.string(),
      dependsOn: z.array(z.string()),
      acceptanceCriteria: z.string(),
    }),
  ),
});

const { $schema: _, ...planJsonSchema } = z.toJSONSchema(PlanSchema);
export { planJsonSchema };

export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TASKS = 20;
const MAX_VERIFY = 500;

export class PlanError extends Error {}

/** What the next plan of a run must look like, given the tasks it already has. */
export type PlanRules = {
  /** Finished tasks: the plan may depend on them. */
  doneKeys?: Set<string>;
  /** Every existing task id, done or not: the plan may not reuse them. */
  takenKeys?: Set<string>;
  /** Stages the plan may have; any but "fix" when unset. */
  stages?: PlanStage[];
};

/** Parses untrusted director output into a plan whose tasks form a DAG over known agents. */
export function validatePlan(raw: unknown, agentIds: Set<string>, rules: PlanRules = {}): Plan {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) throw new PlanError(`Plan does not match the schema: ${z.prettifyError(parsed.error)}`);
  const plan = parsed.data;
  const done = rules.doneKeys ?? new Set<string>();
  const taken = rules.takenKeys ?? done;
  const stages = rules.stages ?? ["definition", "build"];
  const problems: string[] = [];

  if (!plan.summary.trim()) problems.push("summary is empty");
  if (!stages.includes(plan.stage)) problems.push(`stage must be ${stages.map((s) => `"${s}"`).join(" or ")}`);
  // An empty fix plan is the director accepting the build.
  if (plan.tasks.length === 0 && plan.stage !== "fix") problems.push("plan has no tasks");
  if (plan.tasks.length > MAX_TASKS) problems.push(`plan has ${plan.tasks.length} tasks (max ${MAX_TASKS})`);
  if (plan.verify.length > MAX_VERIFY) problems.push(`verify command is longer than ${MAX_VERIFY} characters`);
  if (/[\0\r\n]/.test(plan.verify)) problems.push("verify command must be a single line");

  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!TASK_ID.test(t.id)) problems.push(`task id "${t.id}" must be lowercase kebab-case (max 40 chars)`);
    if (ids.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
    if (taken.has(t.id)) problems.push(`task id "${t.id}" is already used by an earlier task`);
    ids.add(t.id);
    if (!t.title.trim() || !t.description.trim()) problems.push(`task "${t.id}" needs a title and description`);
    if (!agentIds.has(t.agentId)) problems.push(`task "${t.id}" is assigned to unknown agent "${t.agentId}"`);
    if (t.reviewerId && !agentIds.has(t.reviewerId)) problems.push(`task "${t.id}" has unknown reviewer "${t.reviewerId}"`);
    if (t.reviewerId && t.reviewerId === t.agentId) problems.push(`task "${t.id}" is reviewed by its own assignee`);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) problems.push(`task "${t.id}" depends on itself`);
      else if (!ids.has(d) && !done.has(d)) {
        problems.push(taken.has(d) ? `task "${t.id}" depends on unfinished earlier task "${d}"` : `task "${t.id}" depends on unknown task "${d}"`);
      }
    }
  }
  if (problems.length === 0) {
    const cycle = findCycle(plan.tasks);
    if (cycle) problems.push(`dependency cycle among tasks: ${cycle.join(", ")}`);
  }
  if (problems.length) throw new PlanError(`Invalid plan:\n- ${problems.join("\n- ")}`);
  return plan;
}

/** Kahn's algorithm; returns the tasks left over when the graph is cyclic. Dependencies outside the plan count as met. */
function findCycle(tasks: { id: string; dependsOn: string[] }[]): string[] | null {
  const remaining = new Map(tasks.map((t) => [t.id, new Set(t.dependsOn)]));
  let progressed = true;
  while (progressed) {
    progressed = false;
    for (const [id, deps] of remaining) {
      if ([...deps].every((d) => !remaining.has(d))) {
        remaining.delete(id);
        progressed = true;
      }
    }
  }
  return remaining.size ? [...remaining.keys()] : null;
}

/**
 * Why the director plans next:
 * - "initial": the first plan, definition or straight to build.
 * - "build": definition work is done.
 * - "recover": tasks failed; the plan replaces them and everything blocked behind them, in the same stage.
 * - "fix": the build is done; the director verifies it and plans fixes, or none to accept it.
 */
export type Purpose = "initial" | "build" | "recover" | "fix";

/** Derives the next planning purpose and its rules from a run's tasks (in insertion order). */
export function nextPlanning(tasks: Pick<Task, "key" | "status" | "stage">[]): { purpose: Purpose; stage: PlanStage | null; rules: PlanRules } {
  const latest = tasks.at(-1)?.stage;
  if (!latest) return { purpose: "initial", stage: null, rules: {} };
  const base = { doneKeys: new Set(tasks.filter((t) => t.status === "done").map((t) => t.key)), takenKeys: new Set(tasks.map((t) => t.key)) };
  const at = (purpose: Purpose, stage: PlanStage) => ({ purpose, stage, rules: { ...base, stages: [stage] } });
  if (tasks.some((t) => t.status === "failed" || t.status === "blocked")) return at("recover", latest);
  return latest === "definition" ? at("build", "build") : at("fix", "fix");
}

const DEFINITION_STAGE = `## How your team works
Like a real product team, the work happens in two stages:
1. Definition: product and technical groundwork before any feature code.
   - The Product Manager writes docs/product/spec.md: problem, target users, user stories, scope and explicit non-goals, testable acceptance criteria.
   - The Product Designer, when there is a user interface, writes docs/design/ux.md: flows, screens, every state (empty, loading, error), copy, accessibility.
   - The Tech Lead writes docs/engineering/design.md: stack, architecture, module boundaries, data model, interfaces, file layout, conventions, testing strategy. The Tech Lead also scaffolds the project skeleton (package setup, folders, shared types) so engineers can later work in parallel without collisions.
   - The Principal Engineer reviews the design for security, data integrity, performance and operability, improves it, and records decisions in docs/engineering/decisions.md.
   Design depends on the spec; the design review depends on the design. Leave out roles the goal does not need.
2. Build: implementation, QA and code review. You plan this stage later, after reading the definition documents.
3. Verification: once the build is merged, you check it against the goal and plan fixes for what is missing.

Plan stage 1 now and set stage to "definition".
Only when the goal is small and unambiguous (a bug fix, a small script, a contained change to an existing project) skip definition: plan the whole build now and set stage to "build".`;

/** Work already in the run, as the director sees it. */
export type TaskBrief = { key: string; title: string; agent: string; status: Task["status"]; summary: string; error: string };

function buildStage(done: TaskBrief[]) {
  return `## Stage 2: build
The team has finished the definition stage. Their work is merged into the current directory:
${done.map((t) => `- ${t.title} (${t.key}, ${t.agent}): ${t.summary}`).join("\n")}

Read the documents in docs/ and the scaffolded code, then plan the build and set stage to "build":
- Split the engineering work along the module boundaries of the design so engineers can work in parallel. Each task names the documents and sections it implements.
- QA verifies the spec's acceptance criteria with automated tests once the features they cover are built.
- A final review by the Tech Lead or Principal Engineer checks the result against the spec and design and fixes what is wrong.
- Add DevOps work (build scripts, CI, README run instructions) where the project needs it.
Finished tasks may appear in dependsOn, but new task ids must differ from theirs.`;
}

function recoverStage(stage: PlanStage, tasks: TaskBrief[]) {
  const done = tasks.filter((t) => t.status === "done");
  const stuck = tasks.filter((t) => t.status === "failed" || t.status === "blocked");
  return `## Recovering from failed work
The team is in the ${stage} stage and some of its work failed.
${done.length ? `Finished and merged into the current directory:\n${done.map((t) => `- ${t.title} (${t.key}, ${t.agent}): ${t.summary}`).join("\n")}\n` : ""}
Failed, or blocked behind a failure:
${stuck.map((t) => `- ${t.title} (${t.key}, ${t.agent}) [${t.status}]${t.error ? `: ${t.error}` : ""}`).join("\n")}

Plan everything this stage still needs and set stage to "${stage}". Your plan replaces the failed and blocked tasks.
- Find the cause of each failure in its error. Then retry the work with a sharper description, split it into smaller tasks, give it to a better-suited member, or drop it if the goal doesn't need it. Explain your choices in summary.
- New task ids must differ from every existing id (${tasks.map((t) => t.key).join(", ")}). dependsOn may name finished tasks only.`;
}

/** Output of the plan's verify command on the merged build; null when there is none. */
export type CheckReport = { command: string; ok: boolean; output: string } | null;

function fixStage(tasks: TaskBrief[], check: CheckReport, finalRound: boolean) {
  const done = tasks.filter((t) => t.status === "done");
  return `## Verification
The team has finished the build. This work is merged into the current directory:
${done.map((t) => `- ${t.title} (${t.key}, ${t.agent}): ${t.summary}`).join("\n")}

${
  check
    ? `The verify command \`${check.command}\` ${check.ok ? "passed" : "FAILED"} on the merged result. Its output:\n\`\`\`\n${check.output.trim() || "(no output)"}\n\`\`\``
    : "There is no verify command, so nothing was run automatically."
}

Verify the result yourself: read the code and tests and check them against the goal, the acceptance criteria in docs/product/spec.md and the design in docs/engineering/ (where they exist). Set stage to "fix".
${
  finalRound
    ? `- If the goal is met and the checks pass, return no tasks. summary is your verification report: what you checked and how it holds up.
- Otherwise list a task for each remaining gap. This is the last round, so they will not run: they go to the user as open items with your report. summary is the verification report listing each gap.`
    : `- If the goal is met and the checks pass, return no tasks. summary is your verification report: what you checked and how it holds up.
- Otherwise plan tasks that fix what is missing or broken, and make summary the verification report listing each gap. Plan only real gaps, not polish.
- Finished tasks may appear in dependsOn, but new task ids must differ from theirs.`
}`;
}

export type Revision = { feedback: string; previous?: Plan };

/** Everything the director is told besides the goal and the team. */
export type PlanContext = {
  purpose: Purpose;
  /** Stage of the plan to produce; null for the first plan. */
  stage: PlanStage | null;
  tasks: TaskBrief[];
  /** The run's current verify command, carried into the next plan. */
  verify: string;
  check?: CheckReport;
  finalRound?: boolean;
  revision?: Revision;
};

function purposeSection(ctx: PlanContext) {
  if (ctx.purpose === "initial") return DEFINITION_STAGE;
  if (ctx.purpose === "build") return buildStage(ctx.tasks.filter((t) => t.status === "done"));
  if (ctx.purpose === "recover") return recoverStage(ctx.stage ?? "build", ctx.tasks);
  return fixStage(ctx.tasks, ctx.check ?? null, ctx.finalRound ?? false);
}

function directorPrompt(director: Agent, roster: Agent[], goal: string, ctx: PlanContext) {
  const team = roster.map(({ id, name, runtime, role, skills }) => ({ id, name, runtime, role, skills }));
  const { revision } = ctx;
  return `You are ${director.name}, the director of a product team coordinated by Orchestra. You are accountable for the outcome and think like a head of product and engineering combined: start from the user's problem, keep the scope to what delivers value, sequence the work so people can work in parallel without stepping on each other, staff each piece with the right person, and set a clear definition of done. You plan and delegate; you do not do the work yourself.
${director.instructions ? `\nAdditional instructions:\n${director.instructions}\n` : ""}
## Goal from the user
${goal}

## Your team
Assign every task to exactly one member, using the member's "id" as agentId. Match work to roles: product definition to product managers, UX to designers, architecture and reviews to tech leads and principal engineers, implementation to engineers, testing to QA, tooling to DevOps. If a role is missing, give the work to the closest fit.
${JSON.stringify(team, null, 2)}

## The project
The current directory contains the project as it is today (it may be empty). Inspect it read-only.

${purposeSection(ctx)}

## Writing tasks
- Tasks without a dependency between them run in parallel, each on its own git branch, and are merged afterwards. Parallel tasks must not edit the same files. Use dependsOn for real ordering needs.
- Each task is a meaningful piece of work that one member can finish in a single session. Prefer a handful of substantial tasks over many tiny ones.
- Task ids are short, unique, lowercase kebab-case, e.g. "api-routes".
- Each description must be self-contained: the assignee only sees the goal, the plan summary, its own task and summaries of the tasks it depends on. Name the files to create or change and the documents to follow.
- acceptanceCriteria lists checks that prove the task is done.
- reviewerId is a different member who reviews the task before it is merged and can send it back with findings. Give core logic, shared interfaces and risky changes a reviewer (a Tech Lead, Principal Engineer or QA); use "" for documents and small, low-risk tasks.
- verify is one shell command that checks the whole project from a fresh checkout without user input: install dependencies, then run the tests, typecheck or build, and lint, e.g. "npm ci && npm test && npm run build". Orchestra runs it after every task and sends failures back to the assignee, so every task must leave the project passing it. Use "" while there is nothing to check yet, as in the definition stage.${ctx.verify ? ` The current verify command is \`${ctx.verify}\`; keep it unless it needs to change.` : ""}
- summary explains the approach and the reasoning behind the staffing and ordering in a few sentences.
${
  revision
    ? `\n## Feedback from the user\n${revision.previous ? `On your previous plan:\n${JSON.stringify(revision.previous, null, 2)}\n\n` : ""}${revision.feedback}\n\nProduce a plan that addresses the feedback.\n`
    : ""
}
Respond only with the plan as JSON matching the required schema.`;
}

export async function invokeDirector(
  runAgent: RunAgent,
  opts: {
    director: Agent;
    roster: Agent[];
    goal: string;
    cwd: string;
    context: PlanContext;
    /** Rules the plan must satisfy, from `nextPlanning`. */
    rules: PlanRules;
    onLog: (kind: LogKind, text: string) => void;
    signal?: AbortSignal;
  },
): Promise<Plan> {
  const res = await runAgent({
    agent: opts.director,
    mode: "readonly",
    prompt: directorPrompt(opts.director, opts.roster, opts.goal, opts.context),
    cwd: opts.cwd,
    schema: planJsonSchema,
    onLog: opts.onLog,
    signal: opts.signal,
  });
  if (!res.ok) throw new PlanError(`Director failed: ${res.error ?? "unknown error"}`);
  let raw = res.structured;
  if (raw === undefined) {
    try {
      raw = JSON.parse(res.text);
    } catch {
      throw new PlanError("Director did not return JSON");
    }
  }
  return validatePlan(raw, new Set(opts.roster.map((a) => a.id)), opts.rules);
}
