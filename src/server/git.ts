import { existsSync, mkdirSync, readdirSync, realpathSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { FolderListing, WorkspaceCheck } from "../shared/types.ts";

/** Commits are authored by Orchestra so they never depend on the user's git identity. */
const IDENTITY = ["-c", "user.name=Orchestra", "-c", "user.email=orchestra@localhost"];

export class WorkspaceError extends Error {}

type GitResult = { code: number; stdout: string; stderr: string };

async function gitTry(cwd: string, ...args: string[]): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout: stdout.trim(), stderr: stderr.trim() };
}

async function git(cwd: string, ...args: string[]): Promise<string> {
  const r = await gitTry(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr || r.stdout}`);
  return r.stdout;
}

/** Folders that don't stop a directory from counting as empty. */
const IGNORABLE = new Set([".DS_Store"]);

/** Decides, without changing anything, how `workdir` would be used as a run base. */
export async function inspectWorkspace(workdir: string): Promise<WorkspaceCheck> {
  const invalid = (reason: string, root?: string): WorkspaceCheck => ({ kind: "invalid", reason, ...(root && { root }) });
  if (!isAbsolute(workdir)) return invalid("Project directory must be an absolute path");
  if (!existsSync(workdir)) return { kind: "new" };
  let root: string;
  let entries: string[];
  try {
    if (!statSync(workdir).isDirectory()) return invalid("Project path is not a directory");
    root = realpathSync(workdir);
    entries = readdirSync(root).filter((n) => !IGNORABLE.has(n));
  } catch {
    return invalid("This folder can't be read");
  }
  if (entries.length === 0) return { kind: "empty" };

  const top = await gitTry(root, "rev-parse", "--show-toplevel");
  if (top.code !== 0) return invalid("Directory is not empty and not a git repository. Run `git init` and commit first.");
  if (realpathSync(top.stdout) !== root) return invalid(`Directory is inside a git repository; use its root: ${top.stdout}`, top.stdout);

  const head = await gitTry(root, "rev-parse", "--verify", "HEAD");
  if (head.code !== 0) return invalid("Repository has no commits yet. Commit something first.");
  const branch = (await gitTry(root, "branch", "--show-current")).stdout || null;
  const dirty = (await git(root, "status", "--porcelain")).split("\n").filter(Boolean).length;
  return { kind: "repo", head: head.stdout, branch, dirty };
}

/**
 * Makes `workdir` usable as a run base without touching the user's checkout:
 * a missing or empty dir becomes a fresh repo; an existing repo root is used at HEAD.
 */
export async function prepareWorkspace(workdir: string): Promise<{ baseCommit: string; warning: string | null }> {
  const ws = await inspectWorkspace(workdir);
  if (ws.kind === "invalid") throw new WorkspaceError(ws.reason);
  if (ws.kind === "repo") {
    return { baseCommit: ws.head, warning: ws.dirty ? "Uncommitted changes in the project are not included in this run." : null };
  }
  mkdirSync(workdir, { recursive: true });
  const root = realpathSync(workdir);
  await git(root, "init", "-b", "main");
  await git(root, ...IDENTITY, "commit", "--allow-empty", "-m", "Initial commit (Orchestra)");
  return { baseCommit: await git(root, "rev-parse", "HEAD"), warning: null };
}

const MAX_FOLDERS = 500;

/** Visible subfolders of `dir` for the project picker, marking git repositories. */
export function listFolders(dir: string): FolderListing {
  if (!isAbsolute(dir)) throw new WorkspaceError("Folder path must be absolute");
  const path = resolve(dir);
  let entries: Dirent[];
  try {
    entries = readdirSync(path, { withFileTypes: true });
  } catch {
    throw new WorkspaceError(`Can't open ${path}`);
  }
  const folders = entries
    .filter((e) => !e.name.startsWith("."))
    .flatMap((e) => {
      const child = join(path, e.name);
      try {
        // statSync follows symlinks, so linked folders are listed too.
        return statSync(child).isDirectory() ? [{ name: e.name, path: child, repo: existsSync(join(child, ".git")) }] : [];
      } catch {
        return [];
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }))
    .slice(0, MAX_FOLDERS);
  return { path, parent: dirname(path) === path ? null : dirname(path), home: homedir(), folders };
}

export const headCommit = (cwd: string) => git(cwd, "rev-parse", "HEAD");

/** Creates `branch` at `startPoint` checked out in a new worktree, replacing leftovers from an earlier attempt. */
export async function addWorktree(repo: string, path: string, branch: string, startPoint: string) {
  await removeWorktree(repo, path);
  await gitTry(repo, "branch", "-D", branch);
  mkdirSync(join(path, ".."), { recursive: true });
  await git(repo, "worktree", "add", "-b", branch, path, startPoint);
}

export async function removeWorktree(repo: string, path: string) {
  if (existsSync(path)) await gitTry(repo, "worktree", "remove", "--force", path);
  await gitTry(repo, "worktree", "prune");
}

export const deleteBranch = (repo: string, branch: string) => gitTry(repo, "branch", "-D", branch);

/** Stages everything and commits. Returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, "add", "-A");
  if ((await gitTry(cwd, "diff", "--cached", "--quiet")).code === 0) return false;
  await git(cwd, ...IDENTITY, "commit", "-m", message);
  return true;
}

const inMerge = async (cwd: string) => (await gitTry(cwd, "rev-parse", "-q", "--verify", "MERGE_HEAD")).code === 0;

export async function abortMerge(cwd: string) {
  if (await inMerge(cwd)) await git(cwd, "merge", "--abort");
}

/** Merges `branch` into the worktree's branch. On conflict the merge is left open and the conflicted files returned. */
export async function mergeBranch(cwd: string, branch: string, message: string): Promise<{ conflicts: string[] }> {
  await abortMerge(cwd); // leftover from an interrupted earlier attempt
  const r = await gitTry(cwd, ...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", message, branch);
  if (r.code === 0) return { conflicts: [] };
  const conflicts = (await git(cwd, "diff", "--name-only", "--diff-filter=U")).split("\n").filter(Boolean);
  if (conflicts.length === 0) {
    await abortMerge(cwd);
    throw new Error(`git merge ${branch} failed: ${r.stderr || r.stdout}`);
  }
  return { conflicts };
}

const CONFLICT_MARKER = /^(<{7}|>{7}) /m;

/** Completes an open merge after conflicts were edited. Returns false if any file still has conflict markers. */
export async function concludeMerge(cwd: string, files: string[]): Promise<boolean> {
  for (const f of files) {
    const file = Bun.file(join(cwd, f));
    if ((await file.exists()) && CONFLICT_MARKER.test(await file.text())) return false;
  }
  await git(cwd, "add", "-A");
  if (await inMerge(cwd)) await git(cwd, ...IDENTITY, "commit", "--no-edit");
  return true;
}
