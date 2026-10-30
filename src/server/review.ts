import { z } from "zod";
import type { Agent, CheckEvidence, LogKind, RequirementSpec, Task } from "../shared/types.ts";
import type { AgentResult, RunAgent } from "./runtimes.ts";
import { MAX_REQUIREMENTS } from "./delivery.ts";
import { skillsPrompt } from "./skills.ts";

// Strict and fully required, like PlanSchema, for Codex structured output.
const ReviewSchema = z.strictObject({
  verdict: z.enum(["approve", "changes"]),
  findings: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;
const RequirementReviewSchema = z.strictObject({ id: z.string(), verdict: z.enum(["approve", "changes"]), findings: z.string() });
const RequirementReviewsSchema = z.strictObject({ requirements: z.array(RequirementReviewSchema) });
export type RequirementReview = z.infer<typeof RequirementReviewSchema>;

const { $schema: _, ...reviewJsonSchema } = z.toJSONSchema(ReviewSchema);
const { $schema: _requirements, ...requirementReviewsJsonSchema } = z.toJSONSchema(RequirementReviewsSchema);
export { reviewJsonSchema, requirementReviewsJsonSchema };

type ReviewOptions = { reviewer: Agent; author: string; diff: string; cwd: string; checks?: CheckEvidence[]; onLog: (kind: LogKind, text: string) => void; signal?: AbortSignal };

function reviewContextPrompt(reviewer: Agent, task: Pick<Task, "title" | "description" | "acceptance">, author: string, diff: string, checks: CheckEvidence[] = []) {
  return `You are ${reviewer.name}, the ${reviewer.role}, reviewing a teammate's work before Orchestra merges it.
Your expertise: ${reviewer.expertise || "general software review"}. Apply the skills relevant to this task and its risks.
${reviewer.instructions ? `\nAdditional instructions:\n${reviewer.instructions}\n` : ""}${skillsPrompt(reviewer.skills)}
## The task ${author} worked on: ${task.title}
${task.description}

### Acceptance criteria
${task.acceptance || "(none given)"}

## Checks already run by Orchestra on this revision
${checks.length ? JSON.stringify(checks.slice(-8).map((check) => ({ ...check, output: check.output.slice(-2000) }))) : "No automatic check evidence supplied."}
These results establish only what the commands actually cover. Use them instead of repeating the same full suite; run targeted probes for specific suspected defects or uncovered criteria. Your read-only sandbox may prevent test caches, databases or browsers from starting. A sandbox restriction is not a code defect and retrying the same blocked command does not provide evidence. Required behavior without evidence still needs verification; identify the missing check and the environment it needs.

## The change
The current directory holds the result; read any file you need. The diff of the change:
\`\`\`diff
${diff || "(no file changes)"}
\`\`\`

## How to review
- Check the change against the acceptance criteria and the project's documents in docs/ where they exist.
- Look for bugs, missing pieces, broken edge cases, security problems and code that doesn't fit the project's conventions.
- For UI work, inspect the task's visual contract and required desktop/narrow-screen screenshots, and check the primary browser journey evidence. Compare hierarchy, typography, spacing, responsive layout, readable content, keyboard behavior and representative states with that contract. A running preview or passing code checks alone do not establish visual fidelity.
- Request changes for concrete visual fidelity or usability defects, with the affected screen/viewport, violated criterion, evidence and a focused fix. Personal style preferences and unrelated redesigns are not defects. If required browser evidence or image-inspection tools are missing, identify the verification gap instead of asserting a visual pass.
- Request changes only for problems that matter and stay within this task's acceptance criteria and agreed design.`;
}

export function reviewPrompt(reviewer: Agent, task: Pick<Task, "title" | "description" | "acceptance">, author: string, diff: string, checks: CheckEvidence[] = []) {
  return `${reviewContextPrompt(reviewer, task, author, diff, checks)}\n- Reply with verdict "approve", or "changes" with findings: a numbered list of concrete problems, each saying where it is and what to do.`;
}

function reviewAnswer(result: AgentResult): unknown {
  if (!result.ok) throw new Error(`Reviewer failed: ${result.error ?? "unknown error"}`);
  if (result.structured !== undefined) return result.structured;
  try { return JSON.parse(result.text); }
  catch { throw new Error("Reviewer did not return JSON"); }
}

/** Runs the reviewer read-only in the task's worktree. Throws when it fails or answers out of schema. */
export async function invokeReview(
  runAgent: RunAgent,
  opts: ReviewOptions & { task: Pick<Task, "title" | "description" | "acceptance"> },
): Promise<Review> {
  const res = await runAgent({
    agent: opts.reviewer,
    mode: "readonly",
    prompt: reviewPrompt(opts.reviewer, opts.task, opts.author, opts.diff, opts.checks),
    cwd: opts.cwd,
    schema: reviewJsonSchema,
    onLog: opts.onLog,
    signal: opts.signal,
  });
  const parsed = ReviewSchema.safeParse(reviewAnswer(res));
  if (!parsed.success) throw new Error(`Reviewer answer does not match the schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}

/** Share an inspection call, while keeping a complete, independent verdict for every requirement. */
export async function invokeRequirementReviews(
  runAgent: RunAgent,
  opts: ReviewOptions & { requirements: Pick<RequirementSpec, "id" | "title" | "description">[]; context?: string },
): Promise<RequirementReview[]> {
  const ids = new Set(opts.requirements.map((requirement) => requirement.id));
  if (ids.size !== opts.requirements.length) throw new Error("Requirement review inputs contain duplicate ids");
  if (opts.requirements.length > MAX_REQUIREMENTS) throw new Error(`Requirement review exceeds ${MAX_REQUIREMENTS} requirements`);
  if (!opts.requirements.length) return [];
  if (opts.requirements.length === 1) {
    const requirement = opts.requirements[0]!;
    const review = await invokeReview(runAgent, { ...opts, task: { title: requirement.title, description: `${requirement.description}${opts.context ? `\n${opts.context}` : ""}`, acceptance: requirement.description } });
    return [{ id: requirement.id, ...review }];
  }
  const task = {
    title: "Independent acceptance requirements",
    description: `Inspect every requirement separately against this exact revision. Shared code and check evidence may inform several verdicts, but one passing requirement cannot substitute for another.${opts.context ? `\n${opts.context}` : ""}`,
    acceptance: JSON.stringify(opts.requirements),
  };
  const result = await runAgent({
    agent: opts.reviewer, mode: "readonly", cwd: opts.cwd, schema: requirementReviewsJsonSchema, onLog: opts.onLog, signal: opts.signal,
    prompt: `${reviewContextPrompt(opts.reviewer, task, opts.author, opts.diff, opts.checks)}
- Return only JSON with a requirements array. Include exactly one {id, verdict, findings} entry for each supplied id: ${JSON.stringify([...ids])}.
- For each requirement independently, use verdict "approve" when its complete criteria are supported, or "changes" with concrete numbered findings and missing evidence. Do not merge verdicts, omit ids, add ids or use one requirement's success to hide another's failure.`,
  });
  const parsed = RequirementReviewsSchema.safeParse(reviewAnswer(result));
  if (!parsed.success) throw new Error(`Requirement reviewer answer does not match the schema: ${z.prettifyError(parsed.error)}`);
  const reviews = new Map<string, RequirementReview>();
  for (const review of parsed.data.requirements) {
    if (!ids.has(review.id)) throw new Error(`Requirement reviewer returned unknown id "${review.id}"`);
    if (reviews.has(review.id)) throw new Error(`Requirement reviewer returned duplicate id "${review.id}"`);
    reviews.set(review.id, review);
  }
  const missing = [...ids].filter((id) => !reviews.has(id));
  if (missing.length) throw new Error(`Requirement reviewer omitted ids: ${missing.join(", ")}`);
  return opts.requirements.map((requirement) => reviews.get(requirement.id)!);
}
