import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openDb } from "../src/server/db.ts";
import { startServer } from "../src/server/http.ts";
import { createScheduler } from "../src/server/scheduler.ts";
import { readSecretReport, SecretBody, secretCipher } from "../src/server/secrets.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-secrets-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

test("secret reports reject links, malformed values and oversized files", () => {
  const path = join(root, "report.json");
  writeFileSync(path, JSON.stringify({ username: "fixture-user", password: "fixture-password" }));
  expect(readSecretReport(path)).toEqual({ username: "fixture-user", password: "fixture-password" });
  symlinkSync(path, join(root, "linked.json"));
  expect(readSecretReport(join(root, "linked.json"))).toEqual({});
  for (const value of ['{"password":42}', '{"password":"unterminated', '{"../escape":"value"}', JSON.stringify({ password: "x".repeat(64_001) })]) {
    writeFileSync(path, value);
    expect(readSecretReport(path)).toEqual({});
  }
  expect(readSecretReport(root)).toEqual({});
  expect(readSecretReport(join(root, "missing.json"))).toEqual({});
});

test("encryption binds values to their project and key; environment names cannot override the launcher", () => {
  const cipher = secretCipher(null);
  const encrypted = cipher.seal("fixture-value", "project-one");
  expect(cipher.open(encrypted, "project-one")).toBe("fixture-value");
  expect(() => cipher.open(encrypted, "project-two")).toThrow("Could not unlock");
  expect(() => secretCipher(null).open(encrypted, "project-one")).toThrow("Could not unlock");
  for (const name of ["PORT", "HOST", "ORCHESTRA_SECRETS_FILE", "PATH", "NODE_OPTIONS", "BASH_ENV", "DYLD_INSERT_LIBRARIES"]) {
    expect(SecretBody.safeParse({ name, value: "value", environment: true }).success).toBe(false);
  }
  expect(SecretBody.safeParse({ name: "API_KEY", value: "  preserve whitespace\n", environment: true }).success).toBe(true);
  expect(SecretBody.safeParse({ name: "API_KEY", value: "null\0byte", environment: true }).success).toBe(false);
});

test("secrets API imports private preview logins, returns metadata only, and enforces explicit guarded reveal", async () => {
  const db = openDb(":memory:");
  const agent = db.createAgent({ name: "Director", runtime: "codex", model: null, effort: null, role: "Director", expertise: "", skills: [], instructions: null });
  const run = db.createRun({ id: "one", prompt: "Build", workdir: "/project-one", directorAgentId: agent.id, baseCommit: "base", branch: "orchestra/one", warning: null });
  db.createRun({ ...run, id: "two", branch: "orchestra/two", workdir: "/project-two" });
  db.createRun({ ...run, id: "same", branch: "orchestra/same" });
  const runRoot = join(root, "worktrees", run.id);
  mkdirSync(runRoot, { recursive: true });
  writeFileSync(join(runRoot, ".preview-login.json"), JSON.stringify({ phone: "+390000000000", password: "fixture-preview-password" }));
  const events: unknown[] = [];
  const scheduler = createScheduler({ db, runAgent: async () => { throw new Error("No model calls for secrets"); }, worktreeRoot: join(root, "worktrees"), publish: (_, event) => events.push(event) });
  const server = startServer({ db, scheduler, runAgent: async () => ({ ok: false, text: "" }), port: 0 });
  const request = (path = "one/secrets", method = "GET", body?: unknown, origin?: string) => fetch(`http://127.0.0.1:${server.port}/api/runs/${path}`, { method, headers: { "Content-Type": "application/json", ...(origin ? { origin } : {}) }, body: body === undefined ? undefined : JSON.stringify(body) });
  try {
    let response = await request();
    expect(response.headers.get("cache-control")).toBe("no-store");
    let text = await response.text();
    expect(text).toContain('"name":"password"');
    expect(text).not.toContain("fixture-preview-password");
    response = await request("one/secrets/reveal", "POST", { name: "password", source: "preview" });
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({ value: "fixture-preview-password" });
    expect((await request("one/secrets/reveal", "POST", { name: "password", source: "preview" }, "https://evil.example")).status).toBe(403);
    expect((await request("one/secrets/reveal", "POST", { name: "password", source: "preview" }, "http://127.0.0.1:9999")).status).toBe(403);
    expect((await request("two/secrets/reveal", "POST", { name: "password", source: "preview" })).status).toBe(404);
    expect((await request("same/secrets/reveal", "POST", { name: "password", source: "preview" })).status).toBe(404);
    expect((await request("missing/secrets")).status).toBe(404);
    expect((await request("one/secrets", "PUT", { name: "PORT", value: "9999", environment: true })).status).toBe(400);
    expect((await request("one/secrets", "PUT", { name: "TOKEN", value: "fixture-api-token", environment: true })).status).toBe(200);
    text = await (await request("same/secrets")).text();
    expect(text).toContain('"name":"TOKEN"');
    expect(text).not.toContain("fixture-api-token");
    expect((await request("one/secrets/reveal", "GET")).status).not.toBe(200);
    expect(await (await request("same/secrets/reveal", "POST", { name: "TOKEN", source: "saved" })).json()).toEqual({ value: "fixture-api-token" });
    expect(JSON.stringify(await (await request("one")).json())).not.toContain("fixture-api-token");
    expect(events).toEqual([]);
    expect((await request("one/secrets", "DELETE", { name: "TOKEN", source: "saved" })).status).toBe(200);
    expect((await request("same/secrets/reveal", "POST", { name: "TOKEN", source: "saved" })).status).toBe(404);
  } finally { server.stop(true); db.close(); }
});
