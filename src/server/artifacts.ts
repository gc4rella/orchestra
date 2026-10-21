import { copyFileSync, existsSync, lstatSync, mkdirSync, realpathSync } from "node:fs";
import { dirname, join, sep } from "node:path";
import { safeProjectPath } from "./delivery.ts";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

/** Copy evidence out of disposable worktrees; never follow a project symlink. */
export function captureArtifacts(cwd: string, paths: string[], root: string): { artifacts: string[]; missing: string[] } {
  const receipt = crypto.randomUUID();
  const artifacts: string[] = [];
  const missing: string[] = [];
  const base = realpathSync(cwd);
  let total = 0;
  for (const path of paths) {
    const file = join(cwd, path);
    if (!safeProjectPath(path) || !existsSync(file)) { missing.push(path); continue; }
    const resolved = realpathSync(file);
    const stat = lstatSync(file);
    if (!resolved.startsWith(base + sep) || stat.isSymbolicLink() || !stat.isFile() || stat.size > MAX_ARTIFACT_BYTES || total + stat.size > MAX_TOTAL_BYTES) { missing.push(path); continue; }
    const reference = `${receipt}/${path}`;
    const destination = join(root, reference);
    mkdirSync(dirname(destination), { recursive: true });
    copyFileSync(file, destination);
    total += stat.size;
    artifacts.push(reference);
  }
  return { artifacts, missing };
}
