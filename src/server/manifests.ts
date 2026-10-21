import { statSync } from "node:fs";
import type { Agent, Runtime, RuntimeManifest } from "../shared/types.ts";
import { cliDefaults, preferredTransport, runtimeEnvironment } from "./runtimes.ts";

const versions = new Map<string, Promise<string | null>>();
async function runtimeVersion(runtime: Runtime) {
  const bin = Bun.which(runtime === "codex" ? "codex" : "claude");
  if (!bin) return null;
  let key = bin;
  try { key += `:${statSync(bin).mtimeMs}`; } catch { return null; }
  let pending = versions.get(key);
  if (!pending) {
    pending = (async () => {
      try {
        const proc = Bun.spawn([bin, "--version"], { stdin: "ignore", stdout: "pipe", stderr: "ignore", timeout: 5000 });
        const output = await new Response(proc.stdout).text();
        return await proc.exited === 0 ? output.trim().split("\n")[0] ?? null : null;
      } catch { return null; }
    })();
    versions.set(key, pending);
  }
  return pending;
}

export async function runtimeManifest(agent: Agent, cwd: string): Promise<RuntimeManifest> {
  const [version, defaults, transport, environment] = await Promise.all([runtimeVersion(agent.runtime), cliDefaults(agent.runtime), preferredTransport(agent.runtime), runtimeEnvironment(agent.runtime, cwd)]);
  return { runtime: agent.runtime, version, model: agent.model ?? defaults.model, effort: agent.effort ?? defaults.effort, transport, skills: agent.skills.map((s) => ({ id: s.id, revision: s.revision ?? s.provenance?.revision ?? null })), environment };
}

/** A changed runtime, registered procedure or configuration source makes historical recommendations uncertain. */
export async function configurationFingerprint(agents: Agent[], cwd: string): Promise<string> {
  const configs = await Promise.all(agents.map(async (agent) => {
    const manifest = await runtimeManifest(agent, cwd);
    const sources = manifest.environment.sources.map((source) => {
      let changedAt: number | null = null;
      try { changedAt = statSync(source.path).mtimeMs; } catch { /* Inventory may change during a run. */ }
      return { ...source, changedAt };
    });
    return { id: agent.id, instructions: agent.instructions, role: agent.role, manifest: { ...manifest, environment: { sources } } };
  }));
  return String(Bun.hash(JSON.stringify(configs)));
}
