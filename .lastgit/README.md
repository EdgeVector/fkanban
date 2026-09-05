# Venue - fkanban (Forgejo gate of record, GitHub = public mirror)

| Role | Location |
|------|----------|
| SoT / PR / CI / merge | `http://localhost:3300/EdgeVector/fkanban` (Forgejo, since 2026-09-05) |
| LastGit repo | `lastdb:///fkanban` — DISABLED: no CRs, no pushes |
| Host-track artifact | published by the Forge CI `publish` job into `~/.lastgit/artifacts`, promoted with `lastgit artifact promote --gate forgejo` |
| Public mirror | `https://github.com/EdgeVector/fkanban` (read-only; fed from Forgejo by the mirror supervisor) |

## Workflow

1. Agents open PRs on Forgejo (`last-stack-pr-venue` answers `forgejo`; `sop-forge-pr-workflow`).
2. Forge CI runs `.lastgit/ci.sh` as `ci-required`; branch protection on `main` requires it; auto-merge.
3. On push to `main`, the `publish` job builds `dist/`, publishes the artifact, and promotes `stable`; host-track installs it.

`.lastgit/ci.sh` and `.lastgit/artifacts.json` stay: they are the gate script and
the artifact manifest, now driven by Forge CI. Do not merge on GitHub.

The public package/CLI names remain `kanban` and `fkanban`; the git slug is
`fkanban`.
