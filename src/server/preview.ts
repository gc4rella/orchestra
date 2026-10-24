import type { Server } from "bun";
import { existsSync, readFileSync, realpathSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve, sep } from "node:path";
import type { PreviewState, Run, ServerEvent } from "../shared/types.ts";
import { headCommit, preparePreviewWorktree, snapshotPreview } from "./git.ts";
import { readSecretReport } from "./secrets.ts";

const OUTPUT_LIMIT = 8_000;
const START_TIMEOUT_MS = 180_000;
const REFRESH_INTERVAL_MS = 1_000;
type Snapshot = Awaited<ReturnType<typeof snapshotPreview>>;
type Recipe = { command: string; install: string; fingerprint: string } | { static: true };
type Instance = { url: string; slot: number; secretFile?: string; legacySecrets?: Record<string, string>; close: () => Promise<void> };
type Entry = {
  state: PreviewState;
  active?: Instance;
  controller?: AbortController;
  installing?: boolean;
  chain: Promise<void>;
  scan: Promise<void>;
  scanning: boolean;
  rescan: boolean;
  force: boolean;
  queued: boolean;
  target?: Snapshot;
  timer?: ReturnType<typeof setTimeout>;
  generation: number;
  fingerprints: Map<number, string>;
};

const stopped = (): PreviewState => ({ status: "stopped", url: null, commit: null, draft: false, updatedAt: null, message: "Preview is stopped.", output: "" });

/** Auto-detection is deliberately limited to servers whose loopback and port flags we know. */
export function previewRecipe(cwd: string, custom: string): Recipe | null {
  if (custom) return { command: custom, install: "", fingerprint: "" };
  const pkgPath = join(cwd, "package.json");
  if (!existsSync(pkgPath)) return existsSync(join(cwd, "index.html")) ? { static: true } : null;
  const pkg = JSON.parse(readFileSync(pkgPath, "utf8")) as { scripts?: Record<string, string> };
  const dev = pkg.scripts?.dev;
  if (!dev) return null;
  const flags = /(?:^|\s)next\s+dev(?:\s|$)/.test(dev) ? '--hostname 127.0.0.1 --port "$PORT"'
    : /(?:^|\s)(?:vite|astro(?:\s+dev)?)(?:\s|$)/.test(dev) ? '--host 127.0.0.1 --port "$PORT"'
    : null;
  if (!flags) return null;
  const locks = ["bun.lock", "bun.lockb", "pnpm-lock.yaml", "yarn.lock", "package-lock.json"];
  const lock = locks.find((file) => existsSync(join(cwd, file)));
  const manager = lock?.startsWith("pnpm") ? "pnpm" : lock === "yarn.lock" ? "yarn" : lock === "package-lock.json" ? "npm" : "bun";
  const fingerprint = Bun.hash(Buffer.concat([readFileSync(pkgPath), lock ? readFileSync(join(cwd, lock)) : Buffer.alloc(0)])).toString();
  return { command: `${manager} run dev ${manager === "npm" ? "-- " : ""}${flags}`, install: `${manager} install`, fingerprint };
}

async function freePort(): Promise<number> {
  const socket = createServer();
  return new Promise((accept, reject) => {
    socket.once("error", reject);
    socket.listen(0, "127.0.0.1", () => {
      const address = socket.address();
      socket.close((error) => error ? reject(error) : typeof address === "object" && address ? accept(address.port) : reject(new Error("No preview port available")));
    });
  });
}

function launch(cwd: string, command: string, port: number, signal: AbortSignal, output: (text: string) => void, environment: Record<string, string> = {}) {
  const options = {
    cwd, env: { ...process.env, ...environment, PORT: String(port), HOST: "127.0.0.1", BROWSER: "none" },
    stdin: "ignore", stdout: "pipe", stderr: "ignore", detached: true,
  } as const;
  const proc = Bun.spawn(["sh", "-c", `exec 2>&1; ${command}`], options as Omit<typeof options, "detached">);
  const kill = () => {
    try { process.kill(-proc.pid, "SIGKILL"); } catch { proc.kill("SIGKILL"); }
  };
  signal.addEventListener("abort", kill, { once: true });
  if (signal.aborted) kill();
  const drained = (async () => {
    const decoder = new TextDecoder();
    for await (const chunk of proc.stdout) output(decoder.decode(chunk, { stream: true }));
    output(decoder.decode());
  })();
  const close = async () => {
    kill();
    await proc.exited;
    await drained;
    signal.removeEventListener("abort", kill);
  };
  return { proc, close, drained };
}

function serveStatic(cwd: string): Server {
  const root = realpathSync(cwd);
  return Bun.serve({
    hostname: "127.0.0.1", port: 0,
    async fetch(req, server) {
      if (req.headers.get("host") !== `127.0.0.1:${server.port}`) return new Response("Forbidden host", { status: 403 });
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("Method not allowed", { status: 405 });
      try {
        const pathname = decodeURIComponent(new URL(req.url).pathname);
        if (pathname.split("/").some((part) => part.startsWith("."))) return new Response("Not found", { status: 404 });
        let path = resolve(root, `.${pathname}`);
        if (statSync(path).isDirectory()) path = join(path, "index.html");
        const real = realpathSync(path);
        if (!real.startsWith(root + sep) || !statSync(real).isFile()) return new Response("Not found", { status: 404 });
        return new Response(req.method === "HEAD" ? null : Bun.file(real), { headers: { "cache-control": "no-store" } });
      } catch { return new Response("Not found", { status: 404 }); }
    },
  });
}

