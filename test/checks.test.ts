import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCheck } from "../src/server/checks.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-checks-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("passes with the combined output", async () => {
  expect(await runCheck(dir, "echo out; echo err >&2")).toEqual({ ok: true, output: "out\nerr\n" });
});

test("fails with the exit code and the output's tail", async () => {
  const res = await runCheck(dir, "seq 1 5000; exit 3");
  expect(res.ok).toBe(false);
  expect(res.output).toStartWith("…");
  expect(res.output).toContain("5000\n\nExited with code 3.");
  expect(res.output).not.toContain("\n1\n");
});

test("a timeout stops the whole process group", async () => {
  const started = Date.now();
  const res = await runCheck(dir, "echo started; sleep 30 & sleep 30", undefined, 200);
  expect(Date.now() - started).toBeLessThan(5000);
  expect(res).toMatchObject({ ok: false });
  expect(res.output).toContain("Timed out");
});

test("cancelling stops the command", async () => {
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 100);
  expect(await runCheck(dir, "sleep 30", controller.signal)).toEqual({ ok: false, output: "cancelled" });
});

test("an already cancelled signal stops the command at once", async () => {
  const started = Date.now();
  expect(await runCheck(dir, "sleep 30", AbortSignal.abort())).toEqual({ ok: false, output: "cancelled" });
  expect(Date.now() - started).toBeLessThan(5000);
});
