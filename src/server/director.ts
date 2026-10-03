import { z } from "zod";
import type { Agent, LogKind, Plan, PlanStage } from "../shared/types.ts";
import { PLAN_STAGES } from "../shared/types.ts";
import type { RunAgent } from "./runtimes.ts";

// Types only: constraints both CLIs' structured-output modes accept. Semantic rules live in validatePlan.
const PlanSchema = z.strictObject({
  summary: z.string(),
  stage: z.enum(PLAN_STAGES),
  tasks: z.array(
    z.strictObject({
      id: z.string(),
      title: z.string(),
      description: z.string(),
      agentId: z.string(),
      dependsOn: z.array(z.string()),
      acceptanceCriteria: z.string(),
    }),
  ),
});

const { $schema: _, ...planJsonSchema } = z.toJSONSchema(PlanSchema);
export { planJsonSchema };

export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
const MAX_TASKS = 20;

export class PlanError extends Error {}

/** Work already finished in this run; the build plan may depend on it but not reuse its ids. */
export type FinishedTask = { key: string; title: string; agent: string; summary: string };

/** Parses untrusted director output into a plan whose tasks form a DAG over known agents. */
export function validatePlan(
  raw: unknown,
  agentIds: Set<string>,
  opts: { finishedKeys?: Set<string>; stage?: PlanStage } = {},
): Plan {
  const parsed = PlanSchema.safeParse(raw);
  if (!parsed.success) throw new PlanError(`Plan does not match the schema: ${z.prettifyError(parsed.error)}`);
  const plan = parsed.data;
  const finished = opts.finishedKeys ?? new Set<string>();
  const problems: string[] = [];

  if (!plan.summary.trim()) problems.push("summary is empty");
  if (opts.stage && plan.stage !== opts.stage) problems.push(`stage must be "${opts.stage}"`);
  if (plan.tasks.length === 0) problems.push("plan has no tasks");
  if (plan.tasks.length > MAX_TASKS) problems.push(`plan has ${plan.tasks.length} tasks (max ${MAX_TASKS})`);

  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!TASK_ID.test(t.id)) problems.push(`task id "${t.id}" must be lowercase kebab-case (max 40 chars)`);
    if (ids.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
    if (finished.has(t.id)) problems.push(`task id "${t.id}" is already used by a finished task`);
    ids.add(t.id);
    if (!t.title.trim() || !t.description.trim()) problems.push(`task "${t.id}" needs a title and description`);
    if (!agentIds.has(t.agentId)) problems.push(`task "${t.id}" is assigned to unknown agent "${t.agentId}"`);
  }
  for (const t of plan.tasks) {
    for (const d of t.dependsOn) {
      if (d === t.id) problems.push(`task "${t.id}" depends on itself`);
      else if (!ids.has(d) && !finished.has(d)) problems.push(`task "${t.id}" depends on unknown task "${d}"`);
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

const DEFINITION_STAGE = `## How your team works
Like a real product team, the work happens in two stages:
1. Definition: product and technical groundwork before any feature code.
   - The Product Manager writes docs/product/spec.md: problem, target users, user stories, scope and explicit non-goals, testable acceptance criteria.
   - The Product Designer, when there is a user interface, writes docs/design/ux.md: flows, screens, every state (empty, loading, error), copy, accessibility.
   - The Tech Lead writes docs/engineering/design.md: stack, architecture, module boundaries, data model, interfaces, file layout, conventions, testing strategy. The Tech Lead also scaffolds the project skeleton (package setup, folders, shared types) so engineers can later work in parallel without collisions.
   - The Principal Engineer reviews the design for security, data integrity, performance and operability, improves it, and records decisions in docs/engineering/decisions.md.
   Design depends on the spec; the design review depends on the design. Leave out roles the goal does not need.
2. Build: implementation, QA and code review. You plan this stage later, after reading the definition documents.

Plan stage 1 now and set stage to "definition".
Only when the goal is small and unambiguous (a bug fix, a small script, a contained change to an existing project) skip definition: plan the whole build now and set stage to "build".`;

function buildStage(finished: FinishedTask[]) {
  return `## Stage 2: build
The team has finished the definition stage. Their work is merged into the current directory:
${finished.map((t) => `- ${t.title} (${t.key}, ${t.agent}): ${t.summary}`).join("\n")}

Read the documents in docs/ and the scaffolded code, then plan the build and set stage to "build":
- Split the engineering work along the module boundaries of the design so engineers can work in parallel. Each task names the documents and sections it implements.
- QA verifies the spec's acceptance criteria with automated tests once the features they cover are built.
- A final review by the Tech Lead or Principal Engineer checks the result against the spec and design and fixes what is wrong.
- Add DevOps work (build scripts, CI, README run instructions) where the project needs it.
Finished tasks may appear in dependsOn, but new task ids must differ from theirs.`;
}

export type Revision = { feedback: string; previous?: Plan };

function directorPrompt(director: Agent, roster: Agent[], goal: string, finished: FinishedTask[], revision?: Revision) {
  const team = roster.map(({ id, name, runtime, role, skills }) => ({ id, name, runtime, role, skills }));
  return `You are ${director.name}, the director of a product team coordinated by Orchestra. You are accountable for the outcome and think like a head of product and engineering combined: start from the user's problem, keep the scope to what delivers value, sequence the work so people can work in parallel without stepping on each other, staff each piece with the right person, and set a clear definition of done. You plan and delegate; you do not do the work yourself.
${director.instructions ? `\nAdditional instructions:\n${director.instructions}\n` : ""}
## Goal from the user
${goal}

## Your team
Assign every task to exactly one member, using the member's "id" as agentId. Match work to roles: product definition to product managers, UX to designers, architecture and reviews to tech leads and principal engineers, implementation to engineers, testing to QA, tooling to DevOps. If a role is missing, give the work to the closest fit.
${JSON.stringify(team, null, 2)}

## The project
The current directory contains the project as it is today (it may be empty). Inspect it read-only.

${finished.length ? buildStage(finished) : DEFINITION_STAGE}

## Writing tasks
- Tasks without a dependency between them run in parallel, each on its own git branch, and are merged afterwards. Parallel tasks must not edit the same files. Use dependsOn for real ordering needs.
- Each task is a meaningful piece of work that one member can finish in a single session. Prefer a handful of substantial tasks over many tiny ones.
- Task ids are short, unique, lowercase kebab-case, e.g. "api-routes".
- Each description must be self-contained: the assignee only sees the goal, the plan summary, its own task and summaries of the tasks it depends on. Name the files to create or change and the documents to follow.
- acceptanceCriteria lists checks that prove the task is done.
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
    /** Non-empty once the definition stage is done: the director then plans the build. */
    finished: FinishedTask[];
    revision?: Revision;
    onLog: (kind: LogKind, text: string) => void;
    signal?: AbortSignal;
  },
): Promise<Plan> {
  const res = await runAgent({
    agent: opts.director,
    mode: "director",
    prompt: directorPrompt(opts.director, opts.roster, opts.goal, opts.finished, opts.revision),
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
  return validatePlan(raw, new Set(opts.roster.map((a) => a.id)), planRules(opts.finished.map((t) => t.key)));
}

/** Validation rules for the next plan of a run, given the keys of its finished tasks. */
export const planRules = (finishedKeys: string[]) =>
  finishedKeys.length ? { finishedKeys: new Set(finishedKeys), stage: "build" as const } : {};
