<!-- last-stack:no-tests:start -->
## No tests or test coverage requirements (Tom, 2026-10-09)

Situation: `no-tests-all-repos-20261009`.
Decision: `decision-2026-10-09-retire-all-tests-and-test-coverage`.

- Do not write, add, run, restore, or require tests.
- Remove tests and test coverage requirements from CI and all linters.
- Remove earlier test requirements from agent rules, skills, and routines when found.
- This rule supersedes fixture-test, mutation-probe, coverage, and test-gate rules.
- Keep product code and non-test build, format, lint, secret, and deployment checks.
<!-- last-stack:no-tests:end -->

# AGENTS.md — developing kanban itself

Canonical build/run/PR commands for this repo. `CLAUDE.md` is a symlink to
this file (shared by Claude Code, Cursor, Codex, …). For *using* kanban
(install, command catalog, MCP setup) see `README.md`.

Ask the brain for anything project-specific — it's consolidated; this doc stays
commands-only:

```bash
fbrain get projects-fkanban             # orientation, architecture, history,
                                        #   CLI/MCP-only form-factor (no GUI — settled)
fbrain get concepts-fkanban-cli-gotchas # worktree node_modules, --body replaces,
                                        #   tag-encoded deps, historical delete-tag filter,
                                        #   schemas published once out-of-band
fbrain ask "<question about kanban>"
```

## Self-improvement papercuts

Follow Tom's standing preference:

```bash
fbrain get preference-always-file-papercuts-for-self-improvement
```

When a tool, workflow, runbook, connector, repo setup, CLI, CI, LastDB path, or
agent instruction creates avoidable friction while working on kanban, record it
instead of letting it vanish in chat. Put durable evidence and rationale in
F-Brain, and create or update a matching F-Kanban card when the issue is
actionable. Prefer dedupe/update over duplicate records. Do this
opportunistically, unless filing it would materially derail urgent user work.

Read this before touching a list path: `fbrain get
concepts-kanban-body-free-card-projections` — `listCards` serves the board
from body-free BoardCards partitions; judging/rewriting a body needs
`listCardsWithBodies`/`findCard`, not `listCards`.

## Build / typecheck

The tests are deleted (Tom, 2026-10-09). The gate runs the schema-sync boundary
check, typecheck, the artifact build, and the artifact smoke.

```bash
bun install            # worktrees start with NO node_modules — do this FIRST
bun run typecheck      # tsc --noEmit
```

CI runs the same checks (`.lastgit/ci.sh`) plus a `ci-required` umbrella and
CodeQL (~1 min, `--frozen-lockfile` — keep `bun.lock` in sync).

## Card worktrees — start WARM (APFS CoW target/)

Create card worktrees in a Rust repo (fold, fold_db_node, …) with the
`bin/fkanban-worktree` helper instead of a bare `git worktree add` — it clones
the parent's `target/` via APFS CoW so the first build is warm, not a 30-60 min
cold compile. Mechanics/rationale: `fbrain get
concepts-fkanban-card-worktree-warm-target-apfs-cow`.

```bash
bin/fkanban-worktree <repo-root> <worktree-dir> <branch> [base-ref]
# e.g. fold card:
bin/fkanban-worktree ~/code/edgevector/fold \
  ~/.kanban/worktrees/<slug> kanban/<slug> origin/main
```

## Run / dogfood

```bash
bun run src/cli.ts <cmd>     # or the bin/kanban shim once on PATH
bun run src/cli.ts ping      # liveness check: ONE status read, no board read
bun run src/cli.ts list      # smoke read (board data-plane round-trip)
```

The CLI needs a running LastDB/FoldDB node. Tom's primary brain is reached over
the configured Unix socket, not the retired TCP `:9001` endpoint. Dogfood by
reading/writing **through the CLI/MCP**; NEVER `kill`/reset/`brew restart` the
primary node or wipe its data. A `doctor`/`init` TCP `:9001` failure can be stale
control-plane behavior, not an outage. For destructive/migration tests spin up an
ephemeral node with its own socket / isolated data dir:

```bash
bun run src/cli.ts init --node-socket-path /tmp/fkanban-test.sock \
  --schema-service-url <dev-schema-service-url>
```

## Review workflow

This repo is homed on GitHub (`EdgeVector/fkanban`, since 2026-09-30). The gate
of record is the `ci-required` check (`.github/workflows/ci-required.yml`,
which runs the committed `.lastgit/ci.sh`). LastGit and Forgejo copies are
frozen; do not push there.

```bash
git push origin HEAD:refs/heads/<branch>
gh pr create --base main --head <branch> --title ... --body-file body.md
gh pr merge <n> --squash --auto --delete-branch
```

Keep PRs atomic. README has the full command catalog.
