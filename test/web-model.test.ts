import { describe, expect, test } from "bun:test";
import {
  matchesFilter,
  mergeLogs,
  projectName,
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
    for (const status of ["awaiting_approval", "failed"] as const) {
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
