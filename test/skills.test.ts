import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureSkills, frontmatter, inspectSkillCompatibility, readSkill, searchSkills, SkillError, skillsPrompt } from "../src/server/skills.ts";

const dir = realpathSync(mkdtempSync(join(tmpdir(), "orchestra-skills-")));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("frontmatter", () => {
  test("reads plain, quoted, folded and literal values, ignoring nested keys", () => {
    expect(frontmatter("---\nname: tdd\ndescription: Test first.\n---\n# TDD")).toEqual({ name: "tdd", description: "Test first." });
    expect(frontmatter('---\nname: "review"\ndescription: "Say \\"since X\\": two axes."\n---')).toEqual({ name: "review", description: 'Say "since X": two axes.' });
    expect(frontmatter("---\nname: 'it''s'\n---").name).toBe("it's");
    expect(frontmatter("---\ndescription: >\n  One\n  line.\nname: a\n---").description).toBe("One line.");
    expect(frontmatter("---\ndescription: |-\n  Two\n  lines\n---").description).toBe("Two\nlines");
    expect(frontmatter("---\ndescription: Wrapped\n  plain value\n---").description).toBe("Wrapped plain value");
    expect(frontmatter("---\nmetadata:\n  name: nested\nname: top\n---").name).toBe("top");
    expect(frontmatter("# No frontmatter")).toEqual({});
  });
});

/** A repository laid out like the real ones: nested folders, a folder named unlike its skill, a symlinked copy. */
async function makeRepo() {
  const repo = join(dir, "repo");
  const skill = (path: string, md: string) => {
    mkdirSync(join(repo, path), { recursive: true });
    writeFileSync(join(repo, path, "SKILL.md"), md);
  };
  skill("skills/engineering/tdd", "---\nname: tdd\ndescription: Test-driven development.\n---\nRed, green.");
  writeFileSync(join(repo, "skills/engineering/tdd/mocking.md"), "Mock at boundaries.");
  skill("skills/react-best-practices", "---\nname: vercel-react-best-practices\ndescription: React performance rules.\n---");
  skill("skills/unnamed", "No frontmatter.");
  symlinkSync("/etc/hosts", join(repo, "skills/engineering/tdd/hosts"));
  symlinkSync("skills", join(repo, "mirror"));
  for (const args of [["init", "-q"], ["add", "-A"], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "skills"]]) {
    await Bun.spawn(["git", ...args], { cwd: repo }).exited;
  }
  return repo;
}

describe("ensureSkills", async () => {
  const repo = await makeRepo();
  const root = join(dir, "library");
  const clones: string[] = [];
  const repoUrl = (source: string) => {
    clones.push(source);
    return source === "o/r" ? repo : join(dir, "nowhere");
  };

  test("installs skills by frontmatter name or folder, with one clone per repository", async () => {
    const skills = await ensureSkills(["o/r/vercel-react-best-practices", "o/r/tdd", "o/r/unnamed"], { root, repoUrl });
    expect(skills.map(({ id, name, description }) => ({ id, name, description }))).toEqual([
      { id: "o/r/vercel-react-best-practices", name: "vercel-react-best-practices", description: "React performance rules." },
      { id: "o/r/tdd", name: "tdd", description: "Test-driven development." },
      { id: "o/r/unnamed", name: "unnamed", description: "" },
    ]);
    expect(clones).toEqual(["o/r"]);
    // The skill's other files come along; symlinks don't, so nothing outside the clone is copied.
    expect(readdirSync(join(root, "o/r/tdd")).sort()).toEqual([".orchestra-skill.json", "SKILL.md", "mocking.md"]);
    expect(skills[1]!.provenance).toMatchObject({ repository: "o/r", files: ["SKILL.md", "mocking.md"] });
    expect(skills[1]!.revision).toMatch(/^[a-f0-9]{40}$/);
    // Staging folders are cleaned up.
    expect(readdirSync(root)).toEqual(["o"]);
  });

  test("keeps installed skills as they are, without fetching again", async () => {
    clones.length = 0;
    expect((await ensureSkills(["o/r/tdd"], { root, repoUrl }))[0]!.name).toBe("tdd");
    expect(clones).toEqual([]);
  });

  test("fails clearly for unknown skills, unreachable repositories and invalid ids", async () => {
    await expect(ensureSkills(["o/r/nope"], { root, repoUrl })).rejects.toThrow("o/r has no skill named nope");
    await expect(ensureSkills(["x/y/z"], { root, repoUrl })).rejects.toThrow("Couldn't fetch x/y");
    await expect(ensureSkills(["../../etc"], { root, repoUrl })).rejects.toBeInstanceOf(SkillError);
    expect(existsSync(join(root, "o/r/nope"))).toBe(false);
    expect(readSkill("o/r/nope", root)).toBeNull();
  });
});

