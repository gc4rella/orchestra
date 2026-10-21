import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ServerEvent } from "../src/shared/types.ts";
import { openDb } from "../src/server/db.ts";
import { addWorktree, commitAll, headCommit, prepareWorkspace } from "../src/server/git.ts";
import { createPreviews, previewRecipe } from "../src/server/preview.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-preview-")));
const managers: ReturnType<typeof createPreviews>[] = [];
afterAll(async () => {
  await Promise.all(managers.map((m) => m.shutdown()));
  rmSync(root, { recursive: true, force: true });
});
let count = 0;
async function setup(command = "", timeoutMs = 4000) {
  const id = `run${count++}`;
  const repo = join(root, id);
  const { baseCommit } = await prepareWorkspace(repo);
  const db = openDb(":memory:");
  const agent = db.createAgent({ name: "Boss", runtime: "codex", model: null, effort: null, role: "Director", expertise: "", skills: [], instructions: null });
  const run = db.createRun({ id, prompt: "Build", workdir: repo, directorAgentId: agent.id, baseCommit, branch: `orchestra/${id}`, warning: null, preview: { enabled: true, command } });
  const worktreeRoot = join(root, "worktrees");
  const integration = join(worktreeRoot, id, "integration");
  await addWorktree(repo, integration, run.branch, baseCommit);
  const events: ServerEvent[] = [];
  const previews = createPreviews({ getRun: db.getRun, worktreeRoot, publish: (_, ev) => events.push(ev), timeoutMs });
  managers.push(previews);
  const commit = async (name: string, content: string) => { writeFileSync(join(integration, name), content); await commitAll(integration, "Update"); return headCommit(integration); };
  return { id, db, repo, run, integration, worktreeRoot, previews, events, commit };
}
const bun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
const command = `${bun} server.ts`;
const server = (text: string) => `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(${JSON.stringify(text)}) });`;

test("detects supported frameworks and package managers, leaving unknown scripts to the user", () => {
  const dir = join(root, "recipe");
  mkdirSync(dir);
  expect(previewRecipe(dir, "")).toBeNull();
  writeFileSync(join(dir, "index.html"), "hello");
  expect(previewRecipe(dir, "")).toEqual({ static: true });
  for (const dev of ["vite", "next dev", "astro dev"]) {
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev } }));
    const recipe = previewRecipe(dir, "");
    expect(recipe).toMatchObject({ install: "bun install" });
    expect(recipe && "command" in recipe && recipe.command).toContain('"$PORT"');
    expect(recipe && "command" in recipe && recipe.command).toContain("127.0.0.1");
  }
  writeFileSync(join(dir, "package-lock.json"), "{}");
  expect(previewRecipe(dir, "")).toMatchObject({ install: "npm install", command: 'npm run dev -- --host 127.0.0.1 --port "$PORT"' });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { dev: "python app.py" } }));
  expect(previewRecipe(dir, "")).toBeNull();
  expect(previewRecipe(dir, "python app.py")).toMatchObject({ command: "python app.py", install: "" });
});

test("waits for an app, then serves integrated snapshots without touching the user's dirty checkout", async () => {
  const x = await setup();
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id).status).toBe("waiting");
  writeFileSync(join(x.repo, "private.txt"), "user's uncommitted file");
  const first = await x.commit("index.html", "First build");
  await x.previews.refresh(x.id);
  const before = x.previews.get(x.id);
  expect(before).toMatchObject({ status: "ready", commit: first });
  expect(await (await fetch(before.url!)).text()).toBe("First build");
  expect((await fetch(`${before.url}/.git`)).status).toBe(404);
  const outside = join(root, "secret.txt");
  writeFileSync(outside, "secret");
  symlinkSync(outside, join(x.worktreeRoot, x.id, ".preview-0", "escaped.txt"));
  expect((await fetch(`${before.url}/escaped.txt`)).status).toBe(404);
  const next = await x.commit("index.html", "Second build");
  writeFileSync(join(x.integration, "index.html"), "Uncommitted conflict markers");
  const updating = x.previews.refresh(x.id);
  expect(await (await fetch(before.url!)).text()).toBe("First build");
  await updating;
  expect(x.previews.get(x.id)).toMatchObject({ status: "ready", commit: next });
  expect(await (await fetch(x.previews.get(x.id).url!)).text()).toBe("Second build");
  expect(await headCommit(x.repo)).toBe(x.run.baseCommit);
  expect(await Bun.file(join(x.repo, "private.txt")).text()).toBe("user's uncommitted file");
  expect(x.events.some((ev) => ev.type === "preview" && ev.preview.status === "ready")).toBe(true);
  await x.previews.stop(x.id);
});

