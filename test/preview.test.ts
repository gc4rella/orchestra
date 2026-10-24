import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
async function setup(command = "", timeoutMs = 4000, watch = false) {
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
  const sources: string[] = [];
  if (watch) db.updateRun(id, { status: "running" });
  const reports: { values: Record<string, string>; commit: string }[] = [];
  const previews = createPreviews({ getRun: db.getRun, worktreeRoot, getEnvironment: db.secretEnvironment, onSecrets: (_, values, commit) => reports.push({ values, commit }), publish: (_, ev) => events.push(ev), timeoutMs, ...(watch && { getWorktrees: () => sources, refreshMs: 50 }) });
  managers.push(previews);
  const commit = async (name: string, content: string) => { writeFileSync(join(integration, name), content); await commitAll(integration, "Update"); return headCommit(integration); };
  return { id, db, repo, run, integration, worktreeRoot, previews, events, commit, sources, reports };
}
const bun = `'${process.execPath.replaceAll("'", "'\\''")}'`;
const command = `${bun} server.ts`;
const server = (text: string) => `Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(${JSON.stringify(text)}) });`;

test("preview receives project environment, captures private login details and keeps failed startup credentials private", async () => {
  const x = await setup(command);
  const legacyFile = join(x.worktreeRoot, x.id, ".preview-login.json");
  writeFileSync(legacyFile, JSON.stringify({ phone: "fixture-phone" }));
  x.db.saveSecret(x.repo, { name: "APP_PASSWORD", value: "fixture-secret-password", environment: true });
  x.db.saveSecret(x.repo, { name: "REFERENCE_ONLY", value: "do-not-inject", environment: false });
  const revision = await x.commit("server.ts", `
    if (process.env.REFERENCE_ONLY) throw new Error("Reference-only value leaked into environment");
    await Bun.write(process.env.ORCHESTRA_SECRETS_FILE!, JSON.stringify({ username: "fixture-user", password: process.env.APP_PASSWORD }));
    process.stdout.write("fixture-secret-"); await Bun.sleep(20); console.log("password");
    Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT), fetch: () => new Response(process.env.APP_PASSWORD) });
  `);
  await x.previews.refresh(x.id);
  const first = x.previews.get(x.id);
  expect(first.status).toBe("ready");
  expect(await (await fetch(first.url!)).text()).toBe("fixture-secret-password");
  expect(x.previews.secrets(x.id)).toEqual({ values: { phone: "fixture-phone", username: "fixture-user", password: "fixture-secret-password" }, commit: revision });
  expect(x.reports.at(-1)?.commit).toBe(revision);
  expect(first.output).toContain("[hidden]");
  expect(JSON.stringify(x.events)).not.toContain("fixture-secret-password");
  x.db.saveSecret(x.repo, { name: "APP_PASSWORD", value: "replacement-secret", environment: true });
  expect(await (await fetch(first.url!)).text()).toBe("fixture-secret-password");
  await x.previews.refresh(x.id, true);
  expect(await (await fetch(x.previews.get(x.id).url!)).text()).toBe("replacement-secret");
  const current = x.previews.get(x.id);
  await x.commit("server.ts", `await Bun.write(${JSON.stringify(legacyFile)}, JSON.stringify({phone:"failed-phone"})); await Bun.write(process.env.ORCHESTRA_SECRETS_FILE!, JSON.stringify({password:"failed-startup-password"})); console.log("failed-startup-password"); process.exit(1);`);
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id)).toMatchObject({ status: "failed", url: current.url });
  expect(x.previews.secrets(x.id)?.values.password).toBe("replacement-secret");
  expect(x.previews.secrets(x.id)?.values.phone).toBe("fixture-phone");
  expect(x.previews.get(x.id).output).not.toContain("failed-startup-password");
  expect(x.reports).toHaveLength(2);
  await x.previews.stop(x.id);
});

async function until(check: () => boolean) {
  for (let i = 0; i < 300 && !check(); i++) await Bun.sleep(10);
  expect(check()).toBe(true);
}

