import { z } from "zod";
import type { Agent, LogKind, Task } from "../shared/types.ts";
import type { RunAgent } from "./runtimes.ts";
import { skillsPrompt } from "./skills.ts";

// Strict and fully required, like PlanSchema, for Codex structured output.
const ReviewSchema = z.strictObject({
  verdict: z.enum(["approve", "changes"]),
  findings: z.string(),
});
export type Review = z.infer<typeof ReviewSchema>;

const { $schema: _, ...reviewJsonSchema } = z.toJSONSchema(ReviewSchema);
export { reviewJsonSchema };

export function reviewPrompt(reviewer: Agent, task: Task, author: string, diff: string) {
  return `You are ${reviewer.name}, the ${reviewer.role}, reviewing a teammate's work before Orchestra merges it.
${reviewer.instructions ? `\nAdditional instructions:\n${reviewer.instructions}\n` : ""}${skillsPrompt(reviewer.skills)}
## The task ${author} worked on: ${task.title}
${task.description}

### Acceptance criteria
${task.acceptance || "(none given)"}

## The change
The current directory holds the result; read any file you need. The diff of the change:
\`\`\`diff
${diff || "(no file changes)"}
\`\`\`

## How to review
- Check the change against the acceptance criteria and the project's documents in docs/ where they exist.
- Look for bugs, missing pieces, broken edge cases, security problems and code that doesn't fit the project's conventions.
- Request changes only for problems that matter; don't ask for style preferences or work outside this task.
- Reply with verdict "approve", or "changes" with findings: a numbered list of concrete problems, each saying where it is and what to do.`;
}

/** Runs the reviewer read-only in the task's worktree. Throws when it fails or answers out of schema. */
export async function invokeReview(
  runAgent: RunAgent,
  opts: { reviewer: Agent; task: Task; author: string; diff: string; cwd: string; onLog: (kind: LogKind, text: string) => void; signal?: AbortSignal },
): Promise<Review> {
  const res = await runAgent({
    agent: opts.reviewer,
    mode: "readonly",
    prompt: reviewPrompt(opts.reviewer, opts.task, opts.author, opts.diff),
    cwd: opts.cwd,
    schema: reviewJsonSchema,
    onLog: opts.onLog,
    signal: opts.signal,
  });
  if (!res.ok) throw new Error(`Reviewer failed: ${res.error ?? "unknown error"}`);
  let raw = res.structured;
  if (raw === undefined) {
    try {
      raw = JSON.parse(res.text);
    } catch {
      throw new Error("Reviewer did not return JSON");
    }
  }
  const parsed = ReviewSchema.safeParse(raw);
  if (!parsed.success) throw new Error(`Reviewer answer does not match the schema: ${z.prettifyError(parsed.error)}`);
  return parsed.data;
}
