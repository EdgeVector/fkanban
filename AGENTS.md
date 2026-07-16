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
                                        #   tag-encoded deps, soft-delete tombstone,
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

## Build / test

```bash
bun install            # worktrees start with NO node_modules — do this FIRST
bun test               # bun's test runner over test/
bun run typecheck      # tsc --noEmit
```

CI runs the same two checks plus a `ci-required` umbrella and CodeQL (~1 min,
`--frozen-lockfile` — keep `bun.lock` in sync).

## Card worktrees — start WARM (APFS CoW target/)

When an agent works a card in a Rust repo (fold, fold_db_node, …), create the
card worktree with the `bin/fkanban-worktree` helper instead of a bare
`git worktree add`. It clones the parent checkout's `target/` via APFS
clonefile(2) (`cp -Rc`), so the first `cargo build/check/test` reuses the whole
dependency graph (warm, minutes) instead of cold-compiling it (~30-60 min +
15-30 GB). The clone is copy-on-write: instant, ~zero extra disk until files
diverge, and an **independent** target/ per worktree (never a shared dir/symlink
— concurrent agents must not share cargo's build lock).

```bash
bin/fkanban-worktree <repo-root> <worktree-dir> <branch> [base-ref]
# e.g. fold card:
bin/fkanban-worktree ~/code/edgevector/fold \
  ~/.kanban/worktrees/<slug> kanban/<slug> origin/main
```

Best-effort: if the parent has no `target/`, or the FS isn't APFS, the worktree
just starts cold like a bare `git worktree add` — the helper still succeeds.
(The 3 AM `clean-up-stale-worktrees` routine prunes these cloned targets exactly
like organic ones; undiverged CoW files make pruning even cheaper.)

## Run / dogfood

```bash
bun run src/cli.ts <cmd>     # or the bin/kanban shim once on PATH
bun run src/cli.ts list      # socket-backed health check / smoke read
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
