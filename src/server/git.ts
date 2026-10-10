import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DiffFile, FolderListing, WorkspaceCheck } from "../shared/types.ts";

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

/** Checks out an existing branch in a new worktree, e.g. to continue a finished run's integration branch. */
export async function openWorktree(repo: string, path: string, branch: string) {
  await removeWorktree(repo, path);
  mkdirSync(join(path, ".."), { recursive: true });
  await git(repo, "worktree", "add", path, branch);
}

export const branchExists = async (repo: string, branch: string) =>
  (await gitTry(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;

export async function removeWorktree(repo: string, path: string) {
  if (existsSync(path)) await gitTry(repo, "worktree", "remove", "--force", path);
  await gitTry(repo, "worktree", "prune");
}

export const deleteBranch = (repo: string, branch: string) => gitTry(repo, "branch", "-D", branch);

/**
 * Removes a run's worktrees (everything under `worktreeDir`) and the given branches. Returns the branches that
 * still exist afterwards, e.g. because the user has one checked out. A missing repository only loses its worktree dir.
 */
export async function pruneRun(repo: string, worktreeDir: string, branches: string[]) {
  const remaining: string[] = [];
  if (existsSync(repo)) {
    if (existsSync(worktreeDir)) for (const name of readdirSync(worktreeDir)) await removeWorktree(repo, join(worktreeDir, name));
    for (const branch of branches) {
      await deleteBranch(repo, branch);
      if (await branchExists(repo, branch)) remaining.push(branch);
    }
  }
  rmSync(worktreeDir, { recursive: true, force: true });
  return remaining;
}

/** Stages everything and commits. Returns false when there was nothing to commit. */
export async function commitAll(cwd: string, message: string): Promise<boolean> {
  await git(cwd, "add", "-A");
  if ((await gitTry(cwd, "diff", "--cached", "--quiet")).code === 0) return false;
  await git(cwd, ...IDENTITY, "commit", "-m", message);
  return true;
}

export const mergeBase = (cwd: string, a: string, b: string) => git(cwd, "merge-base", a, b);

/** The diff of `from` to the working tree's HEAD, clipped for a prompt. */
export async function diffText(cwd: string, from: string, max = 60_000): Promise<string> {
  const out = await git(cwd, "diff", "--no-color", "--no-ext-diff", "-M", from, "HEAD");
  return out.length > max ? `${out.slice(0, max)}\n… (diff clipped at ${max} characters; read the files for the rest)` : out;
}

const MAX_PATCH = 100_000;
const MAX_FILES = 300;

/** Git quotes special paths using C escapes and octal UTF-8 bytes. */
function decodeDiffPath(path: string) {
  if (!path.startsWith('"') || !path.endsWith('"')) return path;
  const escapes: Record<string, string> = { a: "\x07", b: "\b", f: "\f", n: "\n", r: "\r", t: "\t", v: "\v" };
  const bytes = path.slice(1, -1).split(/(\\(?:[0-7]{1,3}|.))/g).map((part) => {
    if (/^\\[0-7]/.test(part)) return Buffer.from([parseInt(part.slice(1), 8)]);
    return Buffer.from(part.startsWith("\\") ? (escapes[part.slice(1)] ?? part.slice(1)) : part);
  });
  return Buffer.concat(bytes).toString("utf8");
}

/** Files changed between two commits, each with its hunks, for the diff viewer. */
export async function diffFiles(repo: string, from: string, to: string): Promise<DiffFile[]> {
  const raw = await git(repo, "diff", "--no-color", "--no-ext-diff", "-M", from, to);
  return parseDiff(raw).slice(0, MAX_FILES);
}

/** Splits `git diff` output into files. Paths are read from the `---`/`+++` and rename headers. */
export function parseDiff(raw: string): DiffFile[] {
  const files: DiffFile[] = [];
  for (const chunk of raw.split(/^diff --git /m).slice(1)) {
    const lines = chunk.split("\n");
    const hunkStart = lines.findIndex((l) => l.startsWith("@@"));
    const header = hunkStart >= 0 ? lines.slice(0, hunkStart) : lines;
    const field = (prefix: string) => header.find((l) => l.startsWith(prefix))?.slice(prefix.length);
    const strip = (p: string | undefined) => (p && p !== "/dev/null" ? decodeDiffPath(p).replace(/^[ab]\//, "") : null);
    // Unquoted paths with spaces have a trailing tab separating the optional timestamp.
    const minus = strip(field("--- ")?.split("\t")[0]);
    const plus = strip(field("+++ ")?.split("\t")[0]);
    const renamed = (prefix: string) => { const p = field(prefix); return p === undefined ? undefined : decodeDiffPath(p); };
    const renameFrom = renamed("rename from ");
    const renameTo = renamed("rename to ");
    // Without ---/+++ (binary or pure rename), fall back to the "a/x b/x" header.
    const [, headA, headB] = lines[0]!.match(/^("(?:\\.|[^"\\])*"|a\/.+) ("(?:\\.|[^"\\])*"|b\/.+)$/) ?? [];
    const path = renameTo ?? plus ?? minus ?? strip(headB) ?? strip(headA) ?? "?";
    const status: DiffFile["status"] = renameTo ? "renamed"
      : field("new file mode") !== undefined ? "added"
      : field("deleted file mode") !== undefined ? "deleted"
      : "modified";
    const body = hunkStart >= 0 ? lines.slice(hunkStart) : [];
    let patch = body.join("\n").replace(/\n$/, "");
    const truncated = patch.length > MAX_PATCH;
    if (truncated) patch = patch.slice(0, patch.lastIndexOf("\n", MAX_PATCH));
    files.push({
      path,
      oldPath: renameFrom ?? (status === "renamed" ? minus : null),
      status,
      additions: body.filter((l) => l.startsWith("+")).length,
      deletions: body.filter((l) => l.startsWith("-")).length,
      binary: header.some((l) => l.startsWith("Binary files ")),
      patch,
      truncated,
    });
  }
  return files;
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

/** Recover the merge receipt when git finished before the task checkpoint was saved. */
export async function taskMergeCommit(cwd: string, start: string, message: string): Promise<string | null> {
  const commits = await git(cwd, "log", "--first-parent", "--merges", "--format=%H", "--fixed-strings", `--grep=${message}`, `${start}..HEAD`);
  return commits.split("\n").find(Boolean) ?? null;
}
