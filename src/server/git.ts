import { existsSync, mkdirSync, readdirSync, realpathSync, rmSync, statSync, type Dirent } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import type { DiffFile, FolderListing, WorkspaceCheck } from "../shared/types.ts";

/** Commits are authored by Orchestra so they never depend on the user's git identity. */
const IDENTITY = ["-c", "user.name=Orchestra", "-c", "user.email=orchestra@localhost"];

export class WorkspaceError extends Error {}

type GitResult = { code: number; stdout: string; stderr: string };

async function gitTry(cwd: string, ...args: string[]): Promise<GitResult> {
  return gitWithEnv(cwd, args);
}

async function gitWithEnv(cwd: string, args: string[], env = process.env): Promise<GitResult> {
  const proc = Bun.spawn(["git", ...args], { cwd, env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
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

/** A depth-1 clone of a public repository; fails instead of prompting for credentials or hanging. */
export async function cloneShallow(url: string, dest: string) {
  const proc = Bun.spawn(["git", "clone", "--depth", "1", "--quiet", "--", url, dest], {
    stdin: "ignore", stdout: "ignore", stderr: "pipe", timeout: 60_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  const [stderr, code] = await Promise.all([new Response(proc.stderr).text(), proc.exited]);
  if (code !== 0) throw new Error(proc.signalCode ? "git clone timed out" : stderr.trim() || `git clone exited with code ${code}`);
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

export const headCommit = (cwd: string, ref = "HEAD") => git(cwd, "rev-parse", "--verify", ref);

/** Read HEAD's full ref so a tag with the same name cannot change the branch name. */
export async function currentBranch(repo: string): Promise<string | null> {
  const result = await gitTry(repo, "symbolic-ref", "--quiet", "HEAD");
  if (result.code === 1) return null;
  if (result.code !== 0) throw new WorkspaceError("The project's current branch could not be read");
  return result.stdout.startsWith("refs/heads/") ? result.stdout.slice(11) : null;
}

/** Resolve an exact local branch, without accepting revision expressions or branch-history shortcuts. */
export async function localBranchCommit(repo: string, branch: string): Promise<string> {
  if (!branch || branch.startsWith("-") || branch.startsWith("refs/") || branch === "HEAD" || branch.length > 255
    || (await gitTry(repo, "check-ref-format", `refs/heads/${branch}`)).code !== 0) {
    throw new WorkspaceError("Choose an exact local branch name");
  }
  const result = await gitTry(repo, "show-ref", "--verify", "--hash", `refs/heads/${branch}`);
  if (result.code !== 0) throw new WorkspaceError("The target branch does not exist locally");
  return result.stdout;
}

export type PreviewMergeResult = {
  sourceCommit: string;
  targetBranch: string;
  targetCommit: string;
  status: "clean" | "conflicted" | "unsupported";
  conflicts: string[];
  message: string | null;
};

/** Computes only Git objects; the checkout, index, HEAD and branch refs stay untouched. */
export async function previewMerge(repo: string, sourceCommit: string, targetBranch: string): Promise<PreviewMergeResult> {
  if (sourceCommit.trim() !== sourceCommit || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i.test(sourceCommit)) throw new WorkspaceError("Merge previews need an exact source commit");
  const source = await gitTry(repo, "rev-parse", "--verify", `${sourceCommit}^{commit}`);
  if (source.code !== 0) throw new WorkspaceError("The source commit is unavailable locally");
  const targetCommit = await localBranchCommit(repo, targetBranch);
  const base = { sourceCommit: source.stdout, targetBranch, targetCommit };
  // A preview must not execute custom drivers supplied by repository or global Git configuration.
  const drivers = await gitTry(repo, "config", "--null", "--name-only", "--get-regexp", "^merge\\..*\\.driver$");
  if (drivers.code !== 0 && drivers.code !== 1) throw new WorkspaceError("Git merge driver configuration could not be read");
  const overrides = drivers.stdout.split("\0").filter(Boolean).flatMap((key) => ["-c", `${key}=false`]);
  const result = await gitTry(repo, "-c", "merge.renormalize=false", ...overrides, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", targetCommit, source.stdout);
  if (result.code === 0) return { ...base, status: "clean", conflicts: [], message: null };
  if (result.code === 1 && /^(?:[0-9a-f]{40}|[0-9a-f]{64})\0/i.test(result.stdout)) {
    const conflicts = [...new Set(result.stdout.split("\0").slice(1).filter(Boolean))];
    return { ...base, status: "conflicted", conflicts, message: overrides.length ? "Custom merge drivers are disabled for this preview." : null };
  }
  return { ...base, status: "unsupported", conflicts: [], message: "Git could not preview this merge. Git 2.38 or later and related branch histories are required." };
}

/** Git object ids make declared interface inputs comparable without reading the user's checkout. */
export async function fingerprintInputs(cwd: string, commit: string, paths: string[]): Promise<Record<string, string>> {
  const entries: [string, string][] = [];
  for (const path of paths) {
    if (!path || isAbsolute(path) || path.includes("\\") || path.includes("\0") || path.split("/").includes("..") || /[*?\[\]]/.test(path)) {
      throw new WorkspaceError("Interface inputs must be explicit paths relative to the project root");
    }
    const result = await gitTry(cwd, "rev-parse", "--verify", `${commit}:${path}`);
    entries.push([path, result.code === 0 ? result.stdout : "missing"]);
  }
  return Object.fromEntries(entries);
}

/** Authoritative, bounded context from Git objects; never follows a live project symlink. */
export async function describeInputs(cwd: string, commit: string, paths: string[]): Promise<string> {
  const fingerprints = await fingerprintInputs(cwd, commit, paths);
  const snapshots: string[] = [];
  let remaining = 24_000;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  for (const path of paths) {
    const object = fingerprints[path]!;
    let snapshot = `Input ${path}: ${object}\n`;
    if (object === "missing") snapshot += "This input does not exist at the accepted revision.\n";
    else {
      const kind = await gitTry(cwd, "cat-file", "-t", object);
      if (kind.code !== 0) {
        snapshot += "This Git object is unavailable locally; inspect the declared revision (it may be a submodule pointer).\n";
      } else {
        const type = kind.stdout;
        const command = `git ${type === "tree" ? "ls-tree" : "show"} ${quote(`${commit}:${path}`)}`;
        snapshot += `Read the exact accepted input with: ${command}\n`;
        const size = Number(await git(cwd, "cat-file", "-s", object));
        if ((type === "blob" || type === "tree") && size <= Math.min(4_000, remaining)) {
          // Preserve whitespace in source snapshots; the ordinary Git helper trims metadata output.
          const args = type === "tree" ? ["ls-tree", object] : ["cat-file", "blob", object];
          const proc = Bun.spawn(["git", ...args], { cwd, stdin: "ignore", stdout: "pipe", stderr: "ignore" });
          const [content, code] = await Promise.all([new Response(proc.stdout).text(), proc.exited]);
          if (code === 0 && !content.includes("\0")) snapshot += `${content.slice(0, 4_000)}\n`;
        }
      }
    }
    if (snapshot.length > remaining) { snapshots.push("Further input snapshots omitted; read the declared inputs from the accepted commit.\n"); break; }
    snapshots.push(snapshot);
    remaining -= snapshot.length;
  }
  return snapshots.join("\n");
}

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

/** Candidates and diagnostic probes never check out or advance the accepted run branch. */
export async function openDetachedWorktree(repo: string, path: string, commit: string) {
  await removeWorktree(repo, path);
  mkdirSync(join(path, ".."), { recursive: true });
  await git(repo, "worktree", "add", "--detach", path, commit);
}

export async function assertWorktreeRevision(cwd: string, commit: string) {
  if (await headCommit(cwd) !== commit || (await git(cwd, "status", "--porcelain", "--untracked-files=no"))) {
    throw new Error("Verification changed committed files or HEAD; the checked revision cannot be published");
  }
}

/** Only publishes the exact checked candidate, provided the accepted revision has not moved. */
export async function publishCandidate(integration: string, candidate: string, before: string, commit: string) {
  await assertWorktreeRevision(candidate, commit);
  await assertWorktreeRevision(integration, before);
  await git(integration, "merge", "--ff-only", "--no-edit", commit);
  if (await headCommit(integration) !== commit) throw new Error("Integration did not publish the checked revision");
}

export const branchExists = async (repo: string, branch: string) =>
  (await gitTry(repo, "rev-parse", "--verify", "--quiet", `refs/heads/${branch}`)).code === 0;

/** Unreferenced preview objects only: never stage, commit or merge in an agent's worktree. */
export async function snapshotPreview(repo: string, baseline: string, sources: string[], scratch: string) {
  if (!sources.length) return { commit: baseline, draft: false };
  mkdirSync(scratch, { recursive: true });
  const index = join(scratch, "index");
  const env = { ...process.env, GIT_INDEX_FILE: index };
  const run = async (cwd: string, args: string[], environment = env) => {
    const result = await gitWithEnv(cwd, args, environment);
    if (result.code !== 0) throw new Error(result.stderr || "Could not snapshot work in progress");
    return result.stdout;
  };
  // Stable metadata deduplicates identical snapshots instead of creating objects on every poll.
  const commitEnv = { ...env, GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z" };
  const commitTree = (tree: string, parents: string[]) => run(repo, [...IDENTITY, "commit-tree", tree, ...parents.flatMap((p) => ["-p", p]), "-m", "Orchestra live preview (unverified)"], commitEnv);
  const drivers = await gitTry(repo, "config", "--null", "--name-only", "--get-regexp", "^merge\\..*\\.driver$");
  if (drivers.code !== 0 && drivers.code !== 1) throw new Error("Could not read merge driver configuration");
  const overrides = drivers.stdout.split("\0").filter(Boolean).flatMap((key) => ["-c", `${key}=false`]);
  let commit = baseline;
  let tree = await git(repo, "rev-parse", `${baseline}^{tree}`);
  try {
    for (const cwd of sources) {
      try {
        const head = await headCommit(cwd);
        await run(cwd, ["read-tree", head]);
        await run(cwd, ["add", "-A", "--", ".", ...["node_modules", ".next", ".astro", ".env", ".env.*"].map((path) => `:(glob,exclude)**/${path}${path.startsWith(".env") ? "" : "/**"}`)]);
        const sourceTree = await run(cwd, ["write-tree"]);
        const source = await commitTree(sourceTree, [head]);
        const merged = await gitTry(repo, "-c", "merge.renormalize=false", ...overrides, "merge-tree", "--write-tree", "--name-only", "--no-messages", "-z", commit, source);
        if (merged.code !== 0) continue; // Conflicting drafts wait for checked integration.
        const nextTree = merged.stdout.split("\0")[0]!;
        if (nextTree === tree) continue;
        tree = nextTree;
        commit = await commitTree(tree, [commit, source]);
      } catch {
        // Tasks can finish and remove their worktrees while a snapshot is being captured.
      }
    }
    return { commit, draft: commit !== baseline };
  } finally {
    rmSync(index, { force: true });
    rmSync(`${index}.lock`, { force: true });
  }
}

/** Only used for Orchestra's private preview slots; never resets an integration or user worktree. */
export async function preparePreviewWorktree(repo: string, path: string, commit: string) {
  if (existsSync(path)) {
    await git(path, "reset", "--hard", commit);
    await git(path, "clean", "-fd", "-e", "node_modules/");
  } else {
    mkdirSync(join(path, ".."), { recursive: true });
    await git(repo, "worktree", "add", "--detach", path, commit);
  }
}

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
    // Candidates are nested so their basename remains `integration` for agent tooling.
    const listing = await git(repo, "worktree", "list", "--porcelain", "-z");
    const paths = listing.split("\0").filter((field) => field.startsWith("worktree ")).map((field) => field.slice(9));
    const runRoot = existsSync(worktreeDir) ? realpathSync(worktreeDir) : resolve(worktreeDir);
    for (const path of paths) if (path.startsWith(`${runRoot}/`)) await removeWorktree(repo, path);
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
