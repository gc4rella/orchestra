import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { z } from "zod";
import type { Agent, DeliveryProfile, Skill, Usage } from "../src/shared/types.ts";
import { defaultDeliveryPolicy, DIRECTOR_ROLE } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { runCheck } from "../src/server/checks.ts";
import { assertWorktreeRevision, commitAll, headCommit, openDetachedWorktree } from "../src/server/git.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import { detectRuntimes, runAgent, runtimeEnvironment, type RunAgent } from "../src/server/runtimes.ts";
import { ensureSkills, SKILL_ID, skillsPrompt } from "../src/server/skills.ts";

export const BENCHMARK_VARIANTS = ["direct-codex", "direct-claude", "native-codex", "orchestra-balanced", "orchestra-quality", "orchestra-speed", "orchestra-economy"] as const;
const identifier = z.string().regex(/^[A-Za-z0-9][\w.-]{0,79}$/);
const command = z.string().trim().min(1).max(2000).refine((value) => !/[\0\r\n]/.test(value), "check must be one line");
const requirement = z.object({ id: identifier, check: command }).strict();
const skillIds = z.array(z.string().regex(SKILL_ID)).max(20);
const BENCHMARK_ROLES = ["director", "engineer", "reviewer"] as const;
type BenchmarkRole = typeof BENCHMARK_ROLES[number];
type RoleSkills = Record<BenchmarkRole, Skill[]>;
const variant = z.object({
  id: z.enum(BENCHMARK_VARIANTS), runtime: z.enum(["codex", "claude-code"]).optional(),
  model: z.string().max(200).regex(/^[A-Za-z0-9][A-Za-z0-9._:/-]*$/).optional(),
  skills: skillIds.default([]),
  roleSkills: z.object({ director: skillIds.optional(), engineer: skillIds.optional(), reviewer: skillIds.optional() }).strict().optional(),
  maxNativeChildren: z.number().int().min(1).max(6).default(2),
}).strict();
export const BenchmarkManifestSchema = z.object({
  version: z.literal(1),
  cases: z.array(z.object({
    id: identifier, repo: z.string().min(1).max(2000).refine((value) => !value.startsWith("-") && !/[\0\r\n]/.test(value)),
    commit: z.string().regex(/^[a-fA-F0-9]{40}(?:[a-fA-F0-9]{24})?$/).transform((value) => value.toLowerCase()), prompt: z.string().trim().min(1).max(50_000),
    check: command, requirements: z.array(requirement).max(60).default([]),
  }).strict()).min(1).max(100),
  variants: z.array(variant).min(1).max(30), repeat: z.number().int().min(1).max(20).default(1),
  limits: z.object({ maxDurationMs: z.number().int().min(1000).max(86_400_000), maxAgentCalls: z.number().int().min(1).max(1000) }).strict()
    .default({ maxDurationMs: 300_000, maxAgentCalls: 12 }),
}).strict().superRefine((manifest, context) => {
  for (const [key, values] of [["cases", manifest.cases], ["variants", manifest.variants]] as const) {
    if (new Set(values.map((value) => value.id)).size !== values.length) context.addIssue({ code: "custom", path: [key], message: `${key} ids must be unique` });
  }
  for (const [index, item] of manifest.cases.entries()) {
    const ids = item.requirements.map((value) => value.id);
    if (new Set(ids).size !== ids.length || ids.includes("acceptance")) context.addIssue({ code: "custom", path: ["cases", index, "requirements"], message: "requirement ids must be unique and cannot be acceptance" });
  }
  for (const [index, value] of manifest.variants.entries()) {
    if (!value.id.startsWith("orchestra-") && value.runtime !== undefined) context.addIssue({ code: "custom", path: ["variants", index, "runtime"], message: "runtime is selected by the direct/native variant id" });
    if (!value.id.startsWith("orchestra-") && value.roleSkills !== undefined) context.addIssue({ code: "custom", path: ["variants", index, "roleSkills"], message: "roleSkills is supported only by Orchestra variants; direct/native workers use skills" });
  }
});
export type BenchmarkManifest = z.infer<typeof BenchmarkManifestSchema>;
type Case = BenchmarkManifest["cases"][number];
type Variant = BenchmarkManifest["variants"][number];
type Acceptance = { id: string; command: string; status: "passed" | "failed" | "unverified"; output: string };
export type BenchmarkResult = {
  caseId: string; variantId: Variant["id"]; repeat: number; sourceCommit: string; finalCommit: string | null; directory: string;
  status: string; acceptance: "passed" | "failed" | "unverified"; accepted: boolean; checks: Acceptance[];
  elapsedMs: number; outerAgentCalls: number; reportedTokens: number | null; reportedCostUsd: number | null;
  childAccounting: "disabled" | "unknown"; humanInterventions: number; rework: number | null; regressions: number | null; error: string | null;
};
type Options = {
  allowPaid?: boolean; allowUnmeteredNative?: boolean; outputDir?: string; manifestDir?: string; agentRunner?: RunAgent;
  skillInstaller?: typeof ensureSkills;
  onProgress?: (message: string) => void;
};

