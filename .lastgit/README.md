# Venue - fkanban (GitHub gate of record)

| Role | Location |
|------|----------|
| SoT / PR / CI / merge | `https://github.com/EdgeVector/fkanban` (since 2026-09-30) |
| LastGit repo | `lastdb:///fkanban` - frozen (disabled) |
| Forgejo repo | archived |
| Host-track artifact | GitHub `publish` job (`ht-artifact-<sha>`), pulled by `last-stack-github-artifact-pull` during `host-track refresh kanban` |

## Workflow

1. Agents open PRs on GitHub (`last-stack-pr-venue` answers `github`).
2. `ci-required` runs `.lastgit/ci.sh` (test job); branch protection on `main` requires it; auto-merge.
3. On push to `main`, the `publish` job builds `dist/` on a macOS arm64 runner, runs `scripts/artifact-smoke.sh`, and uploads the artifact. host-track pulls, verifies, and promotes `stable`.

`.lastgit/ci.sh` and `.lastgit/artifacts.json` stay: they are the gate script and
the artifact manifest. The public package/CLI names remain `kanban` and `fkanban`.