export function createPreviews(opts: {
  getRun: (id: string) => Run | null;
  worktreeRoot: string;
  publish: (runId: string, ev: ServerEvent) => void;
  getWorktrees?: (id: string) => string[];
  getEnvironment?: (workdir: string) => Record<string, string>;
  onSecrets?: (id: string, values: Record<string, string>, commit: string) => void;
  timeoutMs?: number;
  refreshMs?: number;
}) {
  const entries = new Map<string, Entry>();
  let shuttingDown = false;
  const entry = (id: string) => {
    let e = entries.get(id);
    if (!e) {
      e = { state: stopped(), chain: Promise.resolve(), scan: Promise.resolve(), scanning: false, rescan: false, force: false, queued: false, generation: 0, fingerprints: new Map() };
      entries.set(id, e);
    }
    return e;
  };
  const set = (id: string, e: Entry, patch: Partial<PreviewState>) => {
    e.state = { ...e.state, ...patch };
    opts.publish(id, { type: "preview", runId: id, preview: e.state });
  };

  async function update(id: string, e: Entry, generation: number, target: Snapshot) {
    const run = opts.getRun(id);
    if (shuttingDown || !run?.preview.enabled || generation !== e.generation) return;
    const controller = new AbortController();
    e.controller = controller;
    let candidate: Instance | undefined;
    let timeout: ReturnType<typeof setTimeout> | undefined;
    let output = "";
    let environment: Record<string, string> = {};
    let secretFile: string | undefined;
    const safeOutput = () => {
      const values = [...Object.values(environment), ...Object.values(secretFile ? readSecretReport(secretFile) : {}), ...Object.values(readSecretReport(join(opts.worktreeRoot, id, ".preview-login.json")))];
      let safe = output;
      for (const value of values.filter(Boolean).sort((a, b) => b.length - a.length)) safe = safe.replaceAll(value, "[hidden]");
      return safe.slice(-OUTPUT_LIMIT);
    };
    const current = () => !controller.signal.aborted && generation === e.generation && e.target === target && !shuttingDown;
    try {
      const { commit, draft } = target;
      if (!current()) return;
      set(id, e, { status: "starting", message: e.active ? "Starting the latest team progress. The previous version is still available." : "Starting the latest team progress…", output: "" });
      timeout = setTimeout(() => controller.abort(new Error("Preview startup timed out.")), opts.timeoutMs ?? START_TIMEOUT_MS);
      const slot = e.active?.slot === 0 ? 1 : 0;
      const cwd = join(opts.worktreeRoot, id, `.preview-${slot}`);
      await preparePreviewWorktree(run.workdir, cwd, commit);
      if (!current()) { controller.signal.throwIfAborted(); return; }
      const recipe = previewRecipe(cwd, run.preview.command);
      if (!recipe) {
        set(id, e, { status: "waiting", message: "Waiting for a web app. Auto-detects Vite, Next.js, Astro or a root index.html. Set a custom command for other projects." });
        return;
      }
      const append = (text: string) => { output = (output + text).slice(-OUTPUT_LIMIT * 2); };
      if ("static" in recipe) {
        const server = serveStatic(cwd);
        candidate = { slot, url: `http://127.0.0.1:${server.port}`, close: async () => { server.stop(true); } };
      } else {
        const port = await freePort();
        if (!current()) { controller.signal.throwIfAborted(); return; }
        if (recipe.install && (e.fingerprints.get(slot) !== recipe.fingerprint || !existsSync(join(cwd, "node_modules")))) {
          set(id, e, { message: "Installing preview dependencies. The previous version stays available." });
          const install = launch(cwd, recipe.install, port, controller.signal, append);
          e.installing = true;
          try {
            const code = await install.proc.exited;
            await install.drained;
            if (code !== 0) throw new Error(`Dependency install exited with code ${code}.`);
            e.fingerprints.set(slot, recipe.fingerprint);
          } finally { await install.close(); e.installing = false; }
        }
        if (!current()) { controller.signal.throwIfAborted(); return; }
        environment = opts.getEnvironment?.(run.workdir) ?? {};
        secretFile = join(opts.worktreeRoot, id, `.preview-secrets-${slot}.json`);
        try { unlinkSync(secretFile); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        writeFileSync(secretFile, "{}", { flag: "wx", mode: 0o600 });
        set(id, e, { message: "Waiting for the preview server to respond…" });
        const worker = launch(cwd, recipe.command, port, controller.signal, append, { ...environment, ORCHESTRA_PREVIEW: "1", ORCHESTRA_SECRETS_FILE: secretFile });
        candidate = { slot, secretFile, url: `http://127.0.0.1:${port}`, close: worker.close };
        while (current()) {
          if (worker.proc.exitCode !== null) throw new Error(`Preview command exited with code ${worker.proc.exitCode}.`);
          try {
            const response = await fetch(candidate.url, { signal: AbortSignal.any([controller.signal, AbortSignal.timeout(1000)]), redirect: "manual" });
            await response.body?.cancel();
            if (response.status >= 200 && response.status < 400) break;
          } catch { /* The app may still be compiling. */ }
          await Bun.sleep(200);
        }
        const instance = candidate;
        void worker.proc.exited.then(async (code) => {
          if (e.active !== instance) return;
          e.active = undefined;
          await worker.close();
          set(id, e, { status: "failed", url: null, message: `Preview server exited with code ${code}. Restart the preview to try again.`, output: safeOutput() });
        });
      }
      if (!current()) { controller.signal.throwIfAborted(); return; }
      candidate!.legacySecrets = readSecretReport(join(opts.worktreeRoot, id, ".preview-login.json"));
      opts.onSecrets?.(id, { ...candidate!.legacySecrets, ...readSecretReport(secretFile ?? "") }, commit);
      const previous = e.active;
      e.active = candidate;
      candidate = undefined;
      // A ready server outlives the startup timeout and the build controller.
      clearTimeout(timeout);
      e.controller = undefined;
      set(id, e, { status: "ready", url: e.active.url, commit, draft, updatedAt: Date.now(), message: draft ? "Live · work in progress · checks pending" : "Live · latest integrated work", output: safeOutput() });
      await previous?.close();
    } catch (error) {
      if (generation === e.generation && e.target === target && !shuttingDown) {
        set(id, e, { status: "failed", output: safeOutput(), message: `${controller.signal.aborted ? "Preview startup timed out." : error instanceof Error ? error.message : String(error)}${e.active ? " The previous version is still available." : ""}` });
      }
    } finally {
      clearTimeout(timeout);
      await candidate?.close();
      if (e.controller === controller) e.controller = undefined;
    }
  }

  function refresh(id: string, force = false) {
    if (shuttingDown || !opts.getRun(id)?.preview.enabled) return Promise.resolve();
    const e = entry(id);
    e.force ||= force;
    if (e.scanning) {
      e.rescan = true;
      return e.scan.then(() => e.chain);
    }
    clearTimeout(e.timer);
    e.scanning = true;
    const generation = e.generation;
    const current = () => generation === e.generation && !shuttingDown && opts.getRun(id)?.preview.enabled;
    e.scan = (async () => {
      do {
        e.rescan = false;
        const run = opts.getRun(id);
        if (!run || !current()) return;
        // Read the accepted ref atomically, never the integration or conflict-resolution files.
        const baseline = await headCommit(run.workdir, run.branch);
        const target = await snapshotPreview(run.workdir, baseline, opts.getWorktrees?.(id) ?? [], join(opts.worktreeRoot, id, ".preview-snapshot"));
        if (!current()) return;
        if (e.force || target.commit !== e.target?.commit || target.draft !== e.target?.draft) {
          e.force = false;
          e.target = target;
          // Let reusable dependencies finish installing even when the team keeps editing.
          if (!e.installing) e.controller?.abort();
          if (!e.queued) {
            e.queued = true;
            e.chain = e.chain.then(async () => {
              e.queued = false;
              if (current() && e.target) await update(id, e, generation, e.target);
            });
          }
        }
      } while (e.rescan && current());
    })().catch((error) => {
      if (current()) set(id, e, { status: "failed", message: `Could not update the preview: ${error instanceof Error ? error.message : String(error)}` });
    }).finally(() => { e.scanning = false; schedule(); });
    function schedule() {
      if (!current() || !opts.getWorktrees) return;
      e.timer = setTimeout(() => {
        if (opts.getRun(id)?.status === "running") void refresh(id);
        else schedule();
      }, opts.refreshMs ?? REFRESH_INTERVAL_MS);
      e.timer.unref();
    }
    return e.scan.then(() => e.chain);
  }
  function stop(id: string) {
    const e = entry(id);
    e.generation++;
    clearTimeout(e.timer);
    e.target = undefined;
    e.controller?.abort();
    e.chain = Promise.all([e.chain, e.scan]).then(async () => {
      const previous = e.active;
      e.active = undefined;
      await previous?.close();
      set(id, e, stopped());
    });
    return e.chain;
  }
  return {
    secrets: (id: string) => {
      const e = entries.get(id);
      return e?.active ? { values: { ...e.active.legacySecrets, ...readSecretReport(e.active.secretFile ?? "") }, commit: e.state.commit } : null;
    },
    get: (id: string): PreviewState => entries.get(id)?.state ?? { ...stopped(), message: opts.getRun(id)?.preview.enabled ? "Preview is stopped. Start it to resume after an Orchestra restart." : "Enable a live preview to watch integrated work as it lands." },
    refresh,
    stop,
    remove: async (id: string) => { await stop(id); entries.delete(id); },
    shutdown: async () => { shuttingDown = true; await Promise.all([...entries.keys()].map(stop)); },
  };
}