test("keeps the previous HTTP server available when a new version fails, then recovers on the next merge", async () => {
  const x = await setup(command);
  await x.commit("server.ts", server("working"));
  await x.previews.refresh(x.id);
  const before = x.previews.get(x.id);
  expect(before.status).toBe("ready");
  await x.commit("server.ts", 'console.error("broken build"); process.exit(7);');
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id)).toMatchObject({ status: "failed", url: before.url, commit: before.commit });
  expect(x.previews.get(x.id).output).toContain("broken build");
  expect(await (await fetch(before.url!)).text()).toBe("working");
  const fixed = await x.commit("server.ts", server("fixed"));
  await Promise.all([x.previews.refresh(x.id), x.previews.refresh(x.id)]);
  expect(x.previews.get(x.id)).toMatchObject({ status: "ready", commit: fixed });
  const url = x.previews.get(x.id).url!;
  expect(await (await fetch(url)).text()).toBe("fixed");
  await x.previews.remove(x.id);
  await expect(fetch(url)).rejects.toThrow();
  await expect(fetch(before.url!)).rejects.toThrow();
});

test("bounds startup time, captures a clipped output tail and stops the subprocess group", async () => {
  const x = await setup(command, 1000);
  const pidFile = join(root, `${x.id}.pid`);
  await x.commit("server.ts", `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); console.log("x".repeat(12000)); setInterval(() => {}, 1000);`);
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id).status).toBe("failed");
  expect(x.previews.get(x.id).message).toContain("timed out");
  expect(x.previews.get(x.id).output.length).toBeLessThanOrEqual(8000);
  const pid = Number(await Bun.file(pidFile).text());
  expect(() => process.kill(pid, 0)).toThrow();
});

test("stop cancels an in-progress startup and queued refreshes cannot resurrect it", async () => {
  const x = await setup(command);
  await x.commit("server.ts", "setInterval(() => {}, 1000);");
  const a = x.previews.refresh(x.id);
  const b = x.previews.refresh(x.id);
  for (let i = 0; i < 100 && x.previews.get(x.id).status !== "starting"; i++) await Bun.sleep(10);
  await x.previews.stop(x.id);
  await Promise.all([a, b]);
  expect(x.previews.get(x.id)).toMatchObject({ status: "stopped", url: null });
});

test("an HTTP error page never replaces the last working version", async () => {
  const x = await setup(command, 1000);
  await x.commit("server.ts", server("last good build"));
  await x.previews.refresh(x.id);
  const good = x.previews.get(x.id);
  await x.commit("server.ts", 'Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response("Compile error", {status: 500}) });');
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id)).toMatchObject({ status: "failed", url: good.url, commit: good.commit });
  expect(await (await fetch(good.url!)).text()).toBe("last good build");
  await x.previews.stop(x.id);
});

test("detects a ready process exiting and requires an explicit restart after server restart", async () => {
  const x = await setup(command);
  const pidFile = join(root, `${x.id}.pid`);
  await x.commit("server.ts", `await Bun.write(${JSON.stringify(pidFile)}, String(process.pid)); ${server("alive")}`);
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id).status).toBe("ready");
  process.kill(Number(await Bun.file(pidFile).text()), "SIGKILL");
  for (let i = 0; i < 100 && x.previews.get(x.id).status === "ready"; i++) await Bun.sleep(10);
  expect(x.previews.get(x.id)).toMatchObject({ status: "failed", url: null });
  const restarted = createPreviews({ getRun: x.db.getRun, worktreeRoot: x.worktreeRoot, publish: () => {} });
  expect(restarted.get(x.id).status).toBe("stopped");
  expect(restarted.get(x.id).message).toContain("restart");
});
