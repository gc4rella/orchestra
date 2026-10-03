import { existsSync, mkdirSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join } from "node:path";

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

/**
 * Makes `workdir` usable as a run base without touching the user's checkout:
 * a missing or empty dir becomes a fresh repo; an existing repo root is used at HEAD.
 */
export async function prepareWorkspace(workdir: string): Promise<{ baseCommit: string; warning: string | null }> {
  if (!isAbsolute(workdir)) throw new WorkspaceError("Project directory must be an absolute path");
  if (existsSync(workdir) && !statSync(workdir).isDirectory()) throw new WorkspaceError("Project path is not a directory");
  mkdirSync(workdir, { recursive: true });
  const root = realpathSync(workdir);

  if (readdirSync(root).length === 0) {
    await git(root, "init", "-b", "main");
    await git(root, ...IDENTITY, "commit", "--allow-empty", "-m", "Initial commit (Orchestra)");
    return { baseCommit: await git(root, "rev-parse", "HEAD"), warning: null };
  }

  const top = await gitTry(root, "rev-parse", "--show-toplevel");
  if (top.code !== 0) throw new WorkspaceError("Directory is not empty and not a git repository. Run `git init` and commit first.");
  if (realpathSync(top.stdout) !== root) throw new WorkspaceError(`Directory is inside a git repository; use its root: ${top.stdout}`);

  const head = await gitTry(root, "rev-parse", "--verify", "HEAD");
  if (head.code !== 0) throw new WorkspaceError("Repository has no commits yet. Commit something first.");
  const dirty = (await git(root, "status", "--porcelain")) !== "";
  return { baseCommit: head.stdout, warning: dirty ? "Uncommitted changes in the project are not included in this run." : null };
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
