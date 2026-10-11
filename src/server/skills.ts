import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, renameSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import { z } from "zod";
import type { Skill, SkillListing } from "../shared/types.ts";
import { orchestraHome } from "./db.ts";
import { cloneShallow } from "./git.ts";

/**
 * Agents get marketplace skills (skills.sh) from Orchestra's own library, `$ORCHESTRA_HOME/skills/<owner>/<repo>/<skill>/`,
 * rather than from the CLIs' skill folders: those are per runtime and per user, and a copy in the worktree would be
 * committed with the agent's work. The prompt lists each skill and its SKILL.md, which the agent reads when it applies.
 */
export const skillsRoot = () => join(orchestraHome(), "skills");

/** `owner/repo/skill` with GitHub-shaped segments; each starts alphanumeric, so none is `.`, `..` or a flag. */
export const SKILL_ID = /^[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*\/[A-Za-z0-9][\w.-]*$/;

/** A skill folder bigger than this is not instructions any more. */
const MAX_FILES = 500;
const MAX_BYTES = 10 * 1024 * 1024;

export class SkillError extends Error {}

const SearchResponse = z.object({
  skills: z.array(z.object({ id: z.string(), name: z.string(), installs: z.number() })),
  error: z.string().optional(),
});

/** Searches skills.sh. Only skills hosted in a GitHub repository (`owner/repo/skill`) can be installed, so others are left out. */
export async function searchSkills(query: string, fetchImpl: typeof fetch = fetch): Promise<SkillListing[]> {
  let res: Response;
  try {
    res = await fetchImpl(`https://skills.sh/api/search?q=${encodeURIComponent(query)}&limit=20`, { signal: AbortSignal.timeout(10_000) });
  } catch (e) {
    throw new SkillError(`Couldn't reach skills.sh: ${(e as Error).message}`);
  }
  if (!res.ok) throw new SkillError(`skills.sh search failed (HTTP ${res.status})`);
  const parsed = SearchResponse.safeParse(await res.json().catch(() => null));
  if (!parsed.success) throw new SkillError("skills.sh returned an unexpected response");
  // It can answer 200 with no results and an error, e.g. "temporarily_unavailable".
  if (parsed.data.error) throw new SkillError(`skills.sh search failed: ${parsed.data.error}`);
  return parsed.data.skills.filter((s) => SKILL_ID.test(s.id)).map(({ id, name, installs }) => ({ id, name, installs }));
}

/** `name` and `description` from a SKILL.md's YAML frontmatter: plain, quoted, folded and literal scalars. */
export function frontmatter(md: string): { name?: string; description?: string } {
  const block = /^---\r?\n([\s\S]*?)\r?\n---/.exec(md)?.[1];
  if (!block) return {};
  const lines = block.split(/\r?\n/);
  const out: { name?: string; description?: string } = {};
  for (let i = 0; i < lines.length; i++) {
    const kv = /^(name|description):\s*(.*)$/.exec(lines[i]!);
    if (!kv) continue;
    let value = kv[2]!.trim();
    // Indented lines continue the value: a block scalar's body or a wrapped plain scalar.
    const more: string[] = [];
    while (i + 1 < lines.length && (/^\s+\S/.test(lines[i + 1]!) || (!lines[i + 1]!.trim() && /^[>|]/.test(value)))) more.push(lines[++i]!.trim());
    if (/^[>|][+-]?$/.test(value)) value = more.join(value.startsWith("|") ? "\n" : " ");
    else {
      value = [value, ...more].join(" ");
      if (value.startsWith('"')) {
        try { value = JSON.parse(value) as string; } catch { value = value.slice(1, -1); }
      } else if (value.startsWith("'")) value = value.slice(1, -1).replaceAll("''", "'");
    }
    out[kv[1] as "name" | "description"] = value.trim();
  }
  return out;
}

/** Reads an installed skill, or null when it isn't in the library. */
export function readSkill(id: string, root = skillsRoot()): Skill | null {
  const file = join(root, id, "SKILL.md");
  if (!existsSync(file)) return null;
  const fm = frontmatter(readFileSync(file, "utf8"));
  return { id, name: (fm.name || id.split("/").at(-1)!).slice(0, 100), description: (fm.description ?? "").slice(0, 1024) };
}

/** Skill folders by frontmatter name, falling back to folder name. Symlinks are never followed, so nothing leaves the clone. */
function findSkills(repo: string) {
  const byName = new Map<string, string>();
  const byFolder = new Map<string, string>();
  const walk = (dir: string, depth: number) => {
    const entries = readdirSync(dir, { withFileTypes: true });
    if (entries.some((e) => e.isFile() && e.name === "SKILL.md")) {
      const name = frontmatter(readFileSync(join(dir, "SKILL.md"), "utf8")).name;
      if (name && !byName.has(name)) byName.set(name, dir);
      const folder = dir.split("/").at(-1)!;
      if (!byFolder.has(folder)) byFolder.set(folder, dir);
    }
    if (depth < 6) {
      for (const e of entries) if (e.isDirectory() && e.name !== ".git" && e.name !== "node_modules") walk(join(dir, e.name), depth + 1);
    }
  };
  walk(repo, 0);
  return (skill: string) => byName.get(skill) ?? byFolder.get(skill);
}

function assertSize(dir: string, id: string) {
  let files = 0;
  let bytes = 0;
  const walk = (d: string) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      if (e.isDirectory()) walk(join(d, e.name));
      else if (e.isFile()) { files++; bytes += lstatSync(join(d, e.name)).size; }
    }
  };
  walk(dir);
  if (files > MAX_FILES || bytes > MAX_BYTES) throw new SkillError(`${id} is too large to install (${files} files, ${Math.round(bytes / 1024)} KB)`);
}

