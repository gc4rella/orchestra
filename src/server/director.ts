import { z } from "zod";
import type { Agent, LogKind, Plan, PlanStage, Task, PlanningPurpose, Handoff, Requirement, DeliveryPolicy, CheckEvidence, RunHistory, Run, DirectorChatTurn, Evidence } from "../shared/types.ts";
import { PLAN_STAGES } from "../shared/types.ts";
import type { RunAgent } from "./runtimes.ts";
import { SKILL_ID, skillsPrompt } from "./skills.ts";
import { MAX_REQUIREMENTS, safeProjectPath } from "./delivery.ts";

// Types only: constraints both CLIs' structured-output modes accept. Semantic rules live in validatePlan.
const LegacyPlanSchema = z.strictObject({
  summary: z.string(),
  stage: z.enum(PLAN_STAGES),
  verify: z.string(),
  lessons: z.string(),
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

export const ContractSchema = z.strictObject({ requirementIds: z.array(z.string()), inputs: z.array(z.string()), outputs: z.array(z.string()), resources: z.array(z.string()), skillIds: z.array(z.string()).optional(), ui: z.boolean().optional() });
export const RequirementSchema = z.strictObject({ id: z.string(), title: z.string(), description: z.string(), kind: z.enum(["command", "review"]), check: z.string(), required: z.boolean(), inputs: z.array(z.string()), artifacts: z.array(z.string()) });
const CompatiblePlanSchema = LegacyPlanSchema.extend({ version: z.literal(2), requirements: z.array(RequirementSchema), tasks: z.array(LegacyPlanSchema.shape.tasks.element.extend({ contract: ContractSchema })) });
export const PlanSchema = CompatiblePlanSchema.extend({ tasks: z.array(LegacyPlanSchema.shape.tasks.element.extend({ contract: ContractSchema.extend({ skillIds: z.array(z.string()), ui: z.boolean() }) })) });

const { $schema: _, ...planJsonSchema } = z.toJSONSchema(PlanSchema);
export { planJsonSchema };

export const TASK_ID = /^[a-z0-9][a-z0-9-]{0,39}$/;
// Requirement labels are case-sensitive references, not Git branch or worktree names.
const REQUIREMENT_ID = /^[A-Za-z0-9][A-Za-z0-9-]{0,39}$/;
const MAX_TASKS = 20;
const MAX_VERIFY = 500;
const MAX_LESSONS = 2000;
const MAX_TASK_SKILLS = 3;

export class PlanError extends Error {}

/** What the next plan of a run must look like, given the tasks it already has. */
export type PlanRules = {
  /** Finished tasks: the plan may depend on them. */
  doneKeys?: Set<string>;
  improvement?: boolean;
  /** Every existing task id, done or not: the plan may not reuse them. */
  takenKeys?: Set<string>;
  /** Stages the plan may have; any but "fix" when unset. */
  stages?: PlanStage[];
  requirements?: Requirement[];
  allowRequirementAmendment?: boolean;
  agentSkills?: ReadonlyMap<string, ReadonlySet<string>>;
};

/** Parses untrusted director output into a plan whose tasks form a DAG over known agents. */
export function validatePlan(raw: unknown, agentIds: Set<string>, rules: PlanRules = {}): Plan {
  const parsed = (raw && typeof raw === "object" && "version" in raw ? CompatiblePlanSchema : LegacyPlanSchema).safeParse(raw);
  if (!parsed.success) throw new PlanError(`Plan does not match the schema: ${z.prettifyError(parsed.error)}`);
  const plan: Plan = parsed.data;
  const done = rules.doneKeys ?? new Set<string>();
  const taken = rules.takenKeys ?? done;
  const stages = rules.stages ?? ["definition", "build"];
  const problems: string[] = [];

  if (rules.improvement && plan.stage === "fix" && plan.tasks.length) problems.push("improvement planning must return build tasks or an empty fix plan");
  if (!plan.summary.trim()) problems.push("summary is empty");
  if (!stages.includes(plan.stage)) problems.push(`stage must be ${stages.map((s) => `"${s}"`).join(" or ")}`);
  // An empty fix plan is the director accepting the build.
  if (plan.tasks.length === 0 && plan.stage !== "fix") problems.push("plan has no tasks");
  if (plan.tasks.length > MAX_TASKS) problems.push(`plan has ${plan.tasks.length} tasks (max ${MAX_TASKS})`);
  if (plan.verify.length > MAX_VERIFY) problems.push(`verify command is longer than ${MAX_VERIFY} characters`);
  if (/[\0\r\n]/.test(plan.verify)) problems.push("verify command must be a single line");
  if (plan.lessons.length > MAX_LESSONS) problems.push(`lessons are longer than ${MAX_LESSONS} characters`);
  const proposed = plan.requirements ?? [];
  const requirements = new Map((rules.requirements ?? []).map((r) => [r.id, r]));
  const declared = new Set<string>();
  if (proposed.length > MAX_REQUIREMENTS || requirements.size + proposed.filter((r) => !requirements.has(r.id)).length > MAX_REQUIREMENTS) problems.push(`at most ${MAX_REQUIREMENTS} requirements are allowed`);
  for (const r of proposed) {
    if (!REQUIREMENT_ID.test(r.id)) problems.push(`requirement id "${r.id}" must start with a letter or digit and contain only letters, digits and hyphens (max 40 chars)`);
    if (declared.has(r.id)) problems.push(`duplicate requirement id "${r.id}"`);
    declared.add(r.id);
    if (!r.title.trim() || !r.description.trim() || r.title.length > 200 || r.description.length > 5000) problems.push(`requirement "${r.id}" needs a bounded title and description`);
    if (r.check.length > MAX_VERIFY || /[\0\r\n]/.test(r.check) || (r.kind === "command" ? !r.check.trim() : !!r.check)) problems.push(`requirement "${r.id}" needs a single-line command or an empty review check`);
    if ([...r.inputs, ...r.artifacts].some((path) => !safeProjectPath(path)) || r.inputs.length > 30 || r.artifacts.length > 20) problems.push(`requirement "${r.id}" has invalid project paths`);
    const previous = requirements.get(r.id);
    if (previous && !rules.allowRequirementAmendment && Object.entries(r).some(([key, value]) => JSON.stringify(previous[key as keyof typeof r]) !== JSON.stringify(value))) problems.push(`requirement "${r.id}" changes an existing acceptance check; edit the plan explicitly to amend it`);
    requirements.set(r.id, { ...r, version: previous?.version ?? 1, updatedAt: previous?.updatedAt ?? 0 });
  }
  if (plan.version === 2 && ![...requirements.values()].some((r) => r.required)) problems.push("version 2 plans need at least one required requirement");

  const ids = new Set<string>();
  for (const t of plan.tasks) {
    if (!TASK_ID.test(t.id)) problems.push(`task id "${t.id}" must be lowercase kebab-case (max 40 chars)`);
    if (t.id === "integration") problems.push('task id "integration" is reserved for the accepted worktree');
    if (ids.has(t.id)) problems.push(`duplicate task id "${t.id}"`);
    if (taken.has(t.id)) problems.push(`task id "${t.id}" is already used by an earlier task`);
    ids.add(t.id);
    if (!t.title.trim() || !t.description.trim()) problems.push(`task "${t.id}" needs a title and description`);
    if (!agentIds.has(t.agentId)) problems.push(`task "${t.id}" is assigned to unknown agent "${t.agentId}"`);
    if (t.reviewerId && !agentIds.has(t.reviewerId)) problems.push(`task "${t.id}" has unknown reviewer "${t.reviewerId}"`);
    if (t.reviewerId && t.reviewerId === t.agentId) problems.push(`task "${t.id}" is reviewed by its own assignee`);
    if (t.contract) {
      if (!t.acceptanceCriteria.trim()) problems.push(`task "${t.id}" needs acceptance criteria`);
      if (t.contract.requirementIds.some((id) => !requirements.has(id)) || !t.contract.requirementIds.length) problems.push(`task "${t.id}" must reference known requirements`);
      if ([...t.contract.inputs, ...t.contract.outputs].some((path) => !safeProjectPath(path))) problems.push(`task "${t.id}" has invalid contract paths`);
      if ([t.contract.inputs, t.contract.outputs, t.contract.resources, t.contract.requirementIds].some((a) => a.length > 30) || t.contract.resources.some((v) => !v.trim() || v.length > 100)) problems.push(`task "${t.id}" has excessive contract claims`);
      const skillIds = t.contract.skillIds ?? [];
      if (skillIds.length > MAX_TASK_SKILLS || skillIds.some((id) => !SKILL_ID.test(id))) problems.push(`task "${t.id}" must select at most ${MAX_TASK_SKILLS} valid marketplace skill ids`);
      if (new Set(skillIds).size !== skillIds.length) problems.push(`task "${t.id}" has duplicate selected skills`);
      if (rules.agentSkills && skillIds.some((id) => !rules.agentSkills!.get(t.agentId)?.has(id))) problems.push(`task "${t.id}" selects skills not registered for its assignee`);
      if (t.contract.ui) {
        if (!skillIds.length) problems.push(`UI task "${t.id}" must select a relevant skill`);
        const outcomes = t.contract.requirementIds.flatMap((id) => requirements.get(id) ?? []);
        if (!outcomes.some((r) => r.required && r.kind === "command" && r.artifacts.some((path) => /\.(?:png|jpe?g|webp)$/i.test(path)))) problems.push(`UI task "${t.id}" needs a required browser command requirement with screenshot artifacts`);
        if (!outcomes.some((r) => r.required && r.kind === "review")) problems.push(`UI task "${t.id}" needs a required independent visual review requirement`);
      }
    }
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
export type Purpose = PlanningPurpose;

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
Optimize for the first usable result. When the brief already supplies the product behavior and a conventional implementation is sufficient, plan stage "build" directly, including for a new CRUD app or dashboard. Let the first implementation task make routine design decisions, scaffold the project and deliver a working end-to-end journey. A detailed PRD is input to implementation, not a request to rewrite it.
Use stage "definition" only when unresolved product or technical decisions genuinely block implementation. Keep that groundwork focused; the roles below are options, not a checklist:
1. Definition: product and technical groundwork before any feature code.
   - The Product Manager writes docs/product/spec.md: problem, target users, user stories, scope and explicit non-goals, testable acceptance criteria.
   - The Product Designer, when there is a user interface, writes docs/design/ux.md: compact visual direction, typography and spacing/color tokens, responsive layout, flows, screens, every state (empty, loading, error), copy, accessibility and concrete visual fidelity criteria.
   - The Tech Lead writes docs/engineering/design.md: stack, architecture, module boundaries, data model, interfaces, file layout, conventions, testing strategy. The Tech Lead also scaffolds the project skeleton (package setup, folders, shared types) so engineers can later work in parallel without collisions.
   - The Principal Engineer reviews the design for security, data integrity, performance and operability, improves it, and records decisions in docs/engineering/decisions.md.
   Design depends on the spec; the design review depends on the design. Leave out roles the goal does not need.
2. Build: implementation, QA and code review. You plan this stage later, after reading the definition documents.
3. Verification: once the build is merged, you check it against the goal and plan fixes for what is missing.

Choose the stage that gets useful software to the user soonest. Do not add document alignment, design review or scaffolding handoffs unless they resolve a concrete blocker.`;

/** Work already in the run, as the director sees it. */
export type TaskBrief = { key: string; title: string; agent: string; status: Task["status"]; cycle: number; summary: string; error: string; mergeCommit?: string | null; handoff?: Handoff | null };

const MAX_SUMMARY = 1_500;
const MAX_HANDOFF_TEXT = 4_000;
const MAX_EVIDENCE_OUTPUT = 2_000;
const MAX_HANDOFF_FILES = 50;
const MAX_CYCLE_NOTE = 1_500;
const MAX_EARLIER_SUMMARY = 300;
export const MAX_EARLIER_CYCLES = 12_000;

export const clip = (text: string, max: number) => text.length > max ? `${text.slice(0, max)}… [${text.length - max} more characters]` : text;
const clipTail = (text: string, max: number) => text.length > max ? `[${text.length - max} earlier characters] …${text.slice(-max)}` : text;
const compactCheck = (check: CheckEvidence | null) => check && { ...check, output: clipTail(check.output, MAX_EVIDENCE_OUTPUT) };
const compactReview = (review: Handoff["review"]) => review && { ...review, findings: clip(review.findings, MAX_EVIDENCE_OUTPUT) };

/** Prompt excerpts retain revision provenance; the full evidence stays in storage. */
export function compactHandoff(handoff: Handoff): Handoff & { omittedFiles?: number } {
  return {
    ...handoff,
    text: clip(handoff.text, MAX_HANDOFF_TEXT),
    ...(handoff.details ? { details: Object.fromEntries(Object.entries(handoff.details).map(([key, values]) => [key, values.slice(0, 5).map((value) => clip(value, 500))])) as NonNullable<Handoff["details"]> } : {}),
    files: handoff.files.slice(0, MAX_HANDOFF_FILES),
    ...(handoff.files.length > MAX_HANDOFF_FILES ? { omittedFiles: handoff.files.length - MAX_HANDOFF_FILES } : {}),
    check: compactCheck(handoff.check),
    review: compactReview(handoff.review),
    ...(handoff.integration ? { integration: { ...handoff.integration, check: compactCheck(handoff.integration.check), review: compactReview(handoff.integration.review) } } : {}),
  };
}

function earlierCycles(tasks: TaskBrief[], history: RunHistory[], latest: number) {
  const cycles = [...new Set([...tasks.map((t) => t.cycle), ...history.map((h) => h.cycle)])].filter((cycle) => cycle < latest).sort((a, b) => b - a);
  const parts: string[] = [];
  let used = 0;
  for (const [index, cycle] of cycles.entries()) {
    const entries = history.filter((h) => h.cycle === cycle);
    const summary = entries.map((h) => h.plan?.summary).filter(Boolean).join(" ");
    const report = entries.findLast((h) => h.report)?.report;
    const done = tasks.filter((t) => t.cycle === cycle && t.status === "done");
    const part = [
      `### Cycle ${cycle}`,
      summary && `Plan: ${clip(summary, MAX_CYCLE_NOTE)}`,
      report && `Report: ${clip(report, MAX_CYCLE_NOTE)}`,
      done.length && `Finished:\n${done.map((t) => `- ${t.title} (${t.key}): ${clip(t.summary, MAX_EARLIER_SUMMARY)}`).join("\n")}`,
    ].filter(Boolean).join("\n");
    if (used + part.length > MAX_EARLIER_CYCLES) {
      if (!parts.length) parts.push(clip(part, MAX_EARLIER_CYCLES));
      parts.push(`(${cycles.length - index} older cycle(s) left out or shortened; their work is in the project files.)`);
      break;
    }
    parts.push(part);
    used += part.length;
  }
  return parts.length ? `## Earlier cycles\nThis work is merged into the current directory.\n${parts.join("\n\n")}\n\n` : "";
}

const taskLine = (task: TaskBrief) => `- ${task.title} (${task.key}, ${task.agent}): ${clip(task.summary, MAX_SUMMARY)}`;

function buildStage(done: TaskBrief[]) {
  return `## Stage 2: build
The team has finished the definition stage. Their work is merged into the current directory:
${done.map(taskLine).join("\n")}

Read the documents in docs/ and the scaffolded code, then plan the build and set stage to "build":
- Split the engineering work along the module boundaries of the design so engineers can work in parallel. Each task names the documents and sections it implements.
- QA verifies the spec's acceptance criteria with automated tests once the features they cover are built.
- Use task reviewers and Orchestra's final acceptance checks for review. Add a separate review task only for a concrete risk those checks do not cover; do not create a review of another review.
- Add DevOps work (build scripts, CI, README run instructions) where the project needs it.
Finished tasks may appear in dependsOn, but new task ids must differ from theirs.`;
}

function recoverStage(stage: PlanStage, tasks: TaskBrief[], takenKeys: string[]) {
  const done = tasks.filter((t) => t.status === "done");
  const stuck = tasks.filter((t) => t.status === "failed" || t.status === "blocked");
  return `## Recovering from failed work
The team is in the ${stage} stage and some of its work failed.
${done.length ? `Finished and merged into the current directory:\n${done.map(taskLine).join("\n")}\n` : ""}
Failed, or blocked behind a failure:
${stuck.map((t) => `- ${t.title} (${t.key}, ${t.agent}) [${t.status}]${t.error ? `: ${clipTail(t.error, MAX_EVIDENCE_OUTPUT)}` : ""}`).join("\n")}

Plan everything this stage still needs and set stage to "${stage}". Your plan replaces the failed and blocked tasks.
- Find the cause of each failure in its error. Then retry the work with a sharper description, split it into smaller tasks, give it to a better-suited member, or drop it if the goal doesn't need it. Explain your choices in summary.
- New task ids must differ from every existing id (${takenKeys.join(", ")}). dependsOn may name finished tasks only.`;
}

/** Output of the plan's verify command on the merged build; null when there is none. */
export type CheckReport = CheckEvidence | null;

function fixStage(tasks: TaskBrief[], check: CheckReport, finalRound: boolean) {
  const done = tasks.filter((t) => t.status === "done");
  return `## Verification
The team has finished the build. This work is merged into the current directory:
${done.map(taskLine).join("\n")}

${
  check
    ? `The verify command \`${check.command}\` ${check.ok ? "passed" : "FAILED"} on the merged result. Its output:\n\`\`\`\n${clipTail(check.output.trim(), MAX_EVIDENCE_OUTPUT) || "(no output)"}\n\`\`\``
    : "There is no verify command, so nothing was run automatically."
}

Verify the result yourself: read the code and tests and check them against the goal, the acceptance criteria in docs/product/spec.md and the design in docs/engineering/ (where they exist). Set stage to "fix".
${
  finalRound
    ? `- If the goal is met and the checks pass, return no tasks. summary is your verification report: what you checked and how it holds up.
- Otherwise list a task for each remaining gap. This is the last round, so they will not run: they go to the user as open items with your report. summary is the verification report listing each gap.`
    : `- If the goal is met and the checks pass, return no tasks. summary is your verification report: what you checked and how it holds up.
- Otherwise plan tasks that fix what is missing or broken, and make summary the verification report listing each gap. Broken visual fidelity, responsive behavior and missing required browser evidence are real gaps. Avoid cosmetic changes unrelated to the agreed design or goal.
- Finished tasks may appear in dependsOn, but new task ids must differ from theirs.`
}`;
}

export type Revision = { feedback: string; previous?: Plan };

/** Everything the director is told besides the goal and the team. */
export type PlanContext = {
  delivery?: DeliveryPolicy;
  requirements?: Requirement[];
  acceptance?: string;
  purpose: Purpose;
  guidance?: string;
  /** Stage of the plan to produce; null for the first plan. */
  stage: PlanStage | null;
  tasks: TaskBrief[];
  history?: RunHistory[];
  /** The run's current verify command, carried into the next plan. */
  verify: string;
  /** How the user says the project is checked; "" when they didn't say. */
  checkCommand?: string;
  check?: CheckReport;
  finalRound?: boolean;
  revision?: Revision;
};

function purposeSection(ctx: PlanContext, recent: TaskBrief[]) {
  if (ctx.purpose === "improve") return `## Continuous improvement
The previous cycle was verified. Inspect the current project and choose the next useful, bounded improvement within the original brief and its explicit non-goals.
Prioritize completeness, usability, reliability, meaningful tests and performance. Do not add unrelated features, make major architecture changes, or create cosmetic churn. Worker suggestions are advisory.
Return a nonempty build plan for a concrete improvement with testable acceptance criteria. If no worthwhile improvement remains, return an empty fix plan and explain why in summary.
Previously completed work and handoff evidence:
${JSON.stringify(recent.filter((t) => t.status === "done").map(({ handoff: _, ...task }) => ({ ...task, summary: clip(task.summary, MAX_SUMMARY), error: clipTail(task.error, MAX_EVIDENCE_OUTPUT) })))}`;
  if (ctx.purpose === "initial") return DEFINITION_STAGE;
  if (ctx.purpose === "build") return buildStage(recent.filter((t) => t.status === "done"));
  if (ctx.purpose === "recover") return recoverStage(ctx.stage ?? "build", recent, ctx.tasks.map((t) => t.key));
  return fixStage(recent, ctx.check ?? null, ctx.finalRound ?? false);
}

function directorPrompt(director: Agent, roster: Agent[], goal: string, ctx: PlanContext) {
  const team = roster.map(({ id, name, runtime, model, effort, role, expertise, skills }) => ({
    id, name, runtime, model, effort, role, expertise,
    skills: skills.map((skill) => ({
      id: skill.id, name: skill.name, description: clip(skill.description, 512), revision: skill.revision ?? null,
      compatibility: skill.compatibility ? {
        status: skill.compatibility.status, requiredTools: skill.compatibility.requiredTools.slice(0, 10),
        notices: skill.compatibility.notices.slice(0, 4).map((notice) => clip(notice, 500)),
      } : null,
    })),
  }));
  const { revision } = ctx;
  const latest = Math.max(0, ...ctx.tasks.map((task) => task.cycle));
  const recent = ctx.tasks.filter((task) => task.cycle === latest);
  return `You are ${director.name}, the director of a product team coordinated by Orchestra. You are accountable for the outcome and think like a head of product and engineering combined: start from the user's problem, keep the scope to what delivers value, sequence the work so people can work in parallel without stepping on each other, staff each piece with the right person, and set a clear definition of done. You plan and delegate; you do not do the work yourself.
${director.instructions ? `\nAdditional instructions:\n${director.instructions}\n` : ""}${skillsPrompt(director.skills)}
## Goal from the user
${goal}
${ctx.guidance ? `\n## Current guidance from the user\n${ctx.guidance}\n` : ""}

## Your team
Assign every task to exactly one member, using the member's "id" as agentId. Match work to roles: product definition to product managers, UX to designers, architecture and reviews to tech leads and principal engineers, implementation to engineers, testing to QA, tooling to DevOps. Prefer demonstrated task fit from expertise and skill descriptions over a role label alone. Assign UI implementation to a member with frontend design capability and UI review to an independent member with design, frontend or browser-testing expertise. If that capability is absent, name the closest-fit fallback and verification gap in summary; do not imply a specialist is available.
Model and effort are the member's configured choices, with null meaning an unknown CLI default; do not infer model quality or tools from a runtime name. Skill revisions identify the installed instructions. Compatibility notices and declared tools describe integration needs, not proof that those tools are available. Name the few relevant skills in each task description; do not require unrelated playbooks or read every teammate's skill before planning.
${JSON.stringify(team, null, 2)}

## The project
The current directory contains the project as it is today (it may be empty). Inspect it read-only.

## Delivery policy and acceptance contract
${JSON.stringify(ctx.delivery ?? { profile: "balanced", strategy: "auto", maxParallel: 3 })}
Return version: 2. Requirements describe user-visible outcomes from the original brief and retain stable ids across plans. Include all initial outcomes now, including ones implemented in later stages. Never omit an unmet outcome to declare success. Existing requirements remain in force when requirements is empty. On later plans, return requirements: [] unless adding genuinely new outcomes, and reference the existing ids in task contracts. Do not restate or paraphrase existing requirements: every field is immutable to automatic plans, including titles, descriptions, inputs and artifacts. Only an explicit user plan edit can amend them.
Requirement ids must be unique within the plan, start with a letter or digit, and contain only letters, digits and hyphens (max 40 chars), e.g. "R-VERIFY" or "verify-build". Requirement ids are case-sensitive: reuse existing ids exactly, including their case, and copy them exactly into each task's contract.requirementIds. Do not rename an existing requirement or create a new id just to change its case.
${JSON.stringify(ctx.requirements ?? [])}
${ctx.acceptance ?? ""}
For each requirement use kind command with an executable one-line check, or kind review with check empty when independent inspection is needed. Browser journeys may use the project's browser test command and relative artifact paths. Do not invent passing evidence. Existing command checks cannot be weakened or replaced automatically.
For a new or materially changed UI, include a compact visual contract in the first implementation task or existing docs/design/ux.md: the existing design system or chosen visual direction, typography and spacing/color tokens, layout hierarchy, desktop/narrow-screen behavior, representative states and concrete fidelity criteria. Keep the direct build path; a separate design/document stage is needed only for a concrete blocker.
UI acceptance needs a required command requirement that exercises the primary browser journey and produces named desktop and narrow-screen screenshot artifacts, plus a required independent review requirement for fidelity to that visual contract. Declare browser commands before visual reviews, and name the screenshots and covered screens/viewports in the review description. Reuse the project's browser tooling; create a bounded reproducible script if needed. A screenshot proves only what is visible; browser assertions must check the journey's behavior. Do not substitute build/type/unit checks or a running preview for browser or visual evidence. Backend-only tasks do not need this UI procedure.
When a worker's sandbox blocks a required browser or other verification tool, plan a reproducible test script and include its invocation in verify so Orchestra's check runner executes it outside the agent sandbox. Keep existing requirements intact. Do not repeatedly assign the same blocked manual probe or substitute unit tests for required browser evidence. If verification needs unavailable credentials, devices or external services, report that concrete blocker without claiming completion.
Every task must have nonempty acceptanceCriteria and a contract naming requirementIds, explicit relative input/output file or module paths, and exclusive resource names (for example database-schema). These are scheduling claims, not permission grants. Avoid overlapping outputs in parallel tasks. Use empty arrays when there are no path or resource claims.
Set contract.skillIds to 1–3 relevant installed skill ids from the assignee's roster entry, or [] when none applies. Those selected instructions travel with the task; do not select a teammate's skill or invent an installation. Set contract.ui to true when the task changes rendered UI code, and false for backend work or documentation-only design tasks. UI tasks must select at least one relevant skill and reference both the required screenshot-producing browser command and independent visual review requirements.
Economy prefers one worker and targeted escalation. Speed exposes independent work on the critical path. Quality assigns independent reviewers and broader behavioral checks. Balanced uses the smallest practical team. All profiles retain the same required acceptance checks. The Director remains the planner; it never implements a task.

${earlierCycles(ctx.tasks, ctx.history ?? [], latest)}${purposeSection(ctx, recent)}

## Handoff evidence
${JSON.stringify(recent.flatMap((t) => t.handoff ? [{ key: t.key, handoff: compactHandoff(t.handoff) }] : []))}

## Writing tasks
- Tasks without a dependency between them run in parallel, each on its own git branch, and are merged afterwards. Parallel tasks must not edit the same files. Use dependsOn for real ordering needs.
- Each task is a meaningful piece of work that one member can finish in a single session. Prefer a handful of substantial tasks over many tiny ones. Start with a usable end-to-end slice and split later work only where independent ownership saves time. Team size is available capacity, not a staffing target.
- Task ids are short, unique, lowercase kebab-case, e.g. "api-routes".
- Each description must be self-contained: the assignee only sees the goal, the plan summary, its own task and summaries of the tasks it depends on. Name the files to create or change and the documents to follow.
- acceptanceCriteria lists checks that prove the task is done.
- reviewerId is a different member who reviews the task before it is merged and can send it back with findings. Give core logic, shared interfaces, materially changed UI and risky changes a reviewer whose expertise and skills match the risk; use "" for documents and small, low-risk tasks. Independent review and relevant capability both matter.
- verify is one shell command that checks the whole project from a fresh checkout without user input: install dependencies, then run the tests, typecheck or build, and lint, e.g. "npm ci && npm test && npm run build". Orchestra runs it after every task and sends failures back to the assignee, so every task must leave the project passing it. Use "" while there is nothing to check yet, as in the definition stage.${ctx.verify ? ` The current verify command is \`${ctx.verify}\`; keep it unless it needs to change.` : ""}${ctx.checkCommand ? ` The user checks this project with \`${ctx.checkCommand}\`; use it as verify once there is code to check, unless it clearly doesn't fit.` : ""}
- summary explains the approach and the reasoning behind the staffing and ordering in a few sentences, including relevant skills and any missing-capability fallback.
- lessons: only when you return no tasks and accept the build, list what a future run on this project should know that neither the project memory nor the project's own docs already say: how to check it, pitfalls the team hit, corrections the user gave. One short line each, at most ten; the user decides which to keep. Otherwise use "".
${
  revision
    ? `\n## Feedback from the user\n${revision.previous ? `On your previous plan:\n${JSON.stringify(revision.previous, null, 2)}\n\n` : ""}${revision.feedback}\n\nProduce a plan that addresses the feedback.\n`
    : ""
}
Respond only with the plan as JSON matching the required schema.`;
}

export function directorChatPrompt(director: Agent, run: Run, tasks: TaskBrief[], turns: DirectorChatTurn[], evidence: Evidence[], commit: string) {
  // Keep recent complete exchanges within a fixed context budget; full history stays in the database.
  const recent: { user: string; director: string }[] = [];
  let remaining = 40_000;
  for (const turn of turns.filter((turn) => turn.status === "completed").slice(-20).reverse()) {
    const exchange = { user: turn.text, director: turn.reply };
    const size = JSON.stringify(exchange).length;
    if (size > remaining) break;
    remaining -= size;
    recent.unshift(exchange);
  }
  return `You are ${director.name}, the Director of this team in Orchestra, answering the user's side chat about this run, which may be working, paused, awaiting approval or finished.
${director.instructions ? `\nAdditional instructions:\n${director.instructions}\n` : ""}${skillsPrompt(director.skills)}
Answer the question directly and concisely in plain language. Use the run snapshot below and inspect project files read-only when useful. Explain uncertainties and distinguish planned, in-progress and verified work. The snapshot may change while you answer.
This conversation is advisory. It does not change the brief, plan, tasks, guidance or run state. Do not edit files, run checks, commit, delegate or claim to have instructed the team. For requested changes, explain how to use "Send a note to the team", plan revision, or Pause/Resume in the workspace. Only Orchestra's recorded acceptance evidence establishes completion.

## Run snapshot
Goal: ${run.prompt}
Status: ${run.status}
Phase: ${run.purpose ?? "initial"}; cycle: ${run.cycle}
This directory is an isolated snapshot of the integrated branch at ${commit}; unmerged worker edits are not included.
Plan: ${clip(JSON.stringify(run.plan), 16_000)}
Tasks: ${clip(JSON.stringify(tasks.map((task) => ({ ...task, summary: clip(task.summary, 2000), error: clip(task.error, 2000), handoff: undefined }))), 24_000)}
Requirements: ${clip(JSON.stringify(run.requirements), 12_000)}
Recent evidence: ${JSON.stringify(evidence.slice(-20).map(({ scope, commit, status, requirementIds, command }) => ({ scope, commit, status, requirementIds, command })))}
Run error: ${run.error ?? "none"}
Report: ${clip(run.report ?? "", 6000)}

## Earlier conversation
${JSON.stringify(recent)}

## User's question
${turns.at(-1)?.text ?? ""}`;
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
  return validatePlan(raw, new Set(opts.roster.map((a) => a.id)), { ...opts.rules, agentSkills: opts.rules.agentSkills ?? new Map(opts.roster.map((agent) => [agent.id, new Set(agent.skills.map((skill) => skill.id))])) });
}
