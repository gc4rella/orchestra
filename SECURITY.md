# Security

## Local trust boundary

Orchestra binds to `127.0.0.1` and validates loopback hosts, supplied browser origins and JSON mutation requests. It has no user authentication. Local processes and users that can access the API can control runs and reveal saved secrets. Keep its port local.

Agent workers run unattended: Claude Code uses `bypassPermissions`; Codex uses its workspace-write sandbox with network access. Director and reviewer calls use the CLI's read-only mode or tool restrictions. Verification and preview commands execute with the user's privileges through a shell. Marketplace skills are third-party instructions. Use projects, commands and skill sources you trust; worktree isolation and scheduling claims do not restrict shell permissions.

Project secrets are encrypted with a local key stored beside the database. The key and database are both sensitive; back up both to retain access. Run exports, prompts, logs and evidence can contain private source, paths or project information even when saved secret values are excluded. Review and sanitize material before sharing it.

## Reporting a vulnerability

Please keep exploit details and sensitive logs out of public issues and pull requests.

If this repository's **Security** tab offers **Report a vulnerability**, use that private form. If a private report option is unavailable, open an issue asking for a private reporting channel, with no exploit details or sensitive attachments, and wait for a maintainer to establish one.

In a private report, include the affected commit, operating system and relevant runtime versions, a minimal reproduction, the expected trust boundary and observed impact. Use dummy credentials and a scratch project. In particular, unexpected secret disclosure, cross-origin control or changes to the user's checkout are useful to distinguish from the intentionally privileged execution described above.

This document does not promise a response time or a release support schedule. Include the commit you tested so a report can be reproduced against the same code.