/** Copies the named skills out of one shallow clone of `source` into the library. */
async function install(source: string, skills: string[], root: string, repoUrl: (source: string) => string) {
  mkdirSync(root, { recursive: true });
  // Staged inside the library so the final rename stays on one filesystem.
  const tmp = mkdtempSync(join(root, ".install-"));
  try {
    try {
      await cloneShallow(repoUrl(source), join(tmp, "repo"));
    } catch (e) {
      throw new SkillError(`Couldn't fetch ${source}: ${(e as Error).message}`);
    }
    const find = findSkills(join(tmp, "repo"));
    for (const skill of skills) {
      const id = `${source}/${skill}`;
      const dir = find(skill);
      if (!dir) throw new SkillError(`${source} has no skill named ${skill}`);
      assertSize(dir, id);
      const staged = join(tmp, `skill-${skill}`);
      cpSync(dir, staged, { recursive: true, filter: (src) => !lstatSync(src).isSymbolicLink() });
      const dest = join(root, id);
      mkdirSync(dirname(dest), { recursive: true });
      // A concurrent save may have installed it first; either copy is the same skill.
      try { renameSync(staged, dest); } catch (e) { if (!existsSync(join(dest, "SKILL.md"))) throw e; }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/**
 * Resolves skill ids to installed skills, in order, fetching the missing ones (one clone per repository).
 * Installed skills are kept as they are; a third party's later changes never reach agents unasked.
 */
export async function ensureSkills(
  ids: string[],
  opts: { root?: string; repoUrl?: (source: string) => string } = {},
): Promise<Skill[]> {
  const root = opts.root ?? skillsRoot();
  const repoUrl = opts.repoUrl ?? ((source: string) => `https://github.com/${source}.git`);
  const bad = ids.find((id) => !SKILL_ID.test(id));
  if (bad) throw new SkillError(`Invalid skill id: ${bad}`);
  const missing = new Map<string, string[]>();
  for (const id of ids) {
    if (readSkill(id, root)) continue;
    const [owner, repo, skill] = id.split("/") as [string, string, string];
    const source = `${owner}/${repo}`;
    missing.set(source, [...(missing.get(source) ?? []), skill]);
  }
  await Promise.all([...missing].map(([source, skills]) => install(source, skills, root, repoUrl)));
  return ids.map((id) => readSkill(id, root)!);
}

/** The prompt section that hands an agent its skills, the way the CLIs offer their own: a description up front, the body on demand. */
export function skillsPrompt(skills: Skill[], root = skillsRoot()) {
  if (!skills.length) return "";
  const list = skills.map((s) => `- ${s.name}: ${s.description || "(no description)"}\n  ${join(root, s.id, "SKILL.md")}`).join("\n");
  return `
## Your skills
Each skill is a folder of expert instructions, sometimes with scripts and references. When one applies to your work, read its SKILL.md before you start and follow it; it may point to other files in its folder. Your task, the plan and the rules below take precedence over a skill.
${list}
`;
}
