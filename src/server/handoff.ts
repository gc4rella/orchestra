import { z } from "zod";
import type { Handoff } from "../shared/types.ts";
import type { AgentResult } from "./runtimes.ts";

const HandoffSchema = z.strictObject({
  summary: z.string(), decisions: z.array(z.string()), interfaces: z.array(z.string()),
  blockers: z.array(z.string()), verified: z.array(z.string()), skillIds: z.array(z.string()),
});
const { $schema: _, ...handoffJsonSchema } = z.toJSONSchema(HandoffSchema);
export { handoffJsonSchema };

/** Worker claims provide context. Files and check/review evidence still come from Orchestra. */
export function workerHandoff(result: Pick<AgentResult, "text" | "structured">, skillIds: string[]): Pick<Handoff, "text" | "details"> {
  if (result.structured === undefined) return { text: result.text.trim() };
  const parsed = HandoffSchema.safeParse(result.structured);
  if (!parsed.success) throw new Error("Worker returned an invalid structured handoff");
  const { summary, ...details } = parsed.data;
  if (!summary.trim() || summary.length > 20_000 || Object.values(details).some((values) => values.length > 30 || values.some((value) => value.length > 2_000))) throw new Error("Worker handoff is empty or exceeds its bounds");
  if (details.skillIds.some((id) => !skillIds.includes(id)) || new Set(details.skillIds).size !== details.skillIds.length) throw new Error("Worker claimed skills outside its assigned skill pack");
  return { text: summary.trim(), details };
}
