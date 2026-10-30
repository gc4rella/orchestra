import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readSync, realpathSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { safeProjectPath } from "./delivery.ts";

const MAX_ARTIFACT_BYTES = 5 * 1024 * 1024;
const MAX_TOTAL_BYTES = 20 * 1024 * 1024;

function readArtifact(base: string, path: string): Buffer | null {
  if (!safeProjectPath(path)) return null;
  let fd: number | undefined;
  try {
    let cursor = base;
    const parts = path.split("/");
    for (const [index, part] of parts.entries()) {
      cursor = join(cursor, part);
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || (index < parts.length - 1 ? !stat.isDirectory() : !stat.isFile())) return null;
    }
    fd = openSync(cursor, constants.O_RDONLY | constants.O_NOFOLLOW);
    const stat = fstatSync(fd);
    if (!stat.isFile() || stat.size > MAX_ARTIFACT_BYTES) return null;
    const data = Buffer.alloc(stat.size + 1);
    let size = 0;
    while (size < data.length) {
      const count = readSync(fd, data, size, data.length - size, null);
      if (!count) break;
      size += count;
    }
    return size === stat.size ? data.subarray(0, size) : null;
  } catch { return null; }
  finally { if (fd !== undefined) closeSync(fd); }
}

function prepareParents(base: string, path: string): boolean {
  let cursor = base;
  try {
    for (const part of path.split("/").slice(0, -1)) {
      cursor = join(cursor, part);
      try { mkdirSync(cursor); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") return false; }
      const stat = lstatSync(cursor);
      if (stat.isSymbolicLink() || !stat.isDirectory()) return false;
    }
    return true;
  } catch { return false; }
}

export function missingArtifacts(cwd: string, paths: string[]): string[] {
  let base: string;
  try { base = realpathSync(cwd); } catch { return [...paths]; }
  let total = 0;
  return paths.filter((path) => {
    const data = readArtifact(base, path);
    if (!data || total + data.length > MAX_TOTAL_BYTES) return true;
    total += data.length;
    return false;
  });
}

/** Copy evidence out of disposable worktrees; never follow a project symlink. */
export function captureArtifacts(cwd: string, paths: string[], root: string): { artifacts: string[]; missing: string[] } {
  const receipt = crypto.randomUUID();
  const artifacts: string[] = [];
  const missing: string[] = [];
  const base = realpathSync(cwd);
  let total = 0;
  for (const path of paths) {
    const data = readArtifact(base, path);
    if (!data || total + data.length > MAX_TOTAL_BYTES) { missing.push(path); continue; }
    const reference = `${receipt}/${path}`;
    const destination = join(root, reference);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, data, { flag: "wx", mode: 0o600 });
    total += data.length;
    artifacts.push(reference);
  }
  return { artifacts, missing };
}

/** Rehydrate exact saved evidence without replacing project files or following either side's symlinks. */
export function restoreArtifacts(cwd: string, paths: string[], root: string, references: string[], tracked: ReadonlySet<string>): { restored: string[]; missing: string[] } {
  const restored: string[] = [], missing: string[] = [];
  let base: string, archive: string;
  try { base = realpathSync(cwd); archive = realpathSync(root); }
  catch { return { restored, missing: [...paths] }; }
  let total = 0;
  for (const path of paths) {
    const reference = references.find((value) => value.slice(value.indexOf("/") + 1) === path && value.indexOf("/") > 0);
    const data = reference ? readArtifact(archive, reference) : null;
    if (!safeProjectPath(path) || !data || total + data.length > MAX_TOTAL_BYTES) { missing.push(path); continue; }
    total += data.length;
    const existing = readArtifact(base, path);
    if (existing) { if (!existing.equals(data)) missing.push(path); continue; }
    if (tracked.has(path) || !prepareParents(base, path)) { missing.push(path); continue; }
    try { writeFileSync(join(base, path), data, { flag: "wx", mode: 0o600 }); restored.push(path); }
    catch { missing.push(path); }
  }
  return { restored, missing };
}