/** Explicit role packs override the shared fallback; an empty pack intentionally uses no skills. */
export function benchmarkRoleSkills(selected: Variant): Record<BenchmarkRole, string[]> {
  return { director: selected.roleSkills?.director ?? selected.skills, engineer: selected.roleSkills?.engineer ?? selected.skills, reviewer: selected.roleSkills?.reviewer ?? selected.skills };
}

export function benchmarkPlan(manifest: BenchmarkManifest) {
  return {
    version: 1, paid: false, trials: manifest.cases.flatMap((item) => manifest.variants.flatMap((selected) =>
      Array.from({ length: manifest.repeat }, (_, repeat) => ({ caseId: item.id, sourceCommit: item.commit, variantId: selected.id, repeat: repeat + 1,
        skills: selected.id.startsWith("orchestra-") ? benchmarkRoleSkills(selected) : { engineer: selected.skills }, checks: [item.check, ...item.requirements.map((entry) => entry.check)] })))),
    limits: manifest.limits,
    notices: ["Dry run: no agent CLIs, repository clones, skill installs or checks are executed.", "An explicit roleSkills pack replaces shared skills for that role; omitted roles inherit skills, and an empty pack removes them. Execution retains installed source revisions by role.", "Execution requires --allow-paid. Native Codex also requires --allow-unmetered-native; concurrent children are capped, while independent child calls and usage remain unknown."],
  };
}

export function summarizeBenchmark(results: BenchmarkResult[]) {
  return [...new Set(results.map((result) => result.variantId))].map((variantId) => {
    const rows = results.filter((result) => result.variantId === variantId);
    const sumKnown = (key: "reportedTokens" | "reportedCostUsd" | "rework" | "regressions") => rows.every((row) => row[key] !== null) ? rows.reduce((total, row) => total + row[key]!, 0) : null;
    return { variantId, trials: rows.length, accepted: rows.filter((row) => row.accepted).length,
      elapsedMs: rows.reduce((total, row) => total + row.elapsedMs, 0), outerAgentCalls: rows.reduce((total, row) => total + row.outerAgentCalls, 0),
      reportedTokens: sumKnown("reportedTokens"), reportedCostUsd: sumKnown("reportedCostUsd"), humanInterventions: rows.reduce((total, row) => total + row.humanInterventions, 0),
      rework: sumKnown("rework"), regressions: sumKnown("regressions"), childAccounting: rows.some((row) => row.childAccounting === "unknown") ? "unknown" : "disabled" };
  });
}

export function benchmarkCsv(results: BenchmarkResult[]) {
  const columns: (keyof BenchmarkResult)[] = ["caseId", "variantId", "repeat", "sourceCommit", "finalCommit", "status", "acceptance", "accepted", "elapsedMs", "outerAgentCalls", "reportedTokens", "reportedCostUsd", "childAccounting", "humanInterventions", "rework", "regressions", "directory", "error"];
  const cell = (value: unknown) => value === null || value === undefined ? "" : `"${String(value).replaceAll('"', '""')}"`;
  return [columns.join(","), ...results.map((result) => columns.map((column) => cell(result[column])).join(","))].join("\n") + "\n";
}

