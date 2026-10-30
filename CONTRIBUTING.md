# Contributing

Orchestra is a Bun and TypeScript application with a React UI and SQLite storage. Start with the [README](README.md) for setup and [AGENTS.md](AGENTS.md) for module ownership, engineering conventions and safety invariants.

## Development

Use Bun 1.2.15 or newer, git and a shell with `sh` available. Install the committed dependency versions:

```sh
bun install --frozen-lockfile
bun run dev
```

The app opens at `http://127.0.0.1:4321`. To keep development data separate, set `ORCHESTRA_HOME` to a disposable directory and choose another `PORT` if needed. Development does not hot-restart the server: restart it after active runs have stopped so their processes are not orphaned.

Before submitting a change, run:

```sh
bun run typecheck
bun test
```

The regular tests use fake agent invocations and temporary Git repositories; they require no model account or paid calls. Keep tests isolated from `~/.orchestra`. Runtime smoke tests, autonomy demos, benchmarks with `--allow-paid`, and the UI's agent test make real provider calls. Run those only when explicitly intended, using scratch projects.

## Changes and review

Keep each pull request focused on a concrete user problem. Explain the resulting behavior and include the checks you ran. For visible UI changes, include desktop and narrow-screen screenshots and describe the interaction states checked.

Preserve Orchestra's Git boundary: generated work belongs in worktrees, and the user's checkout stays untouched. Keep API routes behind the existing request guard, use additive versioned migrations, and retain checked revisions and evidence when changing orchestration. Avoid new runtime dependencies when Bun or Node built-ins cover the task. Keep `@types/bun` aligned with the pinned Bun baseline.

Tests should exercise observable behavior and important failure paths. Update the README when setup, controls or supported behavior changes. Document a known limitation when a check cannot establish the claimed outcome.

## Bug reports

Include the Orchestra commit, operating system, Bun and Git versions, relevant agent CLI version and transport, reproduction steps, and expected versus observed behavior. A small project or fake-agent regression is especially useful for scheduling or recovery failures.

Share sanitized excerpts rather than an entire local database or run export: prompts, logs and configuration inventories can contain private project information. Report vulnerabilities using the guidance in [SECURITY.md](SECURITY.md).