test("automatically previews active files, skips unchanged snapshots, and stops watching on stop", async () => {
  const x = await setup("", 4000, true);
  const task = join(x.worktreeRoot, x.id, "web");
  await addWorktree(x.repo, task, `${x.run.branch}-web`, x.run.baseCommit);
  x.sources.push(task);
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id).status).toBe("waiting");
  writeFileSync(join(task, "index.html"), "First uncommitted step");
  await until(() => x.previews.get(x.id).status === "ready");
  const first = x.previews.get(x.id);
  expect(first.draft).toBe(true);
  expect(await (await fetch(first.url!)).text()).toBe("First uncommitted step");
  await Bun.sleep(250);
  expect(x.previews.get(x.id).url).toBe(first.url);
  expect(x.previews.get(x.id).updatedAt).toBe(first.updatedAt);
  writeFileSync(join(task, "index.html"), "Second uncommitted step");
  await until(() => x.previews.get(x.id).commit !== first.commit);
  expect(await (await fetch(x.previews.get(x.id).url!)).text()).toBe("Second uncommitted step");
  expect(await headCommit(task)).toBe(x.run.baseCommit);
  expect(await headCommit(x.integration)).toBe(x.run.baseCommit);
  const integrated = await x.commit("index.html", "Checked integration");
  x.sources.length = 0;
  await x.previews.refresh(x.id);
  expect(x.previews.get(x.id)).toMatchObject({ commit: integrated, draft: false });
  await x.previews.stop(x.id);
  writeFileSync(join(task, "index.html"), "Must stay stopped");
  await Bun.sleep(150);
  expect(x.previews.get(x.id)).toMatchObject({ status: "stopped", url: null });
});

test("new draft files supersede a stalled startup while the previous preview stays available", async () => {
  const x = await setup(command, 10_000, true);
  const baseline = await x.commit("server.ts", server("integrated"));
  await x.previews.refresh(x.id);
  const before = x.previews.get(x.id);
  const task = join(x.worktreeRoot, x.id, "web");
  await addWorktree(x.repo, task, `${x.run.branch}-web`, baseline);
  x.sources.push(task);
  writeFileSync(join(task, "server.ts"), "setInterval(() => {}, 1000);");
  await until(() => x.previews.get(x.id).message.includes("Waiting for the preview server"));
  expect(await (await fetch(before.url!)).text()).toBe("integrated");
  writeFileSync(join(task, "server.ts"), server("latest draft"));
  await until(() => x.previews.get(x.id).status === "ready" && !!x.previews.get(x.id).draft);
  expect(await (await fetch(x.previews.get(x.id).url!)).text()).toBe("latest draft");
  expect(x.events.some((event) => event.type === "preview" && event.preview.status === "failed")).toBe(false);
  await x.previews.shutdown();
  writeFileSync(join(task, "server.ts"), server("must not restart"));
  await Bun.sleep(150);
  expect(x.previews.get(x.id).status).toBe("stopped");
});

test("file updates during dependency installation reuse the completed install for the latest draft", async () => {
  const x = await setup("", 6000, true);
  const task = join(x.worktreeRoot, x.id, "web");
  await addWorktree(x.repo, task, `${x.run.branch}-web`, x.run.baseCommit);
  x.sources.push(task);
  const started = join(root, `${x.id}-install-started`), gate = join(root, `${x.id}-install-gate`);
  writeFileSync(join(task, "package.json"), JSON.stringify({ name: "preview-fixture", scripts: { preinstall: `${bun} install.ts`, dev: `${bun} server.ts # vite` } }));
  writeFileSync(join(task, "install.ts"), `import { existsSync, mkdirSync } from "node:fs"; await Bun.write(${JSON.stringify(started)}, String(process.pid)); while (!existsSync(${JSON.stringify(gate)})) await Bun.sleep(20); mkdirSync("node_modules", {recursive: true});`);
  writeFileSync(join(task, "server.ts"), server("initial draft"));
  const refreshing = x.previews.refresh(x.id);
  try {
    await until(() => existsSync(started));
    const installer = Number(await Bun.file(started).text());
    writeFileSync(join(task, "server.ts"), server("updated during install"));
    await Bun.sleep(400);
    expect(() => process.kill(installer, 0)).not.toThrow();
    writeFileSync(gate, "ready");
    await until(() => x.previews.get(x.id).status === "ready");
    expect(await (await fetch(x.previews.get(x.id).url!)).text()).toBe("updated during install");
    expect(Number(await Bun.file(started).text())).toBe(installer);
  } finally {
    writeFileSync(gate, "ready");
    await x.previews.stop(x.id);
    await refreshing;
  }
}, 10_000);

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