async function git(cwd: string, ...args: string[]) {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } });
  const [out, err, code] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(`git ${args[0]} failed: ${err.trim().slice(-2000) || code}`);
  return out.trim();
}

async function clone(repo: string, commit: string, dest: string) {
  mkdirSync(dirname(dest), { recursive: true });
  await git(dirname(dest), "clone", "--quiet", "--no-checkout", "--no-hardlinks", "--", repo, dest);
  await git(dest, "checkout", "--quiet", "--detach", commit);
  if ((await headCommit(dest)).toLowerCase() !== commit.toLowerCase()) throw new Error("Cloned repository does not match the pinned source commit");
}

async function acceptance(cwd: string, item: Case, commit: string, signal: AbortSignal, deadline: number): Promise<Acceptance[]> {
  const checks: Acceptance[] = [];
  for (const entry of [{ id: "acceptance", check: item.check }, ...item.requirements]) {
    if (signal.aborted || Date.now() >= deadline) { checks.push({ id: entry.id, command: entry.check, status: "unverified", output: "Benchmark wall-clock budget exhausted" }); continue; }
    const result = await runCheck(cwd, entry.check, signal, Math.max(1, deadline - Date.now()));
    let status: Acceptance["status"] = result.ok ? "passed" : signal.aborted ? "unverified" : "failed";
    let output = result.output;
    try { await assertWorktreeRevision(cwd, commit); } catch (error) { status = "failed"; output += `\n${(error as Error).message}`; }
    checks.push({ id: entry.id, command: entry.check, status, output });
  }
  return checks;
}

const runtimeOf = (selected: Variant) => selected.id === "direct-claude" ? "claude-code" as const : selected.runtime ?? "codex" as const;
const promptFor = (item: Case) => `${item.prompt}\n\nFixed benchmark acceptance:\n${[item.check, ...item.requirements.map((entry) => `${entry.id}: ${entry.check}`)].join("\n")}\nDo not commit or change branches. The harness records your work and runs these acceptance checks independently.`;

