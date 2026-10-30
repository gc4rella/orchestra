import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BenchmarkManifestSchema, benchmarkCsv, benchmarkPlan, benchmarkRoleSkills, runBenchmark, summarizeBenchmark, type BenchmarkResult } from "../scripts/benchmark.ts";
import { headCommit } from "../src/server/git.ts";
import { ensureSkills } from "../src/server/skills.ts";
import type { Agent } from "../src/shared/types.ts";
import type { RunAgent } from "../src/server/runtimes.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-benchmark-test-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const manifest = (repo = "/unused") => ({ version: 1 as const, cases: [{ id: "feature", repo, commit: "a".repeat(40), prompt: "Deliver the feature", check: "test -f delivered.txt", requirements: [{ id: "health", check: "test -f health.txt" }] }], variants: [{ id: "direct-codex" as const }] });
const git = (cwd: string, ...args: string[]) => {
  const proc = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) throw new Error(proc.stderr.toString());
  return proc.stdout.toString().trim();
};
function source(name: string) {
  const repo = join(root, name);
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, "health.txt"), "healthy\n");
  git(repo, "init", "-q"); git(repo, "add", "-A"); git(repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "source");
  return { repo, commit: git(repo, "rev-parse", "HEAD") };
}

describe("benchmark manifest and dry run", () => {
  test("requires versioned pinned repositories, unique cases, fixed acceptance and known variants", () => {
    const raw = manifest();
    const parsed = BenchmarkManifestSchema.parse(raw);
    expect(parsed.repeat).toBe(1);
    expect(parsed.limits).toEqual({ maxDurationMs: 300_000, maxAgentCalls: 12 });
    expect(BenchmarkManifestSchema.safeParse({ ...raw, version: 2 }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, cases: [{ ...raw.cases[0], commit: "main" }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, cases: [raw.cases[0], raw.cases[0]] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, cases: [{ ...raw.cases[0], id: "../escape" }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, cases: [{ ...raw.cases[0], check: "test\nexec something" }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, variants: [{ id: "invented" }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, variants: [{ id: "direct-codex", runtime: "claude-code" }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, variants: [{ id: "direct-codex", roleSkills: { engineer: [] } }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, variants: [{ id: "orchestra-balanced", roleSkills: { designer: [] } }] }).success).toBe(false);
    expect(BenchmarkManifestSchema.safeParse({ ...raw, variants: [{ id: "orchestra-balanced", roleSkills: { engineer: ["../../bad"] } }] }).success).toBe(false);
  });

  test("role packs override shared skills while omitted roles preserve old manifests", () => {
    const legacy = BenchmarkManifestSchema.parse({ ...manifest(), variants: [{ id: "orchestra-balanced", skills: ["owner/repo/shared"] }] }).variants[0]!;
    expect(benchmarkRoleSkills(legacy)).toEqual({ director: ["owner/repo/shared"], engineer: ["owner/repo/shared"], reviewer: ["owner/repo/shared"] });
    const selected = BenchmarkManifestSchema.parse({ ...manifest(), variants: [{ id: "orchestra-quality", skills: ["owner/repo/shared"], roleSkills: { director: [], engineer: ["owner/repo/frontend"] } }] }).variants[0]!;
    expect(benchmarkRoleSkills(selected)).toEqual({ director: [], engineer: ["owner/repo/frontend"], reviewer: ["owner/repo/shared"] });
  });

  test("dry run describes all comparisons without touching repositories or starting agents", async () => {
    const parsed = BenchmarkManifestSchema.parse({ ...manifest(), variants: [{ id: "direct-codex", skills: ["owner/repo/direct"] }, { id: "orchestra-quality", skills: ["owner/repo/shared"], roleSkills: { director: [], engineer: ["owner/repo/frontend"], reviewer: ["owner/repo/browser"] } }], repeat: 2 });
    const plan = benchmarkPlan(parsed);
    expect(plan.paid).toBe(false);
    expect(plan.trials).toHaveLength(4);
    expect(plan.trials.find((row) => row.variantId === "direct-codex")!.skills).toEqual({ engineer: ["owner/repo/direct"] });
    expect(plan.trials.find((row) => row.variantId === "orchestra-quality")!.skills).toEqual({ director: [], engineer: ["owner/repo/frontend"], reviewer: ["owner/repo/browser"] });
    expect(new Set(plan.trials.map((row) => row.sourceCommit))).toEqual(new Set(["a".repeat(40)]));
    const file = join(root, "manifest.json");
    const output = join(root, "must-not-exist");
    writeFileSync(file, JSON.stringify(parsed));
    const proc = Bun.spawn(["bun", "scripts/benchmark.ts", "--output", output, file, "--dry-run"], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
    const stdout = await new Response(proc.stdout).text();
    expect(await proc.exited).toBe(0);
    expect(JSON.parse(stdout).trials).toHaveLength(4);
    expect(JSON.parse(stdout).trials[2].skills).toEqual({ director: [], engineer: ["owner/repo/frontend"], reviewer: ["owner/repo/browser"] });
    expect(existsSync(output)).toBe(false);
  });

  test("execution and unmetered native baselines require separate explicit opt-ins", async () => {
    let called = false;
    const agentRunner: RunAgent = async () => { called = true; return { ok: true, text: "" }; };
    const outputDir = join(root, "unauthorized");
    await expect(runBenchmark(manifest(), { outputDir, agentRunner })).rejects.toThrow("--allow-paid");
    await expect(runBenchmark({ ...manifest(), variants: [{ id: "native-codex" }] }, { outputDir, agentRunner, allowPaid: true })).rejects.toThrow("--allow-unmetered-native");
    expect(called).toBe(false);
    expect(existsSync(outputDir)).toBe(false);
  });
});

describe("benchmark execution with fake agents and real isolated git", () => {
  test("Orchestra roles receive only their chosen skill packs with retained installed provenance", async () => {
    const original = source("role-packs-source");
    const library = source("role-packs-library");
    for (const name of ["planning", "frontend", "browser"]) {
      const path = join(library.repo, "skills", name);
      mkdirSync(path, { recursive: true });
      writeFileSync(join(path, "SKILL.md"), `---\nname: ${name}\ndescription: Focused ${name} procedure.\n---\nFollow the assigned task.\n`);
    }
    git(library.repo, "add", "-A"); git(library.repo, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-qm", "skill packs");
    const revision = git(library.repo, "rev-parse", "HEAD");
    const installs: string[][] = [];
    const seen: { name: string; ids: string[] }[] = [];
    const expected = { Director: "owner/library/planning", Engineer: "owner/library/frontend", Reviewer: "owner/library/browser", "Engineer 2": "owner/library/frontend" };
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], variants: [{ id: "orchestra-quality", skills: ["owner/library/unused-fallback"], roleSkills: { director: [expected.Director], engineer: [expected.Engineer], reviewer: [expected.Reviewer] } }], limits: { maxDurationMs: 10_000, maxAgentCalls: 12 } }, {
      allowPaid: true, outputDir: join(root, "role-packs"),
      skillInstaller: async (ids, options) => {
        installs.push(ids);
        return ensureSkills(ids, { ...options, repoUrl: (repository) => { expect(repository).toBe("owner/library"); return library.repo; } });
      },
      agentRunner: async (inv) => {
        seen.push({ name: inv.agent.name, ids: inv.agent.skills.map((skill) => skill.id) });
        expect(inv.agent.skills).toHaveLength(1);
        expect(inv.agent.skills[0]).toMatchObject({ id: expected[inv.agent.name as keyof typeof expected], revision, provenance: { revision, repository: "owner/library", files: ["SKILL.md"] } });
        if (inv.mode === "worker") { await Bun.write(join(inv.cwd, "delivered.txt"), "delivered\n"); return { ok: true, text: "Implemented" }; }
        if (inv.prompt.includes("reviewing a teammate")) return { ok: true, text: "", structured: { verdict: "approve", findings: "" } };
        if (inv.prompt.includes("## Verification")) return { ok: true, text: "", structured: { summary: "Accepted", stage: "fix", verify: "test -f delivered.txt", lessons: "", tasks: [] } };
        const section = inv.prompt.split("## Your team")[1]!.split("## The project")[0]!;
        const team = JSON.parse(section.slice(section.indexOf("["))) as Agent[];
        return { ok: true, text: "", structured: { summary: "Deliver feature", stage: "build", verify: "test -f delivered.txt", lessons: "", tasks: [{ id: "deliver", title: "Deliver", description: "Create delivered.txt", agentId: team.find((agent) => agent.name === "Engineer")!.id, reviewerId: team.find((agent) => agent.name === "Reviewer")!.id, dependsOn: [], acceptanceCriteria: "The file exists" }] } };
      },
    });
    expect(completed.results[0]).toMatchObject({ accepted: true, acceptance: "passed", sourceCommit: original.commit, reportedTokens: null, reportedCostUsd: null });
    expect(installs).toEqual([[expected.Director, expected.Engineer, expected.Reviewer]]);
    expect(new Set(seen.map((call) => call.name))).toEqual(new Set(["Director", "Engineer", "Reviewer"]));
    const packs = await Bun.file(join(completed.directory, "role-skills.json")).json();
    for (const [role, name] of [["director", "Director"], ["engineer", "Engineer"], ["reviewer", "Reviewer"]] as const) expect(packs["orchestra-quality"][role][0]).toMatchObject({ id: expected[name], revision });
    const agents = await Bun.file(join(completed.results[0]!.directory, "agents.json")).json() as Agent[];
    expect(agents).toHaveLength(4);
    for (const agent of agents) expect(agent.skills.map((skill) => skill.id)).toEqual([expected[agent.name as keyof typeof expected]]);
    expect((await Bun.file(join(completed.directory, "skills.json")).json())["orchestra-quality"]).toHaveLength(3);
    expect(git(original.repo, "rev-parse", "HEAD")).toBe(original.commit);
    expect(git(original.repo, "status", "--porcelain")).toBe("");
  }, 20_000);

  test("direct and Orchestra variants start from the same commit and are evaluated with identical external checks", async () => {
    const original = source("source");
    const starts: string[] = [];
    const agentRunner: RunAgent = async (inv) => {
      if (inv.mode === "worker") {
        starts.push(await headCommit(inv.cwd));
        await Bun.write(join(inv.cwd, "delivered.txt"), "delivered\n");
        return { ok: true, text: "Implemented", usage: { tokens: 10, costUsd: null } };
      }
      if (inv.prompt.includes("reviewing a teammate")) return { ok: true, text: "", structured: { verdict: "approve", findings: "" }, usage: { tokens: 10, costUsd: null } };
      if (inv.prompt.includes("## Verification")) return { ok: true, text: "", structured: { summary: "Accepted", stage: "fix", verify: "test -f delivered.txt", lessons: "", tasks: [] }, usage: { tokens: 10, costUsd: null } };
      const section = inv.prompt.split("## Your team")[1]!.split("## The project")[0]!;
      const team = JSON.parse(section.slice(section.indexOf("["))) as { id: string }[];
      return { ok: true, text: "", usage: { tokens: 10, costUsd: null }, structured: { summary: "Deliver feature", stage: "build", verify: "test -f delivered.txt", lessons: "", tasks: [{ id: "deliver", title: "Deliver", description: "Create delivered.txt", agentId: team[0]!.id, reviewerId: "", dependsOn: [], acceptanceCriteria: "The file exists" }] } };
    };
    const previousHome = process.env.ORCHESTRA_HOME;
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], variants: [{ id: "direct-codex" }, { id: "orchestra-balanced" }], repeat: 2,
      limits: { maxDurationMs: 10_000, maxAgentCalls: 12 } }, { allowPaid: true, outputDir: join(root, "comparison"), agentRunner });
    expect(completed.results).toHaveLength(4);
    expect(completed.results.every((row) => row.accepted)).toBe(true);
    expect(starts.every((commit) => commit === original.commit)).toBe(true);
    expect(new Set(completed.results.map((row) => JSON.stringify(row.checks.map((entry) => [entry.id, entry.command])))).size).toBe(1);
    expect(completed.results.every((row) => row.finalCommit && row.finalCommit !== original.commit && row.reportedTokens !== null && row.reportedCostUsd === null)).toBe(true);
    expect(git(original.repo, "rev-parse", "HEAD")).toBe(original.commit);
    expect(git(original.repo, "status", "--porcelain")).toBe("");
    expect(process.env.ORCHESTRA_HOME ?? null).toBe(previousHome ?? null);
    expect(existsSync(join(completed.directory, "results.json"))).toBe(true);
    expect(existsSync(join(completed.directory, "results.csv"))).toBe(true);
    expect(existsSync(join(completed.directory, "cases/feature/orchestra-balanced-1/orchestra.db"))).toBe(true);
  }, 20_000);

  test("records regressions and keeps missing usage unknown instead of inventing free execution", async () => {
    const original = source("regression-source");
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], limits: { maxDurationMs: 5000, maxAgentCalls: 2 } }, {
      allowPaid: true, outputDir: join(root, "regression"), agentRunner: async (inv) => {
        await Bun.write(join(inv.cwd, "delivered.txt"), "delivered");
        rmSync(join(inv.cwd, "health.txt"));
        return { ok: true, text: "Done" };
      },
    });
    expect(completed.results[0]).toMatchObject({ status: "completed", acceptance: "failed", accepted: false, regressions: 1, outerAgentCalls: 1, reportedTokens: null, reportedCostUsd: null });
    expect(completed.summary[0]).toMatchObject({ accepted: 0, reportedTokens: null, reportedCostUsd: null, regressions: 1 });
  });

  test("opted-in native baselines retain standalone planning and unknown descendant accounting", async () => {
    const original = source("native-source");
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], variants: [{ id: "native-codex", skills: ["owner/repo/procedure"], maxNativeChildren: 2 }], limits: { maxDurationMs: 5000, maxAgentCalls: 2 } }, {
      allowPaid: true, allowUnmeteredNative: true, outputDir: join(root, "native"),
      skillInstaller: async (ids) => ids.map((id) => ({ id, name: "Procedure", description: "A standalone procedure.", revision: null, compatibility: { status: "integration-required", requiredTools: [], notices: ["Native agent spawning is disabled. Perform only your assigned work."] } })),
      agentRunner: async (inv) => {
        expect(inv).toMatchObject({ transport: "app-server", nativeDelegation: true, maxNativeChildren: 2 });
        expect(inv.prompt).toContain("Plan the supplied task yourself");
        expect(inv.prompt).toContain("Native delegation is explicitly enabled");
        expect(inv.prompt).not.toContain("Orchestra owns planning");
        expect(inv.prompt).not.toContain("Native agent spawning is disabled");
        await Bun.write(join(inv.cwd, "delivered.txt"), "delivered");
        return { ok: true, text: "Done", usage: { tokens: 10, costUsd: null } };
      },
    });
    expect(completed.results[0]).toMatchObject({ accepted: true, childAccounting: "unknown", outerAgentCalls: 1, reportedTokens: 10, reportedCostUsd: null });
    expect(completed.summary[0]).toMatchObject({ childAccounting: "unknown", reportedCostUsd: null });
    expect(Object.keys((await Bun.file(join(completed.directory, "role-skills.json")).json())["native-codex"])).toEqual(["engineer"]);
  });

  test("reported cost does not turn absent token reports into zero tokens", async () => {
    const original = source("unknown-tokens-source");
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], limits: { maxDurationMs: 5000, maxAgentCalls: 2 } }, {
      allowPaid: true, outputDir: join(root, "unknown-tokens"), agentRunner: async (inv) => {
        await Bun.write(join(inv.cwd, "delivered.txt"), "delivered");
        return { ok: true, text: "Done", usage: { costUsd: 0.25, tokens: 0, tokensReported: false } };
      },
    });
    expect(completed.results[0]).toMatchObject({ accepted: true, reportedTokens: null, reportedCostUsd: 0.25 });
    expect(completed.summary[0]).toMatchObject({ reportedTokens: null, reportedCostUsd: 0.25 });
    expect(benchmarkCsv(completed.results).split("\n")[1]).not.toContain('"0","0.25"');
  });

  test("deadline cancellation bounds the worker and leaves acceptance unverified", async () => {
    const original = source("deadline-source");
    let stopped = false;
    const completed = await runBenchmark({ ...manifest(original.repo), cases: [{ ...manifest().cases[0], ...original }], limits: { maxDurationMs: 1000, maxAgentCalls: 1 } }, {
      allowPaid: true, outputDir: join(root, "deadline"), agentRunner: async (inv) => {
        await new Promise<void>((resolve) => { if (inv.signal?.aborted) resolve(); else inv.signal!.addEventListener("abort", () => resolve(), { once: true }); });
        stopped = true;
        return { ok: false, text: "", error: "cancelled", usage: { tokens: 12, costUsd: null } };
      },
    });
    expect(stopped).toBe(true);
    expect(completed.results[0]).toMatchObject({ status: "budget-reached", accepted: false, acceptance: "unverified", outerAgentCalls: 1, reportedTokens: 12, regressions: null });
    expect(completed.results[0]!.checks.every((entry) => entry.status === "unverified")).toBe(true);
  }, 5000);
});

test("CSV preserves quoted data and summary never treats unknown dollars as zero", () => {
  const row: BenchmarkResult = { caseId: "case", variantId: "direct-codex", repeat: 1, sourceCommit: "a".repeat(40), finalCommit: "b".repeat(40), directory: "/scratch, trial", status: "completed", acceptance: "passed", accepted: true, checks: [], elapsedMs: 20, outerAgentCalls: 1, reportedTokens: 100, reportedCostUsd: null, childAccounting: "disabled", humanInterventions: 0, rework: null, regressions: 0, error: 'quote "kept"' };
  expect(benchmarkCsv([row])).toContain('"/scratch, trial"');
  expect(benchmarkCsv([row])).toContain('"quote ""kept"""');
  expect(summarizeBenchmark([row])[0]).toMatchObject({ reportedTokens: 100, reportedCostUsd: null, accepted: 1, rework: null });
});
