# AGENTS.md — orientation for contributors working on fkanban itself

This file orients a coding agent (or human) who opens this repo to **develop
fkanban**. For *using* fkanban (install, the full command catalog, dependencies,
MCP setup) see `README.md`. This file is the build/test/run/dogfood/PR workflow
plus the non-obvious gotchas.

`CLAUDE.md` is a symlink to this file, so Claude Code, Cursor, Codex, and any
other AGENTS.md-aware tool all read the same orientation.

## What this is

fkanban is a kanban board over [fold_db](../fold) — a thin **Bun + TypeScript**
client of `fold_db_node` (`/api/mutation` + `/api/query`) and the
`schema_service` (`POST /v1/schemas`). It ships as a **CLI** (`src/cli.ts`) and
an **MCP server** (`src/mcp/`) so agents can drive the board. Modeled on
`fbrain`. There is **no desktop GUI** — that's deliberate (decided 2026-06-15);
the surface is CLI + MCP only.

Cards live in two schemas published under the `fkanban/*` app namespace
(`fkanban/Card`, `fkanban/Board`); they persist in folddb. Default columns:
`backlog → todo → doing → review → done`.

## Layout

| Path | What |
|---|---|
| `src/cli.ts` | CLI entry — arg parsing + command dispatch |
| `src/commands/` | one module per command (add, move, list, search, …) |
| `src/mcp/main.ts` | MCP server entry (stdio) |
| `src/mcp/server.ts` | MCP tool definitions over the same client |
| `src/record.ts` | card/board model + dependency + soft-delete (tombstone) logic |
| `src/client.ts` | folddb HTTP client (`/api/mutation`, `/api/query`) |
| `src/schemas.ts` | single source of truth for the Card/Board schemas |
| `src/config.ts` | `~/.fkanban/config.json` (override via `$FKANBAN_CONFIG`) |
| `bin/fkanban` | PATH shim (`bun run src/cli.ts "$@"`) |
| `README.md` | full command + install reference (user-facing) |
| `.github/workflows/ci.yml` | CI: Typecheck + Tests + `ci-required` umbrella |

## Build / test

```bash
bun install            # worktrees start with NO node_modules — do this first
bun test               # bun's test runner over test/
bun run typecheck      # tsc --noEmit (tsc resolves types from node_modules)
```

CI (`.github/workflows/ci.yml`) runs the same two checks (job "Typecheck +
Tests") plus a `ci-required` umbrella and CodeQL, in ~1 min. `bun install
--frozen-lockfile` in CI, so keep `bun.lock` in sync.

## Run / dogfood

```bash
bun run src/cli.ts <cmd>     # or the bin/fkanban shim once it's on PATH
bun run src/cli.ts doctor    # health-check config + node + schemas + round-trip
```

The CLI is a thin client — it needs a running folddb node. Tom's primary daily
driver runs on **:9001**. Dogfood against it by reading/writing **through the
app** (the CLI/MCP) — **never** `kill`/`kill -9`/reset/`brew restart` it, and
never wipe its data. For destructive or migration tests, spin up an **ephemeral
folddb node on another port** and point `init` at it:

```bash
bun run src/cli.ts init --node-url http://127.0.0.1:9105 \
  --schema-service-url <dev-schema-service-url>
```

## PR workflow + gotchas

- **Repo-level auto-merge is DISABLED.** `gh pr merge --auto` errors *"Auto
  merge is not allowed"* — do **not** use it. The working flow is:
  ```bash
  git push -u origin HEAD
  gh pr create --fill --base main
  gh pr checks <n> --watch      # block (sleeplessly) until CI is green
  gh pr merge <n> --squash      # land it
  ```
- **Worktrees have no `node_modules`.** `git worktree add` doesn't copy them —
  run `bun install` before `bun test` / `bun run typecheck` / running the CLI.
- **`add <slug>` is create-OR-update.** It merges: unset flags keep the card's
  existing values, so a partial `add` won't clobber other fields. But `--body`
  **replaces** the whole body (it does not append) — dump + concatenate first if
  you mean to add to it.
- **Dependencies are tag-encoded.** Edges are stored as reserved `dep:<slug>`
  entries in the card's `tags` array (no schema change) — same trick as the
  soft-delete tombstone. A dep on a card that doesn't exist is "missing": it's
  surfaced as a warning but does **not** block (it could never reach `done`).
  See `depStatus` in `src/record.ts`.
- **Soft-delete is a tombstone.** fold_db is append-only, so `rm` overwrites the
  card with a `__fkanban_deleted__` tag and read paths filter it — records are
  never physically removed.
- **Schemas are published once, out of band.** Under app_identity v3.1 a schema
  claim under `fkanban/*` must be signed by an enrolled developer's DevCert, so
  the schemas are published to the schema_service **once** (see README → "App
  creation"). `init` only **loads + resolves** them — a contributor does **not**
  republish on every change.

Keep PRs atomic. When in doubt about a command, the README has the full catalog.