async function trial(item: Case, selected: Variant, repeat: number, source: string, baseline: Acceptance[], roleSkills: RoleSkills, directory: string, manifest: BenchmarkManifest, runner: RunAgent): Promise<BenchmarkResult> {
  const project = join(directory, "project");
  await clone(source, item.commit, project);
  writeFileSync(join(directory, "environment.json"), JSON.stringify(await runtimeEnvironment(runtimeOf(selected), project), null, 2));
  const started = Date.now();
  const deadline = started + manifest.limits.maxDurationMs;
  const controller = new AbortController();
  const signal = controller.signal;
  // Keep the wall clock alive even while an injected adapter is waiting only on the abort event.
  const deadlineTimer = setTimeout(() => controller.abort(), manifest.limits.maxDurationMs);
  let outerAgentCalls = 0;
  const reports: Usage[] = [];
  let unreportedUsage = false;
  const logs: string[] = [];
  const metered: RunAgent = async (inv) => {
    if (signal.aborted || outerAgentCalls >= manifest.limits.maxAgentCalls) return { ok: false, text: "", error: "Benchmark budget exhausted" };
    outerAgentCalls++;
    const result = await runner({ ...inv, signal: inv.signal ? AbortSignal.any([signal, inv.signal]) : signal,
      onLog: (kind, text) => { logs.push(JSON.stringify({ ts: Date.now(), agentId: inv.agent.id, kind, text })); inv.onLog(kind, text); } });
    if (result.usage) reports.push(result.usage); else unreportedUsage = true;
    return result;
  };
  const result: BenchmarkResult = { caseId: item.id, variantId: selected.id, repeat, sourceCommit: item.commit, finalCommit: null, directory,
    status: "error", acceptance: "unverified", accepted: false, checks: [], elapsedMs: 0, outerAgentCalls: 0, reportedTokens: null, reportedCostUsd: null,
    childAccounting: selected.id === "native-codex" ? "unknown" : "disabled", humanInterventions: 0, rework: null, regressions: null, error: null };
  let finalRef = "HEAD";
  try {
    if (selected.id.startsWith("orchestra-")) {
      const db = openDb(join(directory, "orchestra.db"));
      const staffing: { name: string; role: string; pack: BenchmarkRole }[] = [
        { name: "Director", role: DIRECTOR_ROLE, pack: "director" }, { name: "Engineer", role: "Engineer", pack: "engineer" },
        { name: "Reviewer", role: "QA", pack: "reviewer" }, { name: "Engineer 2", role: "Engineer", pack: "engineer" },
      ];
      const people = staffing.map(({ name, role, pack }) => db.createAgent({ name, role, runtime: runtimeOf(selected), model: selected.model ?? null, effort: null, expertise: "Software delivery and verification", skills: roleSkills[pack], instructions: null }));
      writeFileSync(join(directory, "agents.json"), JSON.stringify(people, null, 2));
      const director = people[0]!;
      const team = db.createTeam({ name: "Benchmark team", directorId: director.id, memberIds: people.slice(1).map((agent) => agent.id) });
      const scheduler = createScheduler({ db, runAgent: metered, worktreeRoot: join(directory, "worktrees"), publish: () => {}, getQuota: async () => [] });
      let runId: string | undefined;
      const abort = () => { if (runId && ["planning", "running", "awaiting_approval"].includes(db.getRun(runId)?.status ?? "")) scheduler.pause(runId); };
      signal.addEventListener("abort", abort, { once: true });
      try {
        const run = await scheduler.startRun({ teamId: team.id, workdir: project, prompt: promptFor(item), autonomous: true,
          delivery: defaultDeliveryPolicy(selected.id.slice("orchestra-".length) as DeliveryProfile), limits: manifest.limits, checkCommand: item.check });
        runId = run.id;
        if (signal.aborted) abort();
        while (["planning", "running", "pausing"].includes(db.getRun(run.id)!.status)) await Bun.sleep(25);
        await scheduler.waitForCleanup();
        const final = db.getRun(run.id)!;
        finalRef = final.branch;
        result.status = final.status;
        result.error = final.error ?? final.pauseReason;
        result.rework = db.listTasks(run.id).reduce((sum, task) => sum + Math.max(0, task.iterations - 1), 0) + final.recoveries + final.fixRounds;
        writeFileSync(join(directory, "run.json"), JSON.stringify({ run: final, tasks: db.listTasks(run.id), evidence: db.listEvidence(run.id), events: db.listAgentEvents(run.id) }, null, 2));
      } finally { signal.removeEventListener("abort", abort); await scheduler.shutdownPreviews(); db.close(); }
    } else {
      const skills = roleSkills.engineer;
      const agent: Agent = { id: "benchmark", name: "Benchmark worker", runtime: runtimeOf(selected), model: selected.model ?? null, effort: null, role: "Engineer", expertise: "", skills, instructions: null, createdAt: Date.now() };
      writeFileSync(join(directory, "agents.json"), JSON.stringify([agent], null, 2));
      const response = await metered({ agent, cwd: project, mode: "worker", prompt: promptFor(item) + skillsPrompt(skills, undefined, { orchestrated: false, nativeDelegation: selected.id === "native-codex" }), onLog: () => {},
        transport: selected.id === "native-codex" ? "app-server" : "batch", nativeDelegation: selected.id === "native-codex", maxNativeChildren: selected.maxNativeChildren });
      result.status = response.ok ? "completed" : signal.aborted ? "budget-reached" : "failed";
      result.error = response.error ?? null;
      await commitAll(project, "Benchmark: record delivered work");
      writeFileSync(join(directory, "response.json"), JSON.stringify(response, null, 2));
    }
    result.finalCommit = await headCommit(project, finalRef);
    const checked = join(directory, "acceptance");
    await openDetachedWorktree(project, checked, result.finalCommit);
    result.checks = await acceptance(checked, item, result.finalCommit, signal, deadline);
    result.acceptance = result.checks.some((check) => check.status === "failed") ? "failed" : result.checks.every((check) => check.status === "passed") ? "passed" : "unverified";
    result.accepted = result.status === "completed" && result.acceptance === "passed";
    result.regressions = result.checks.some((check) => check.status === "unverified") ? null : result.checks.filter((check) => check.status === "failed" && baseline.some((previous) => previous.id === check.id && previous.status === "passed")).length;
    if (await headCommit(project) !== (selected.id.startsWith("orchestra-") ? item.commit : result.finalCommit)) throw new Error("Trial checkout changed unexpectedly");
  } catch (error) { result.status = "error"; result.error = (error as Error).message; result.accepted = false; }
  clearTimeout(deadlineTimer);
  result.elapsedMs = Date.now() - started;
  result.outerAgentCalls = outerAgentCalls;
  result.reportedTokens = !unreportedUsage && reports.length && reports.every((usage) => usage.tokensReported !== false) ? reports.reduce((sum, usage) => sum + usage.tokens, 0) : null;
  result.reportedCostUsd = !unreportedUsage && reports.length && reports.every((usage) => usage.costUsd !== null) ? reports.reduce((sum, usage) => sum + usage.costUsd!, 0) : null;
  writeFileSync(join(directory, "logs.jsonl"), logs.join("\n") + (logs.length ? "\n" : ""));
  writeFileSync(join(directory, "result.json"), JSON.stringify(result, null, 2));
  return result;
}

