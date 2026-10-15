import { describe, expect, test } from "bun:test";
import {
  activeRunTime,
  agentSetup,
  bounceReason,
  composeBrief,
  readDraft,
  explainError,
  nextAction,
  taskSteps,
  describeWorkspace,
  diffRows,
  formatDuration,
  formatUsage,
  groupLogs,
  matchesFilter,
  minimumCalls,
  planLabel,
  mergeLogs,
  planSteps,
  projectGroups,
  projectName,
  recentProjects,
  shellQuote,
  defaultTeamId,
  inMemory,
  proposedLessons,
  withLessons,
} from "../src/web/model.ts";
import {
  type CheckEvidence,
  type Handoff,
  type LogEntry,
  type Run,
  type RunStatus,
  type Task,
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
  test("a new run starts with the project's last team, then the last team used, then the first", () => {
    const teams = [{ id: "a" }, { id: "b" }, { id: "c" }];
    const runs = [
      { workdir: "/app", teamId: "b", createdAt: 1 },
      { workdir: "/app", teamId: "gone", createdAt: 3 },
      { workdir: "/lib", teamId: "c", createdAt: 2 },
    ];
    expect(defaultTeamId(teams, runs, "/app")).toBe("b");
    expect(defaultTeamId(teams, runs, "/new")).toBe("c");
    expect(defaultTeamId(teams, [], "/new")).toBe("a");
    expect(defaultTeamId([], runs, "/app")).toBeNull();
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
  test("project groups order projects by latest run and runs newest first", () => {
    const run = (workdir: string, createdAt: number) => ({ workdir, createdAt }) as Run;
    const groups = projectGroups([run("/a", 1), run("/b", 3), run("/a", 4), run("/b", 2)]);
    expect(groups.map((g) => [g.workdir, g.runs.map((r) => r.createdAt)])).toEqual([
      ["/a", [4, 1]],
      ["/b", [3, 2]],
    ]);
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
    const plan = (stage: "definition" | "build" | "fix") => ({ summary: "", stage, verify: "", lessons: "", tasks: [] });
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

describe("next action", () => {
  const run = (status: RunStatus, extra: Partial<Run> = {}) => ({ status, branch: "orchestra/r1", autonomous: false, pauseReason: null, ...extra }) as Run;
  const t = (status: Task["status"]) => ({ status }) as Task;
  test("every status names what it needs from the user, if anything", () => {
    const targets = Object.fromEntries(
      (["planning", "awaiting_approval", "running", "pausing", "paused", "failed", "completed", "cancelled"] as const).map((s) => [s, nextAction(run(s), []).target]),
    );
    expect(targets).toEqual({
      planning: null, awaiting_approval: "plan", running: null, pausing: null,
      paused: "resume", failed: "replan", completed: "changes", cancelled: null,
    });
  });
  test("failed tasks lead to retry; an interrupted run leads to resume", () => {
    expect(nextAction(run("failed"), [t("done"), t("failed"), t("failed")])).toMatchObject({ target: "retry", title: "2 tasks failed", tone: "bad" });
    expect(nextAction(run("failed", { pauseReason: "Interrupted by server restart" }), [t("failed")]).target).toBe("resume");
    expect(nextAction(run("paused", { pauseReason: "Agent call budget reached" }), []).title).toBe("Paused: Agent call budget reached");
    const verifyPause = nextAction(run("paused", { pauseReason: "New verify command needs your OK", plan: { summary: "s", stage: "build", verify: "make check", lessons: "", tasks: [] } }), []);
    expect(verifyPause).toMatchObject({ title: "A new verify command needs your OK", target: "resume" });
    expect(verifyPause.detail).toContain("`make check`");
  });
  test("a supervised running run surfaces failures; an autonomous one re-plans them itself", () => {
    expect(nextAction(run("running"), [t("failed"), t("running")]).target).toBe("retry");
    const auto = nextAction(run("running", { autonomous: true }), [t("failed"), t("running"), t("done"), t("superseded")]);
    expect(auto).toMatchObject({ target: null, detail: expect.stringContaining("1 running · 1 of 3 done") });
  });
});

describe("task steps", () => {
  const states = (task: Partial<Task>, verify: boolean) =>
    taskSteps({ phase: "work", status: "running", reviewerId: null, ...task }, verify).map((s) => `${s.label}:${s.state}`);
  test("check and review appear only when they apply", () => {
    expect(states({}, false)).toEqual(["Work:current", "Commit:todo", "Merge:todo"]);
    expect(states({ phase: "review", reviewerId: "qa" }, true)).toEqual(["Work:done", "Commit:done", "Check:done", "Review:current", "Merge:todo"]);
  });
  test("pending tasks have no current step, done tasks finished all of them", () => {
    expect(states({ status: "pending" }, true)).toEqual(["Work:todo", "Commit:todo", "Check:todo", "Merge:todo"]);
    expect(states({ status: "done", phase: "done" }, true).every((s) => s.endsWith(":done"))).toBe(true);
  });
  test("bounceReason quotes the failed check's last line or the review's first finding", () => {
    expect(bounceReason({ handoff: null })).toBeNull();
    const handoff = (check: CheckEvidence, review: Handoff["review"]) =>
      ({ handoff: { text: "", files: [], check, review } });
    expect(bounceReason(handoff({ command: "bun test", ok: false, output: "a.test.ts:\n 1 fail\n\n" }, null))).toBe("Check failed: 1 fail");
    expect(bounceReason(handoff({ command: "bun test", ok: true, output: "" }, { verdict: "changes", findings: "\nMissing error handling\nAlso X" }))).toBe("Review asked for changes: Missing error handling");
    expect(bounceReason(handoff({ command: "bun test", ok: true, output: "" }, { verdict: "approve", findings: "" }))).toBeNull();
  });
});

describe("error explanations", () => {
  test("common failures get a cause and a next step", () => {
    expect(explainError("claude exited with code 1: Not logged in · Please run /login")?.cause).toContain("isn’t signed in");
    expect(explainError("timed out after 45 minutes")?.cause).toContain("out of time");
    expect(explainError("Could not resolve merge conflict in a.ts")?.cause).toContain("overlapped");
    expect(explainError("interrupted by server restart")?.next).toContain("Resume");
    expect(explainError("codex exited with code 2: boom")?.cause).toContain("stopped with an error");
  });
  test("check output inside a repeated failure doesn't masquerade as a sign-in problem", () => {
    expect(explainError("Still failing after 3 attempts:\nThe verify command `bun test` failed:\nlogin.test.ts > rejects unauthorized users")?.cause).toContain("kept finding problems");
    expect(explainError("Still failing after 3 attempts:\nsh: pnpm: command not found")?.cause).toContain("isn’t installed");
  });
  test("unknown errors get no guess", () => {
    expect(explainError("something unexpected")).toBeNull();
  });
});

describe("new run brief", () => {
  test("non-goals are appended under their own heading, and only when given", () => {
    expect(composeBrief({ prompt: "  Build a CLI ", nonGoals: " " })).toBe("Build a CLI");
    expect(composeBrief({ prompt: "Build a CLI", nonGoals: "No auth\n" })).toBe("Build a CLI\n\nNon-goals:\nNo auth");
  });
  test("a missing or unreadable draft starts empty", () => {
    expect(readDraft()).toEqual({ prompt: "", workdir: "", nonGoals: "" });
  });
});

describe("log grouping", () => {
  const log = (id: number, kind: LogEntry["kind"]) => ({ id, runId: "r", taskId: null, ts: 0, kind, text: `${kind}${id}` }) as LogEntry;
  const shape = (entries: LogEntry[]) => groupLogs(entries).map((i) => (i.kind === "tools" ? `tools×${i.entries.length}` : i.entry.text));
  test("three or more consecutive tool calls collapse; shorter runs stay inline", () => {
    expect(shape([log(1, "text"), log(2, "tool"), log(3, "tool"), log(4, "text")])).toEqual(["text1", "tool2", "tool3", "text4"]);
    expect(shape([log(1, "tool"), log(2, "tool"), log(3, "tool"), log(4, "text"), log(5, "tool"), log(6, "tool"), log(7, "tool"), log(8, "tool")]))
      .toEqual(["tools×3", "text4", "tools×4"]);
    expect(shape([])).toEqual([]);
  });
});

test("minimumCalls counts each task, each review and the verification", () => {
  const t = (reviewerId: string) => ({ id: "a", title: "", description: "", agentId: "x", reviewerId, dependsOn: [], acceptanceCriteria: "" });
  expect(minimumCalls({ tasks: [] })).toBe(1);
  expect(minimumCalls({ tasks: [t(""), t("qa"), t("qa")] })).toBe(6);
});

test("agentSetup marks what comes from the CLI's own config", () => {
  const runtimes = [{ runtime: "codex" as const, installed: true, version: null, defaults: { model: "gpt-5", effort: "medium" } }];
  expect(agentSetup({ runtime: "codex", model: null, effort: null }, runtimes)).toBe("gpt-5 (default) · medium effort (default)");
  expect(agentSetup({ runtime: "codex", model: "o3", effort: "high" }, runtimes)).toBe("o3 · high effort");
  expect(agentSetup({ runtime: "claude-code", model: null, effort: null }, runtimes)).toBe("default model");
});

describe("project memory lessons", () => {
  const entry = (lessons: string) => ({ cycle: 1, createdAt: 1, report: "ok", plan: { summary: "s", stage: "fix" as const, verify: "", lessons, tasks: [] } });
  test("collects proposed lessons from every accepted cycle, once each and without list markers", () => {
    expect(proposedLessons({ history: [entry("- Run bun test\n\n* API lives in src/api"), { ...entry(""), plan: null }, entry("Run bun test")] }))
      .toEqual(["Run bun test", "API lives in src/api"]);
  });
  test("appends only what the memory doesn't already say", () => {
    expect(inMemory("- Run bun test\nOther", "Run bun test")).toBe(true);
    expect(inMemory("Run bun test twice", "Run bun test")).toBe(false);
    expect(withLessons("Notes\n- Run bun test\n", ["Run bun test", "Use tabs"])).toBe("Notes\n- Run bun test\n- Use tabs");
    expect(withLessons("", ["Use tabs"])).toBe("- Use tabs");
  });
});
