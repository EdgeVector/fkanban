# AGENTS.md — developing fkanban itself

Canonical build/test/run/PR commands for this repo. `CLAUDE.md` is a symlink to
this file (shared by Claude Code, Cursor, Codex, …). For *using* fkanban
(install, command catalog, MCP setup) see `README.md`.

Ask the brain for anything project-specific — it's consolidated; this doc stays
commands-only:

```bash
fbrain get projects-fkanban             # orientation, architecture, history,
                                        #   CLI/MCP-only form-factor (no GUI — settled)
fbrain get concepts-fkanban-cli-gotchas # worktree node_modules, --body replaces,
                                        #   tag-encoded deps, soft-delete tombstone,
                                        #   schemas published once out-of-band
fbrain ask "<question about fkanban>"
```

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
  ~/.fkanban/worktrees/<slug> fkanban/<slug> origin/main
```

Best-effort: if the parent has no `target/`, or the FS isn't APFS, the worktree
just starts cold like a bare `git worktree add` — the helper still succeeds.
(The 3 AM `clean-up-stale-worktrees` routine prunes these cloned targets exactly
like organic ones; undiverged CoW files make pruning even cheaper.)

## Run / dogfood

```bash
bun run src/cli.ts <cmd>     # or the bin/fkanban shim once on PATH
bun run src/cli.ts doctor    # health-check config + node + schemas + round-trip
```

The CLI needs a running folddb node. Tom's primary brain runs on **:9001** (the
local folddb socket) — dogfood by reading/writing **through the CLI/MCP**; NEVER
`kill`/reset/`brew restart` it or wipe its data. For destructive/migration tests
spin up an ephemeral node on another port:

```bash
bun run src/cli.ts init --node-url http://127.0.0.1:9105 \
  --schema-service-url <dev-schema-service-url>
```

## PR workflow

PRs land through the merge queue — let the queue pick the strategy: bare
`gh pr merge <n> --auto`, never `--squash`/`--merge`/`--rebase`.

```bash
git push -u origin HEAD
gh pr create --fill --base main
gh pr checks <n> --watch     # block until CI is green
gh pr merge <n> --auto       # queue it; no strategy flag
```

Keep PRs atomic. README has the full command catalog.