export async function runBenchmark(input: unknown, options: Options = {}) {
  const manifest = BenchmarkManifestSchema.parse(input);
  if (!options.allowPaid) throw new Error("Benchmark execution requires --allow-paid; use the default dry run to inspect the comparison.");
  if (manifest.variants.some((selected) => selected.id === "native-codex") && !options.allowUnmeteredNative) throw new Error("Native Codex requires --allow-unmetered-native because child calls and usage are not independently metered.");
  const directory = options.outputDir ? resolve(options.outputDir) : realpathSync(mkdtempSync(join(tmpdir(), "orchestra-benchmark-")));
  if (existsSync(directory) && readdirSync(directory).length) throw new Error("Benchmark output directory must be empty");
  mkdirSync(directory, { recursive: true });
  const home = join(directory, "orchestra-home");
  mkdirSync(home, { recursive: true });
  const previousHome = process.env.ORCHESTRA_HOME;
  process.env.ORCHESTRA_HOME = home;
  const results: BenchmarkResult[] = [];
  const save = () => {
    writeFileSync(join(directory, "results.json"), JSON.stringify({ version: 1, results, summary: summarizeBenchmark(results) }, null, 2));
    writeFileSync(join(directory, "results.csv"), benchmarkCsv(results));
  };
  try {
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(manifest, null, 2));
    if (!options.agentRunner) writeFileSync(join(directory, "runtimes.json"), JSON.stringify(await detectRuntimes(), null, 2));
    save();
    const skills = new Map<string, Skill[]>();
    const roleSkills = new Map<string, RoleSkills>();
    for (const selected of manifest.variants) {
      const packs = benchmarkRoleSkills(selected);
      const ids = [...new Set(BENCHMARK_ROLES.flatMap((role) => packs[role]))];
      const installed = await (options.skillInstaller ?? ensureSkills)(ids, { root: join(home, "skills") });
      const byId = new Map(installed.map((skill) => [skill.id, skill]));
      const resolvePack = (role: BenchmarkRole) => packs[role].map((id) => {
        const skill = byId.get(id);
        if (!skill) throw new Error(`Skill installer did not resolve ${id}`);
        return skill;
      });
      skills.set(selected.id, installed);
      roleSkills.set(selected.id, { director: resolvePack("director"), engineer: resolvePack("engineer"), reviewer: resolvePack("reviewer") });
    }
    writeFileSync(join(directory, "skills.json"), JSON.stringify(Object.fromEntries(skills), null, 2));
    writeFileSync(join(directory, "role-skills.json"), JSON.stringify(Object.fromEntries([...roleSkills].map(([id, packs]) => [id, id.startsWith("orchestra-") ? packs : { engineer: packs.engineer }])), null, 2));
    for (const item of manifest.cases) {
      const caseRoot = join(directory, "cases", item.id);
      const repo = !isAbsolute(item.repo) && !/^(?:[a-z][a-z0-9+.-]*:\/\/|[^/]+@[^:]+:)/i.test(item.repo) ? resolve(options.manifestDir ?? process.cwd(), item.repo) : item.repo;
      const source = join(caseRoot, "source");
      await clone(repo, item.commit, source);
      const baselinePath = join(caseRoot, "baseline");
      await openDetachedWorktree(source, baselinePath, item.commit);
      const baseline = await acceptance(baselinePath, item, item.commit, AbortSignal.timeout(manifest.limits.maxDurationMs), Date.now() + manifest.limits.maxDurationMs);
      writeFileSync(join(caseRoot, "baseline.json"), JSON.stringify(baseline, null, 2));
      // Rotate order each repetition to reduce the same variant always receiving warm caches first.
      for (let repeat = 1; repeat <= manifest.repeat; repeat++) {
        const offset = (repeat - 1) % manifest.variants.length;
        for (const selected of [...manifest.variants.slice(offset), ...manifest.variants.slice(0, offset)]) {
          options.onProgress?.(`${item.id}: ${selected.id}, repeat ${repeat}/${manifest.repeat}`);
          const trialRoot = join(caseRoot, `${selected.id}-${repeat}`);
          const result = await trial(item, selected, repeat, source, baseline, roleSkills.get(selected.id)!, trialRoot, manifest, options.agentRunner ?? runAgent);
          results.push(result); save();
        }
      }
    }
    return { directory, results, summary: summarizeBenchmark(results) };
  } catch (error) {
    save();
    writeFileSync(join(directory, "error.json"), JSON.stringify({ error: (error as Error).message }, null, 2));
    throw error;
  } finally { if (previousHome === undefined) delete process.env.ORCHESTRA_HOME; else process.env.ORCHESTRA_HOME = previousHome; }
}

