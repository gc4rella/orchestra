import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureArtifacts, missingArtifacts, restoreArtifacts } from "../src/server/artifacts.ts";

const root = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-restore-artifacts-")));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let sequence = 0;
function fixture() {
  const dir = join(root, String(sequence++));
  const source = join(dir, "source"), target = join(dir, "target"), archive = join(dir, "archive");
  mkdirSync(join(source, "evidence"), { recursive: true });
  mkdirSync(target, { recursive: true });
  writeFileSync(join(source, "evidence", "desktop.png"), "retained image fixture");
  const captured = captureArtifacts(source, ["evidence/desktop.png"], archive);
  return { source, target, archive, references: captured.artifacts, path: "evidence/desktop.png" };
}

test("restores absent retained files and leaves matching or changed existing files untouched", () => {
  const f = fixture();
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set())).toEqual({ restored: [f.path], missing: [] });
  expect(readFileSync(join(f.target, f.path), "utf8")).toBe("retained image fixture");
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set())).toEqual({ restored: [], missing: [] });
  writeFileSync(join(f.target, f.path), "existing project content");
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set())).toEqual({ restored: [], missing: [f.path] });
  expect(readFileSync(join(f.target, f.path), "utf8")).toBe("existing project content");
});

test("never recreates missing tracked files or substitutes unrelated or absent archive references", () => {
  const f = fixture();
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set([f.path])).missing).toEqual([f.path]);
  expect(existsSync(join(f.target, f.path))).toBe(false);
  expect(restoreArtifacts(f.target, [f.path], f.archive, ["receipt/unrelated.png"], new Set()).missing).toEqual([f.path]);
  unlinkSync(join(f.archive, f.references[0]!));
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set()).missing).toEqual([f.path]);
  expect(existsSync(join(f.target, f.path))).toBe(false);
});

test("capture and restoration reject symlink leaves and parent components on both sides", () => {
  const f = fixture();
  symlinkSync(join(f.source, "evidence"), join(f.source, "alias"));
  expect(captureArtifacts(f.source, ["alias/desktop.png"], f.archive).missing).toEqual(["alias/desktop.png"]);
  symlinkSync(join(f.source, "evidence", "desktop.png"), join(f.source, "leaf.png"));
  expect(captureArtifacts(f.source, ["leaf.png"], f.archive).missing).toEqual(["leaf.png"]);
  const outside = join(f.source, "outside");
  mkdirSync(outside);
  symlinkSync(outside, join(f.target, "evidence"));
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set()).missing).toEqual([f.path]);
  expect(existsSync(join(outside, "desktop.png"))).toBe(false);
  unlinkSync(join(f.target, "evidence"));
  mkdirSync(join(f.target, "evidence"));
  symlinkSync(join(outside, "missing.png"), join(f.target, f.path));
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set()).missing).toEqual([f.path]);
  expect(existsSync(join(outside, "missing.png"))).toBe(false);
  unlinkSync(join(f.target, f.path));
  const archived = join(f.archive, f.references[0]!);
  unlinkSync(archived);
  symlinkSync(join(f.source, f.path), archived);
  expect(restoreArtifacts(f.target, [f.path], f.archive, f.references, new Set()).missing).toEqual([f.path]);
  symlinkSync(f.source, join(f.archive, "linked-receipt"));
  expect(restoreArtifacts(f.target, [f.path], f.archive, [`linked-receipt/${f.path}`], new Set()).missing).toEqual([f.path]);
  expect(existsSync(join(f.target, f.path))).toBe(false);
});

test("restoration retains per-file and total byte limits and rejects path escapes", () => {
  const f = fixture();
  const receipt = join(f.archive, "bounds");
  mkdirSync(receipt);
  writeFileSync(join(receipt, "large.bin"), new Uint8Array(5 * 1024 * 1024 + 1));
  expect(restoreArtifacts(f.target, ["large.bin"], f.archive, ["bounds/large.bin"], new Set()).missing).toEqual(["large.bin"]);
  const paths = Array.from({ length: 5 }, (_, index) => `part-${index}.bin`);
  for (const path of paths) writeFileSync(join(receipt, path), new Uint8Array(5 * 1024 * 1024));
  expect(restoreArtifacts(f.target, paths, f.archive, paths.map((path) => `bounds/${path}`), new Set())).toEqual({ restored: paths.slice(0, 4), missing: [paths[4]!] });
  expect(missingArtifacts(f.target, paths)).toEqual([paths[4]!]);
  expect(restoreArtifacts(f.target, ["../escape"], f.archive, ["receipt/../escape"], new Set()).missing).toEqual(["../escape"]);
});
