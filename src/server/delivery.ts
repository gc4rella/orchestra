import type { Agent, DeliveryPolicy, Evidence, Plan, Requirement, RequirementSpec, Run, StrategyRecommendation, Task } from "../shared/types.ts";

export const MAX_GLOBAL_WORKERS = 6;
export const MAX_PROVIDER_WORKERS = 3;
export const MAX_REQUIREMENTS = 60;

/** Independence is mandatory; declared expertise only ranks eligible reviewers. */
export function chooseReviewer(agents: Agent[], authors: ReadonlySet<string>, context: string): { agent: Agent; reason: string } | null {
  const domains = [
    ["visual design and browser behavior", /\b(ui|ux|frontend|visual|designer|screenshot|viewport|accessibility|css|react)\b/i],
    ["API and data behavior", /\b(api|backend|database|sql|storage|migration|data integrity)\b/i],
    ["security", /\b(security|auth|permission|secret|encryption)\b/i],
    ["build and deployment", /\b(devops|deployment|ci|docker|pipeline|infrastructure)\b/i],
  ] as const;
  const relevant = domains.filter(([, pattern]) => pattern.test(context));
  const ranked = agents.filter((agent) => !authors.has(agent.id)).map((agent) => {
    const capabilities = `${agent.role} ${agent.expertise} ${agent.skills.map((skill) => `${skill.name} ${skill.description}`).join(" ")}`;
    const matches = relevant.filter(([, pattern]) => pattern.test(capabilities)).map(([name]) => name);
    const visualRole = matches.includes("visual design and browser behavior") && /\b(designer|frontend|ui|ux)\b/i.test(agent.role);
    const score = matches.length * 10 + (visualRole ? 4 : 0) + (/review|qa|quality|principal|tech lead/i.test(agent.role) ? 2 : 0);
    return { agent, score, reason: matches.length ? `Independent reviewer matched to ${matches.join(", ")} using declared role, expertise and skills.` : "Independent reviewer fallback; no matching specialist capability is registered." };
  }).sort((a, b) => b.score - a.score);
  return ranked[0] ?? null;
}

export const safeProjectPath = (path: string) => path.length > 0 && path.length <= 500 && !path.startsWith("/") && !path.includes("\\") && !/[\0\r\n*?[\]]/.test(path) && !path.split("/").some((part) => !part || part === "." || part === "..");

export function mergeRequirements(current: Requirement[], specs: RequirementSpec[], now: number): Requirement[] {
  const next = new Map(current.map((r) => [r.id, r]));
  for (const spec of specs) {
    const previous = next.get(spec.id);
    const unchanged = previous && Object.entries(spec).every(([key, value]) => JSON.stringify(previous[key as keyof RequirementSpec]) === JSON.stringify(value));
    next.set(spec.id, unchanged ? previous : { ...spec, version: (previous?.version ?? 0) + 1, updatedAt: now });
  }
  return [...next.values()];
}

export function requirementStatus(requirement: Requirement, evidence: Evidence[], commit: string | null): "satisfied" | "failed" | "stale" | "unverified" {
  const relevant = evidence.filter((e) => e.scope === "acceptance" && e.requirementIds.includes(requirement.id));
  const latest = relevant.findLast((e) => e.commit === commit && e.requirementVersions[requirement.id] === requirement.version);
  return latest ? latest.status === "passed" ? "satisfied" : latest.status === "failed" ? "failed" : "unverified" : relevant.length ? "stale" : "unverified";
}

export function recommendStrategy(policy: DeliveryPolicy, plan: Plan, history: Run[]): StrategyRecommendation {
  if (policy.strategy !== "auto") return { strategy: policy.strategy, reason: "Selected for this run.", samples: 0 };
  const size = (p: Plan) => p.tasks.length <= 1 ? "single" : p.tasks.length <= 5 ? "small" : "large";
  const samples = history.filter((r) => ["completed", "failed"].includes(r.status) && r.requirements.length && r.recommendation && r.delivery.profile === policy.profile && r.history.some((h) => h.plan?.stage === "build" && h.plan.tasks.length && size(h.plan) === size(plan)));
  if (policy.profile === "economy" || plan.tasks.length <= 1) return { strategy: "single", reason: policy.profile === "economy" ? "Economy starts with one focused worker and keeps required checks." : "This plan has one task; coordination would add overhead.", samples: samples.length };
  // A shared prerequisite can unlock parallel work later in the plan.
  const pending = new Map(plan.tasks.map((task) => [task.id, task]));
  let independent = 0;
  while (pending.size) {
    const ready = [...pending.values()].filter((task) => task.dependsOn.every((id) => !pending.has(id)));
    if (!ready.length) break;
    independent = Math.max(independent, ready.length);
    for (const task of ready) pending.delete(task.id);
  }
  if (independent > 1) {
    const groups = (["single", "team"] as const).map((strategy) => {
      const runs = samples.filter((r) => r.recommendation?.strategy === strategy);
      const accepted = runs.filter((r) => r.status === "completed").length;
      return { strategy, count: runs.length, accepted, rate: runs.length ? accepted / runs.length : 0, time: accepted ? runs.reduce((s, r) => s + r.activeElapsedMs, 0) / accepted : Infinity, tokens: accepted ? runs.reduce((s, r) => s + r.tokens, 0) / accepted : Infinity };
    });
    if (groups.every((g) => g.count >= 3 && g.accepted > 0)) {
      const bestRate = Math.max(...groups.map((g) => g.rate));
      const eligible = groups.filter((g) => g.rate === bestRate);
      const bestTime = Math.min(...eligible.map((g) => g.time));
      const bestTokens = Math.min(...eligible.map((g) => g.tokens));
      eligible.sort((a, b) => policy.profile === "speed" ? a.time - b.time : policy.profile === "quality" ? a.tokens - b.tokens : a.time / Math.max(1, bestTime) + a.tokens / Math.max(1, bestTokens) - b.time / Math.max(1, bestTime) - b.tokens / Math.max(1, bestTokens));
      const best = eligible[0]!;
      return { strategy: best.strategy, reason: `Similar ${size(plan)} plans in this project: ${best.accepted}/${best.count} accepted with ${best.strategy === "single" ? "one worker" : "a team"}. The profile compares acceptance first, then reported time and usage. Retrospective outcomes suggest a strategy; they do not establish causation.`, samples: samples.length };
    }
  }
  return { strategy: independent > 1 ? "team" : "single", reason: independent > 1 ? `Up to ${independent} tasks can run independently once their prerequisites finish. Declared resources and the provider limit still constrain parallel work.` : "The dependency chain is sequential. One active worker avoids contention.", samples: samples.length };
}

export function parallelism(run: Run): number {
  return run.delivery.strategy === "single" || run.delivery.profile === "economy" || run.recommendation?.strategy === "single" ? 1 : run.delivery.maxParallel;
}

/** Claims are conservative hints; observed changes are checked again before integration. */
export function tasksOverlap(a: Task, b: Task): boolean {
  const resources = new Set(a.contract.resources);
  if (b.contract.resources.some((r) => resources.has(r))) return true;
  const overlaps = (x: string, y: string) => x === y || x.startsWith(`${y}/`) || y.startsWith(`${x}/`);
  return a.contract.outputs.some((x) => [...b.contract.inputs, ...b.contract.outputs].some((y) => overlaps(x, y)))
    || b.contract.outputs.some((x) => a.contract.inputs.some((y) => overlaps(x, y)));
}