async function main() {
  const args = process.argv.slice(2);
  let file: string | undefined;
  let outputDir: string | undefined;
  for (let index = 0; index < args.length; index++) {
    const value = args[index]!;
    if (value === "--output") { outputDir = args[++index]; if (!outputDir || outputDir.startsWith("--")) throw new Error("--output requires a directory"); }
    else if (["--allow-paid", "--allow-unmetered-native", "--dry-run"].includes(value)) continue;
    else if (value.startsWith("--") || file) throw new Error("Usage: bun run test:benchmark manifest.json [--dry-run | --allow-paid] [--allow-unmetered-native] [--output DIRECTORY]");
    else file = value;
  }
  if (!file) throw new Error("Provide a version 1 benchmark JSON manifest");
  const manifestPath = resolve(file);
  const manifest = BenchmarkManifestSchema.parse(await Bun.file(manifestPath).json());
  if (!args.includes("--allow-paid") || args.includes("--dry-run")) { console.log(JSON.stringify(benchmarkPlan(manifest), null, 2)); return; }
  const result = await runBenchmark(manifest, { allowPaid: true, allowUnmeteredNative: args.includes("--allow-unmetered-native"), outputDir,
    manifestDir: dirname(manifestPath), onProgress: console.log });
  console.log(JSON.stringify(result.summary, null, 2));
  console.log(`Scratch projects, checkpoints and JSON/CSV results retained at ${result.directory}`);
  if (result.results.some((row) => !row.accepted)) process.exitCode = 1;
}

if (import.meta.main) await main();
