import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  abortMerge, addWorktree, commitAll, concludeMerge, currentBranch, diffFiles, diffText, headCommit, inspectWorkspace, listFolders, localBranchCommit, mergeBranch,
  openWorktree, parseDiff, prepareWorkspace, previewMerge, removeWorktree, taskMergeCommit, WorkspaceError,
} from "../src/server/git.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-git-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const sh = (cwd: string, ...cmd: string[]) => {
  const r = Bun.spawnSync(cmd, { cwd, stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`${cmd.join(" ")}: ${r.stderr}`);
  return r.stdout.toString().trim();
};

describe("local merge previews", () => {
  const repo = join(root, "merge-preview");
  const unusual = ["café.txt", "space name.txt", 'quote"name.txt', "tab\tname.txt", "line\nname.txt", " final space "];
  let source: string;
  let target: string;
  let base: string;
  beforeAll(async () => {
    await prepareWorkspace(repo);
    for (const name of [...unusual, "dirty.txt"]) writeFileSync(join(repo, name), "base\n");
    await commitAll(repo, "base files");
    base = await headCommit(repo);
    sh(repo, "git", "checkout", "-qb", "orchestra/preview");
    for (const name of unusual) writeFileSync(join(repo, name), "source\n");
    await commitAll(repo, "run work");
    source = await headCommit(repo);
    sh(repo, "git", "checkout", "-q", "main");
    for (const name of unusual) writeFileSync(join(repo, name), "target\n");
    await commitAll(repo, "target changes");
    target = await headCommit(repo);
    writeFileSync(join(repo, "dirty.txt"), "staged edits\n");
    sh(repo, "git", "add", "dirty.txt");
    writeFileSync(join(repo, "dirty.txt"), "unstaged edits\n");
    writeFileSync(join(repo, "untracked.txt"), "keep me\n");
    sh(repo, "git", "branch", "clean-target", base);
  });

  const snapshot = () => ({
    head: sh(repo, "git", "rev-parse", "HEAD"),
    branch: sh(repo, "git", "symbolic-ref", "HEAD"),
    refs: sh(repo, "git", "show-ref"),
    index: readFileSync(join(repo, ".git", "index")).toString("base64"),
    dirty: readFileSync(join(repo, "dirty.txt"), "utf8"),
    untracked: readFileSync(join(repo, "untracked.txt"), "utf8"),
    files: unusual.map((name) => readFileSync(join(repo, name), "utf8")),
    mergeHead: existsSync(join(repo, ".git", "MERGE_HEAD")),
  });

  test("pins exact revisions and leaves the user's checkout, staged index and refs unchanged", async () => {
    const before = snapshot();
    expect(await currentBranch(repo)).toBe("main");
    expect(await localBranchCommit(repo, "orchestra/preview")).toBe(source);
    expect(await previewMerge(repo, source, "clean-target")).toEqual({ sourceCommit: source, targetBranch: "clean-target", targetCommit: base, status: "clean", conflicts: [], message: null });
    expect(snapshot()).toEqual(before);
    const result = await previewMerge(repo, source, "main");
    expect(result).toMatchObject({ sourceCommit: source, targetBranch: "main", targetCommit: target, status: "conflicted", message: null });
    expect(result.conflicts.sort()).toEqual([...unusual].sort());
    expect(snapshot()).toEqual(before);
    // A later branch update cannot change the source commit used in the preview.
    sh(repo, "git", "update-ref", "refs/heads/orchestra/preview", base);
    expect((await previewMerge(repo, source, "main")).status).toBe("conflicted");
    sh(repo, "git", "update-ref", "refs/heads/orchestra/preview", source);
  });

  test("rejects expressions, flags, shortcuts and absent local targets", async () => {
    const before = snapshot();
    for (const name of ["", "-main", "--all", "HEAD", "main~1", "main^", "@{-1}", "refs/heads/main", "main:dirty.txt", "main\n", "main..other"]) {
      await expect(localBranchCommit(repo, name)).rejects.toThrow("exact local branch");
    }
    await expect(localBranchCommit(repo, "absent")).rejects.toThrow("does not exist locally");
    await expect(previewMerge(repo, "HEAD", "main")).rejects.toThrow("exact source commit");
    await expect(previewMerge(repo, "0".repeat(40), "main")).rejects.toThrow("unavailable locally");
    expect(snapshot()).toEqual(before);
  });

  test("reads exact checked-out branches even when a tag has the same name, and detects detached HEAD", async () => {
    const detached = join(root, "preview-detached");
    await prepareWorkspace(detached);
    sh(detached, "git", "tag", "main");
    expect(await currentBranch(detached)).toBe("main");
    sh(detached, "git", "checkout", "--detach", "-q", "HEAD");
    expect(await currentBranch(detached)).toBeNull();
  });

  test("never invokes configured external merge drivers or normalization filters", async () => {
    const driverRepo = join(root, "preview-driver");
    await prepareWorkspace(driverRepo);
    writeFileSync(join(driverRepo, ".gitattributes"), "file.txt merge=unsafe filter=unsafe\n");
    writeFileSync(join(driverRepo, "file.txt"), "base\n");
    await commitAll(driverRepo, "base");
    sh(driverRepo, "git", "checkout", "-qb", "source");
    writeFileSync(join(driverRepo, "file.txt"), "source\n");
    await commitAll(driverRepo, "source");
    const sourceCommit = await headCommit(driverRepo);
    sh(driverRepo, "git", "checkout", "-q", "main");
    writeFileSync(join(driverRepo, "file.txt"), "target\n");
    await commitAll(driverRepo, "target");
    sh(driverRepo, "git", "config", "merge.unsafe.driver", "touch driver-executed; true");
    sh(driverRepo, "git", "config", "merge.renormalize", "true");
    sh(driverRepo, "git", "config", "filter.unsafe.clean", "touch filter-executed; cat");
    sh(driverRepo, "git", "config", "filter.unsafe.smudge", "touch filter-executed; cat");
    const result = await previewMerge(driverRepo, sourceCommit, "main");
    expect(result).toMatchObject({ status: "conflicted", conflicts: ["file.txt"], message: expect.stringContaining("disabled") });
    expect(existsSync(join(driverRepo, "driver-executed"))).toBe(false);
    expect(existsSync(join(driverRepo, "filter-executed"))).toBe(false);
  });

  test("reports unsupported Git without touching the checkout", async () => {
    const before = snapshot();
    const bin = join(root, "old-git-bin");
    mkdirSync(bin);
    const gitPath = Bun.which("git")!;
    writeFileSync(join(bin, "git"), `#!/bin/sh\nfor arg do\n  if [ "$arg" = merge-tree ]; then exit 129; fi\ndone\nexec '${gitPath.replaceAll("'", "'\\''")}' "$@"\n`, { mode: 0o755 });
    const module = pathToFileURL(join(import.meta.dir, "../src/server/git.ts")).href;
    const script = `import { previewMerge } from ${JSON.stringify(module)}; console.log(JSON.stringify(await previewMerge(${JSON.stringify(repo)}, ${JSON.stringify(source)}, "main")));`;
    const child = Bun.spawnSync([process.execPath, "--eval", script], { cwd: repo, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ""}` }, stderr: "pipe" });
    expect(child.exitCode).toBe(0);
    expect(JSON.parse(child.stdout.toString())).toMatchObject({ sourceCommit: source, targetBranch: "main", targetCommit: target, status: "unsupported", conflicts: [], message: expect.stringContaining("Git 2.38") });
    expect(snapshot()).toEqual(before);
  });
});

describe("prepareWorkspace", () => {
  test("creates a repo with an initial commit for a missing dir", async () => {
    const dir = join(root, "fresh", "app");
    const { baseCommit, warning } = await prepareWorkspace(dir);
    expect(baseCommit).toBe(sh(dir, "git", "rev-parse", "HEAD"));
    expect(warning).toBeNull();
  });

  test("uses HEAD of an existing repo and warns about uncommitted changes", async () => {
    const dir = join(root, "existing");
    mkdirSync(dir);
    sh(dir, "git", "init", "-q");
    writeFileSync(join(dir, "a.txt"), "a");
    sh(dir, "git", "add", ".");
    sh(dir, "git", "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "a");
    expect((await prepareWorkspace(dir)).warning).toBeNull();
    writeFileSync(join(dir, "b.txt"), "dirty");
    const { baseCommit, warning } = await prepareWorkspace(dir);
    expect(baseCommit).toBe(sh(dir, "git", "rev-parse", "HEAD"));
    expect(warning).toContain("Uncommitted");
  });

  test("refuses a non-empty dir that is not a repo, relative paths and subdirs of repos", async () => {
    const dir = join(root, "plain");
    mkdirSync(dir);
    writeFileSync(join(dir, "x"), "x");
    await expect(prepareWorkspace(dir)).rejects.toThrow(WorkspaceError);
    await expect(prepareWorkspace("relative/path")).rejects.toThrow("absolute");
    const sub = join(root, "existing", "sub");
    mkdirSync(sub);
    writeFileSync(join(sub, "y"), "y");
    await expect(prepareWorkspace(sub)).rejects.toThrow("use its root");
  });
});

describe("inspectWorkspace", () => {
  test("is read-only and reports what a run would do", async () => {
    const missing = join(root, "inspect", "missing");
    expect(await inspectWorkspace(missing)).toEqual({ kind: "new" });
    expect(Bun.spawnSync(["test", "-e", missing]).exitCode).not.toBe(0); // nothing created

    const empty = join(root, "inspect", "empty");
    mkdirSync(empty, { recursive: true });
    writeFileSync(join(empty, ".DS_Store"), "");
    expect(await inspectWorkspace(empty)).toEqual({ kind: "empty" });

    const repo = join(root, "existing"); // from the prepareWorkspace tests: untracked b.txt and sub/
    const check = await inspectWorkspace(repo);
    expect(check).toMatchObject({ kind: "repo", head: sh(repo, "git", "rev-parse", "HEAD"), dirty: 2 });
  });

  test("explains unusable paths and suggests the repo root", async () => {
    expect(await inspectWorkspace("relative")).toMatchObject({ kind: "invalid", reason: expect.stringContaining("absolute") });
    expect(await inspectWorkspace(join(root, "plain", "x"))).toMatchObject({ kind: "invalid", reason: expect.stringContaining("not a directory") });
    const sub = await inspectWorkspace(join(root, "existing", "sub"));
    expect(sub).toMatchObject({ kind: "invalid", root: join(root, "existing") });
  });
});

describe("listFolders", () => {
  test("lists visible subfolders sorted, marks repos, skips files", () => {
    const base = join(root, "browse");
    for (const d of ["beta", "Alpha", ".hidden", "repo/.git"]) mkdirSync(join(base, d), { recursive: true });
    writeFileSync(join(base, "file.txt"), "x");
    const listing = listFolders(base + "/");
    expect(listing.path).toBe(base);
    expect(listing.parent).toBe(root);
    expect(listing.folders).toEqual([
      { name: "Alpha", path: join(base, "Alpha"), repo: false },
      { name: "beta", path: join(base, "beta"), repo: false },
      { name: "repo", path: join(base, "repo"), repo: true },
    ]);
    expect(listFolders("/").parent).toBeNull();
  });
  test("rejects relative or unreadable paths", () => {
    expect(() => listFolders("relative")).toThrow(WorkspaceError);
    expect(() => listFolders(join(root, "nope"))).toThrow("Can't open");
  });
});

describe("worktrees and merging", () => {
  const repo = join(root, "merge-repo");
  const integration = join(root, "wt", "integration");
  beforeAll(async () => {
    const { baseCommit } = await prepareWorkspace(repo);
    await addWorktree(repo, integration, "orchestra/r1", baseCommit);
  });

  const taskBranch = async (key: string, file: string, content: string) => {
    const path = join(root, "wt", key);
    await addWorktree(repo, path, `orchestra/r1-${key}`, await headCommit(integration));
    writeFileSync(join(path, file), content);
    expect(await commitAll(path, key)).toBe(true);
    return `orchestra/r1-${key}`;
  };

  test("clean merge lands on the integration branch, user's checkout untouched", async () => {
    const userHead = sh(repo, "git", "rev-parse", "HEAD");
    const start = await headCommit(integration);
    const branch = await taskBranch("a", "a.txt", "from a");
    expect(await mergeBranch(integration, branch, "merge a")).toEqual({ conflicts: [] });
    expect(await taskMergeCommit(integration, start, "merge a")).toBe(await headCommit(integration));
    expect(await taskMergeCommit(integration, start, "missing")).toBeNull();
    expect(await mergeBranch(integration, branch, "merge a")).toEqual({ conflicts: [] });
    expect(await taskMergeCommit(integration, start, "merge a")).toBe(await headCommit(integration));
    expect(sh(repo, "git", "show", "orchestra/r1:a.txt")).toBe("from a");
    expect(sh(repo, "git", "rev-parse", "HEAD")).toBe(userHead);
    expect(sh(repo, "git", "branch", "--show-current")).toBe("main");
  });

  test("commitAll reports when there is nothing to commit", async () => {
    const path = join(root, "wt", "noop");
    await addWorktree(repo, path, "orchestra/r1-noop", await headCommit(integration));
    expect(await commitAll(path, "noop")).toBe(false);
  });

  test("conflicts are reported, unresolved markers are refused, resolution completes the merge", async () => {
    const b = await taskBranch("b", "shared.txt", "from b\n");
    const c = await taskBranch("c", "shared.txt", "from c\n");
    expect(await mergeBranch(integration, b, "merge b")).toEqual({ conflicts: [] });
    expect(await mergeBranch(integration, c, "merge c")).toEqual({ conflicts: ["shared.txt"] });

    expect(await concludeMerge(integration, ["shared.txt"])).toBe(false); // markers still there
    writeFileSync(join(integration, "shared.txt"), "from b and c\n");
    expect(await concludeMerge(integration, ["shared.txt"])).toBe(true);
    expect(sh(repo, "git", "show", "orchestra/r1:shared.txt")).toBe("from b and c");
  });

  test("abortMerge restores the integration branch", async () => {
    const d = await taskBranch("d", "shared.txt", "from d\n");
    writeFileSync(join(integration, "shared.txt"), "meanwhile on integration\n");
    await commitAll(integration, "diverge");
    const before = await headCommit(integration);
    expect((await mergeBranch(integration, d, "merge d")).conflicts).toEqual(["shared.txt"]);
    await abortMerge(integration);
    expect(await headCommit(integration)).toBe(before);
    expect(sh(integration, "git", "status", "--porcelain")).toBe("");
  });
});

describe("diffs", () => {
  test("diff paths preserve Unicode, spaces and Git-quoted control characters", async () => {
    const repo = join(root, "quoted-diffs");
    const { baseCommit } = await prepareWorkspace(repo);
    const names = ["café.txt", "space name.txt", 'quote"name.txt', "tab\tname.txt", "line\nname.txt"];
    for (const name of names) writeFileSync(join(repo, name), "hello\n");
    await commitAll(repo, "quoted names");
    const files = await diffFiles(repo, baseCommit, "HEAD");
    expect(files.map((f) => f.path).sort()).toEqual([...names].sort());
    for (const file of files) expect(file).toMatchObject({ status: "added", additions: 1, patch: "@@ -0,0 +1 @@\n+hello" });
  });

  test("lists added, modified, deleted and renamed files with their hunks", async () => {
    const repo = join(root, "diffs");
    const { baseCommit } = await prepareWorkspace(repo);
    writeFileSync(join(repo, "keep.txt"), "one\ntwo\n");
    writeFileSync(join(repo, "gone.txt"), "bye\n");
    writeFileSync(join(repo, "old-name.txt"), "a long enough line so git sees a rename\n".repeat(5));
    await commitAll(repo, "base");
    const from = await headCommit(repo);
    writeFileSync(join(repo, "keep.txt"), "one\n2\n");
    rmSync(join(repo, "gone.txt"));
    sh(repo, "git", "mv", "old-name.txt", "new-name.txt");
    writeFileSync(join(repo, "new.txt"), "hello\n");
    await commitAll(repo, "change");

    const files = await diffFiles(repo, from, "HEAD");
    const by = Object.fromEntries(files.map((f) => [f.path, f]));
    expect(by["keep.txt"]).toMatchObject({ status: "modified", additions: 1, deletions: 1, truncated: false });
    expect(by["keep.txt"]!.patch).toStartWith("@@ -1,2 +1,2 @@");
    expect(by["gone.txt"]).toMatchObject({ status: "deleted", additions: 0, deletions: 1 });
    expect(by["new-name.txt"]).toMatchObject({ status: "renamed", oldPath: "old-name.txt", patch: "" });
    expect(by["new.txt"]).toMatchObject({ status: "added", additions: 1, oldPath: null });
    expect(await diffFiles(repo, baseCommit, baseCommit)).toEqual([]);
    expect(await diffText(repo, from)).toContain("+2");
    expect(await diffText(repo, from, 10)).toContain("diff clipped at 10 characters");
  });

  test("marks binary files and truncates huge patches", () => {
    const binary = parseDiff("diff --git a/x.png b/x.png\nindex 1..2 100644\nBinary files a/x.png and b/x.png differ\n");
    expect(binary[0]).toMatchObject({ path: "x.png", binary: true, patch: "" });
    const big = parseDiff(`diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -0,0 +1,30000 @@\n${"+line of text\n".repeat(30_000)}`);
    expect(big[0]!.truncated).toBe(true);
    expect(big[0]!.patch.length).toBeLessThanOrEqual(100_000);
    expect(big[0]!.additions).toBe(30_000);
  });

  test("quoted binary and pure-rename headers preserve their filenames", async () => {
    const repo = join(root, "quoted-headers");
    await prepareWorkspace(repo);
    const oldPath = 'old café".txt';
    const newPath = 'new café".txt';
    writeFileSync(join(repo, oldPath), "unchanged\n");
    await commitAll(repo, "base");
    const from = await headCommit(repo);
    sh(repo, "git", "mv", oldPath, newPath);
    writeFileSync(join(repo, "café.bin"), Buffer.from([0, 1, 2, 3]));
    await commitAll(repo, "binary and rename");
    const by = Object.fromEntries((await diffFiles(repo, from, "HEAD")).map((f) => [f.path, f]));
    expect(by[newPath]).toMatchObject({ status: "renamed", oldPath, patch: "" });
    expect(by["café.bin"]).toMatchObject({ status: "added", binary: true, patch: "" });
  });

  test("openWorktree checks out an existing branch again", async () => {
    const repo = join(root, "reopen");
    const { baseCommit } = await prepareWorkspace(repo);
    const wt = join(root, "reopen-wt");
    await addWorktree(repo, wt, "orchestra/r", baseCommit);
    writeFileSync(join(wt, "a.txt"), "a");
    await commitAll(wt, "a");
    await removeWorktree(repo, wt);
    await openWorktree(repo, wt, "orchestra/r");
    expect(sh(wt, "git", "branch", "--show-current")).toBe("orchestra/r");
    expect(sh(wt, "cat", "a.txt")).toBe("a");
  });
});