describe("searchSkills", () => {
  const respond = (body: unknown, status = 200) => (async () => Response.json(body, { status })) as unknown as typeof fetch;

  test("keeps only skills hosted in a GitHub-shaped repository", async () => {
    const skills = [
      { id: "o/r/tdd", name: "tdd", installs: 5, source: "o/r" },
      { id: "open.feishu.cn/lark", name: "lark", installs: 9 },
      { id: "gitlab.com/o/r/s", name: "s", installs: 1 },
    ];
    expect(await searchSkills("tdd", respond({ skills }))).toEqual([{ id: "o/r/tdd", name: "tdd", installs: 5 }]);
  });

  test("reports failures instead of an empty result", async () => {
    await expect(searchSkills("x", respond({ skills: [], error: "temporarily_unavailable" }))).rejects.toThrow("temporarily_unavailable");
    await expect(searchSkills("x", respond({}, 500))).rejects.toThrow("HTTP 500");
    await expect(searchSkills("x", respond({ nope: 1 }))).rejects.toThrow("unexpected response");
  });
});

test("the prompt lists each skill's description and where its SKILL.md is", () => {
  expect(skillsPrompt([])).toBe("");
  const prompt = skillsPrompt([{ id: "o/r/tdd", name: "tdd", description: "Test first." }], "/lib");
  expect(prompt).toContain("- tdd: Test first.\n  /lib/o/r/tdd/SKILL.md");
  expect(prompt).toContain("read its SKILL.md");
});

test("interactive and native-delegation playbooks retain useful procedures with explicit Orchestra adaptations", () => {
  const repo = join(dir, "workflow-repo");
  const skillDir = join(repo, "skills", "planning");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: planning\nallowed-tools: Read, AskUserQuestion, Task\ndisable-model-invocation: true\n---\nAsk the user about missing goals, one question at a time. Dispatch subagents. Run git commit before git worktree add.");
  const compatibility = inspectSkillCompatibility("owner/workflows", skillDir, repo);
  expect(compatibility.status).toBe("integration-required");
  expect(compatibility.requiredTools).toEqual(["Read", "AskUserQuestion", "Task"]);
  const notices = compatibility.notices.join("\n");
  for (const value of ["Interactive steps need adaptation", "Do not wait for a user interview or invent user approval", "disable-model-invocation entry point is not activated", "Native agent spawning is disabled", "Do not start subagents", "Orchestra owns commits"]) expect(notices).toContain(value);
  const prompt = skillsPrompt([{ id: "owner/workflows/planning", name: "planning", description: "Plan focused work.", revision: "pinned-source", compatibility }], join(dir, "absent-library"));
  for (const value of ["Source revision: pinned-source", "Declared tools (availability unverified): Read, AskUserQuestion, Task", "Use only skills relevant to this assignment", "Skip conflicting skill steps", "redundant microtask/document chains", "Report unavailable required tools"]) expect(prompt).toContain(value);
  const native = skillsPrompt([{ id: "owner/workflows/planning", name: "planning", description: "Plan focused work.", compatibility }], join(dir, "absent-library"), { orchestrated: false, nativeDelegation: true });
  expect(native).toContain("Native delegation is explicitly enabled for this invocation");
  expect(native).toContain("descendant calls and usage are not independently metered");
  expect(native).toContain("The calling harness owns commits");
  expect(native).not.toContain("Native agent spawning is disabled");
  expect(native).not.toContain("Orchestra owns planning");
  const stillOrchestrated = skillsPrompt([{ id: "owner/workflows/planning", name: "planning", description: "Plan focused work.", compatibility }], join(dir, "absent-library"), { nativeDelegation: true });
  expect(stillOrchestrated).toContain("Native agent spawning is disabled");
  const standaloneProfile = skillsPrompt([{ id: "owner/workflows/planning", name: "planning", description: "Plan focused work.", compatibility: { ...compatibility, notices: [...compatibility.notices, "Superpowers profile: Orchestra supplies planning, dispatch, worktrees and completion; its plugin startup bootstrap is not installed."] } }], join(dir, "absent-library"), { orchestrated: false, nativeDelegation: true });
  expect(standaloneProfile).not.toContain("Orchestra supplies planning");
  expect(standaloneProfile).toContain("invocation's rules govern planning and delegation");
});

test("self-contained skill procedures do not falsely require interactive integration", () => {
  const repo = join(dir, "focused-repo");
  const skillDir = join(repo, "skills", "testing");
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(join(skillDir, "SKILL.md"), "---\nname: testing\n---\nRun focused tests. Explain the outcome in the task handoff.");
  expect(inspectSkillCompatibility("owner/focused", skillDir, repo)).toMatchObject({ status: "instructions", notices: [], requiredTools: [] });
});
