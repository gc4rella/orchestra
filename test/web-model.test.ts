import { describe, expect, test } from "bun:test";
import {
  activeRunTime,
  describeWorkspace,
  diffRows,
  formatDuration,
  formatUsage,
  matchesFilter,
  planLabel,
  mergeLogs,
  planSteps,
  projectName,
  recentProjects,
  shellQuote,
  teamReady,
} from "../src/web/model.ts";
import {
  DIRECTOR_ROLE,
  type Agent,
  type LogEntry,
  type Run,
} from "../src/shared/types.ts";

describe("workspace presentation rules", () => {
  test("attention includes failed runs and approvals without counting them as finished", () => {
    for (const status of ["awaiting_approval", "failed", "paused"] as const) {
      const run = { status } as Run;
      expect(matchesFilter(run, "attention")).toBe(true);
      expect(matchesFilter(run, "active")).toBe(false);
      expect(matchesFilter(run, "finished")).toBe(false);
    }
    expect(matchesFilter({ status: "cancelled" } as Run, "finished")).toBe(
      true,
    );
  });
  test("readiness requires both a Director and a specialist", () => {
    const director = { role: DIRECTOR_ROLE.toUpperCase() } as Agent;
    const member = { role: "Engineer" } as Agent;
    expect(teamReady([])).toBe(false);
    expect(teamReady([director])).toBe(false);
    expect(teamReady([member])).toBe(false);
    expect(teamReady([director, member])).toBe(true);
  });
  test("log reconciliation isolates streams, deduplicates, and preserves events received during fetch", () => {
    const log = (id: number, taskId: string | null) =>
      ({ id, taskId, text: `${id}` }) as LogEntry;
    expect(
      mergeLogs(
        [log(1, "a"), log(2, "a")],
        [log(2, "a"), log(3, "a"), log(4, "b"), log(5, null)],
        "a",
      ).map((l) => l.id),
    ).toEqual([1, 2, 3]);
    expect(
      mergeLogs([log(1, null)], [log(2, "a"), log(3, null)], null).map(
        (l) => l.id,
      ),
    ).toEqual([1, 3]);
  });
  test("review commands quote shell metacharacters in project paths", () => {
    const path = "/tmp/it's a project/$(touch nope)`echo nope`";
    const command = `printf %s ${shellQuote(path)}`;
    const result = Bun.spawnSync(["/bin/sh", "-c", command]);
    expect(result.stdout.toString()).toBe(path);
    expect(result.exitCode).toBe(0);
    expect(projectName("/Users/you/project/")).toBe("project");
  });
});

describe("project picker helpers", () => {
  test("recent projects are distinct and most recent first", () => {
    const run = (workdir: string, createdAt: number) => ({ workdir, createdAt }) as Run;
    const runs = [run("/a", 1), run("/b", 3), run("/a", 4), run("/c", 2), run("/d", 0)];
    expect(recentProjects(runs)).toEqual(["/a", "/b", "/c", "/d"]);
    expect(recentProjects(runs, 2)).toEqual(["/a", "/b"]);
  });
  test("workspace checks read as one line with a tone", () => {
    expect(describeWorkspace({ kind: "new" }).tone).toBe("info");
    expect(describeWorkspace({ kind: "repo", head: "x", branch: "main", dirty: 0 })).toEqual({
      tone: "ok",
      text: "Git repository on main. Work starts from its latest commit.",
    });
    expect(describeWorkspace({ kind: "repo", head: "x", branch: null, dirty: 1 }).text).toContain(
      "a detached HEAD. 1 uncommitted change won't",
    );
    expect(describeWorkspace({ kind: "invalid", reason: "nope" })).toEqual({ tone: "bad", text: "nope" });
  });
});

describe("plan steps", () => {
  const t = (id: string, dependsOn: string[] = []) => ({ id, dependsOn });
  test("groups tasks by dependency depth, keeping plan order", () => {
    // The definition plan from a real run: audit ∥ tooling → spec → ux ∥ design → review → scaffold
    const steps = planSteps([
      t("audit"),
      t("tooling"),
      t("spec", ["audit"]),
      t("ux", ["spec"]),
      t("design", ["spec"]),
      t("review", ["design", "ux"]),
      t("scaffold", ["review", "tooling"]),
    ]);
    expect(steps.map((s) => s.map((x) => x.id))).toEqual([["audit", "tooling"], ["spec"], ["ux", "design"], ["review"], ["scaffold"]]);
  });
  test("dependencies outside the plan count as met", () => {
    expect(planSteps([t("api", ["design"]), t("qa", ["api", "spec"])]).map((s) => s.map((x) => x.id))).toEqual([["api"], ["qa"]]);
  });
  test("tolerates cycles without looping", () => {
    expect(planSteps([t("a", ["b"]), t("b", ["a"])]).flat()).toHaveLength(2);
  });
});

describe("run details", () => {
  test("formatDuration", () => {
    expect(formatDuration(4_400)).toBe("4s");
    expect(formatDuration(185_000)).toBe("3m 05s");
    expect(formatDuration(4_320_000)).toBe("1h 12m");
  });
  test("formatUsage shows cost only when a CLI reported one", () => {
    expect(formatUsage({ costUsd: 0, tokens: 0 })).toBeNull();
    expect(formatUsage({ costUsd: 1.234, tokens: 450_000 })).toBe("$1.23 · 450K tokens");
    expect(formatUsage({ costUsd: 0, tokens: 1200 })).toBe("1.2K tokens");
  });
  test("planLabel names what the plan is for", () => {
    const plan = (stage: "definition" | "build" | "fix") => ({ summary: "", stage, verify: "", tasks: [] });
    const task = (status: string) => ({ status }) as never;
    expect(planLabel(plan("definition"), [], 0)).toBe("Stage 1 of 2 · Definition");
    expect(planLabel(plan("build"), [], 0)).toBe("Build plan");
    expect(planLabel(plan("build"), [task("done")], 0)).toBe("Stage 2 of 2 · Build");
    expect(planLabel(plan("build"), [task("done"), task("failed")], 0)).toBe("Recovery plan");
    expect(planLabel(plan("fix"), [task("done")], 1)).toBe("Verification · fix round 2");
  });
  test("diffRows numbers old and new lines", () => {
    const rows = diffRows("@@ -3,3 +3,3 @@ fn\n keep\n-old\n+new\n\\ No newline at end of file");
    expect(rows).toEqual([
      { kind: "hunk", text: "@@ -3,3 +3,3 @@ fn" },
      { kind: "ctx", text: "keep", oldLine: 3, newLine: 3 },
      { kind: "del", text: "old", oldLine: 4, newLine: null },
      { kind: "add", text: "new", oldLine: null, newLine: 4 },
    ]);
  });
});


test("budget presentation excludes paused time and includes the current active window", () => {
  expect(activeRunTime({ activeElapsedMs: 1000, activeSince: null }, 10000)).toBe(1000);
  expect(activeRunTime({ activeElapsedMs: 1000, activeSince: 5000 }, 10000)).toBe(6000);
  expect(matchesFilter({ status: "pausing" } as Run, "active")).toBe(true);
});
