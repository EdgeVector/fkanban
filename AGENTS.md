# AGENTS.md — developing fkanban itself

For *using* fkanban (install, command catalog, MCP setup) see `README.md`. This
file is the build/test/run/PR workflow plus the gotchas that bite. `CLAUDE.md`
is a symlink to this file (shared by Claude Code, Cursor, Codex, …).

Orientation, architecture, history, and the CLI/MCP-only form-factor decision
(no desktop GUI — settled, don't re-raise) live in fbrain:

```bash
fbrain get projects-fkanban       # or: fbrain ask "<question about fkanban>"
```

TL;DR: a kanban board that's a thin Bun + TypeScript client of `fold_db_node`
(`/api/mutation`, `/api/query`) + `schema_service`. Ships as a CLI (`src/cli.ts`)
and MCP server (`src/mcp/`). Cards persist in folddb under the `fkanban/*` app
namespace (`fkanban/Card`, `fkanban/Board`). Source map: `src/commands/` (one
module per command), `src/record.ts` (card model, deps, soft-delete),
`src/client.ts`, `src/schemas.ts`, `src/config.ts` (`$FKANBAN_CONFIG`).

## Build / test

```bash
bun install            # worktrees start with NO node_modules — do this FIRST
bun test               # bun's test runner over test/
bun run typecheck      # tsc --noEmit
```

CI runs the same two checks plus a `ci-required` umbrella and CodeQL (~1 min,
`--frozen-lockfile` — keep `bun.lock` in sync).

## Run / dogfood

```bash
bun run src/cli.ts <cmd>     # or the bin/fkanban shim once on PATH
bun run src/cli.ts doctor    # health-check config + node + schemas + round-trip
```

The CLI needs a running folddb node. Tom's primary brain runs on **:9001** —
dogfood by reading/writing **through the CLI/MCP**; NEVER `kill`/reset/`brew
restart` it or wipe its data. For destructive/migration tests spin up an
ephemeral node on another port and `init --node-url http://127.0.0.1:9105
--schema-service-url <dev-url>`.

## PR workflow + gotchas

- **Merge queue.** Let the queue pick the strategy — bare `gh pr merge <n>
  --auto`, never `--squash`/`--merge`/`--rebase`. Flow: `git push -u origin
  HEAD` → `gh pr create --fill --base main` → `gh pr checks <n> --watch` → `gh
  pr merge <n> --auto`.
- **Worktrees have no `node_modules`** — `bun install` before test/typecheck/run.
- **`add <slug>` is create-OR-update** and merges (unset flags keep existing
  values) — but `--body` **replaces** the whole body, so dump + concat to append.
- **Dependencies are tag-encoded** as reserved `dep:<slug>` entries in `tags`
  (no schema change). A dep on a missing card warns but doesn't block. See
  `depStatus` in `src/record.ts`.
- **Soft-delete is a tombstone** — fold_db is append-only, so `rm` overwrites
  with `__fkanban_deleted__` and read paths filter it; nothing is physically removed.
- **Schemas are published once, out of band** (app_identity v3.1: a `fkanban/*`
  claim needs an enrolled DevCert). `init` only loads + resolves — don't
  republish per change. See README → "Republishing the schemas".

Keep PRs atomic. README has the full command catalog.
