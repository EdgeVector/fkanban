# AGENTS.md — developing kanban itself

Canonical build/test/run/PR commands for this repo. `CLAUDE.md` is a symlink to
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

## Build / test

```bash
bun install            # worktrees start with NO node_modules — do this FIRST
bun test               # bun's test runner over test/
bun run typecheck      # tsc --noEmit
```

CI runs the same two checks plus a `ci-required` umbrella and CodeQL (~1 min,
`--frozen-lockfile` — keep `bun.lock` in sync).

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

This repo is homed in LastGit. GitHub is a public read-only mirror for
clone/browse only; do not open or merge GitHub PRs for repo policy changes.
Use LastGit CRs against `lastdb:///fkanban` and the committed `.lastgit/ci.sh`
gate.

```bash
git remote add lastgit lastdb:///fkanban   # once per checkout
git push lastgit HEAD
lastgit cr create fkanban --head <branch> --base main \
  --auto-merge --require-status ci-required
```

Keep PRs atomic. README has the full command catalog.
