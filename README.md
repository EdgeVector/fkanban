# fkanban

A kanban board over [fold_db](../fold). Cards move through columns; every
change persists in folddb. Modeled on `fbrain` — a thin Bun/TypeScript client
of the `fold_db_node` (`/api/mutation` + `/api/query`) and the `schema_service`
(`POST /v1/schemas`).

Two schemas, registered under the `fkanban/*` app namespace (so they never
collide with `fbrain/*` or any other app on a shared daemon):

- **`fkanban/Card`** — `slug, title, body, board, column, position, assignee, tags, created_at, updated_at`
- **`fkanban/Board`** — `slug, title, body, columns, created_at, updated_at`

Default columns: `backlog → todo → doing → review → done`.

## App creation (one-time)

Under app_identity v3.1 a schema claim under the `fkanban/*` namespace must be
signed by an enrolled developer's DevCert, so the schemas are published to the
schema_service **once**, out of band, via the exemem app-creation flow. After
that, `fkanban init` just loads + resolves them — it never self-publishes.

```bash
# 0. Enroll a developer once (see the app-identity-dev-enroll skill / runbook):
#    `folddb-dev developer init` + a row in ExememDevelopers-<env> with
#    developer_access=true + an EXEMEM_DEV_API_KEY (em_<48 hex>).

# 1. Register the fkanban app namespace.
folddb-dev app new --id fkanban --metadata-file fkanban.app.json --out app.json
folddb-dev app publish --app-file app.json \
  --schema-service-url <schema-service-url> --dev-api-key "$EXEMEM_DEV_API_KEY"

# 2. Emit the schema definitions from the single source of truth, then
#    register + publish each under the app (start a dev session first):
bun -e 'import{cardSchema,boardSchema}from"./src/schemas.ts";import{writeFileSync}from"node:fs";
  writeFileSync("card.schema.json",JSON.stringify(cardSchema.schema,null,2));
  writeFileSync("board.schema.json",JSON.stringify(boardSchema.schema,null,2));'
folddb-dev start --name fkanban-pub --schema-service-url <schema-service-url>
folddb-dev schema register --file card.schema.json  --session fkanban-pub
folddb-dev schema register --file board.schema.json --session fkanban-pub
folddb-dev schema publish --schema Card  --app fkanban --schema-service-url <url> --session fkanban-pub
folddb-dev schema publish --schema Board --app fkanban --schema-service-url <url> --session fkanban-pub
```

(Schema publishes are async — the app row / schemas take a few seconds to
appear in the registry. `folddb-dev app list` / `curl .../v1/schema/<hash>`
confirm.)

## Prerequisites

fkanban is a thin client — it needs a running **folddb node** to talk to
(`init` defaults to `http://127.0.0.1:9001`). Start one before `init` in one
of two ways:

- **Homebrew (recommended for just using fkanban):** install folddb from the
  [EdgeVector/homebrew-folddb](https://github.com/EdgeVector/homebrew-folddb)
  tap and start the daemon. It listens on **:9001** by default — exactly
  `init`'s default `--node-url`.

  ```bash
  brew install edgevector/folddb/folddb
  brew services start folddb          # background daemon, restarts at login
  ```

  (`folddb daemon start` works too if you'd rather not run it as a service.)
  First time on a machine, run `folddb setup` to create your identity.

- **From the fold monorepo (for fold devs):**

  ```bash
  cd fold/fold_db_node && ./run.sh --local --dev
  ```

Once a node is up, run `bun src/cli.ts doctor` to confirm it's reachable, then
`bun src/cli.ts init` to bootstrap the board.

## Install the global `fkanban` shim

The commands below are written as `fkanban <cmd>`. To make a bare `fkanban`
resolve from any directory, symlink the bundled `bin/fkanban` wrapper (a tiny
`bun run src/cli.ts "$@"` script) into a directory on your `PATH`:

```bash
cd fkanban
ln -sf "$PWD/bin/fkanban" /usr/local/bin/fkanban   # or ~/bin, anywhere on PATH
fkanban doctor                                     # confirms the shim is on PATH
```

This is fully local and reversible — nothing is published to a registry, and
`rm /usr/local/bin/fkanban` removes it. (`bun link` works too — it picks up the
`bin` entry already declared in `package.json` — but the wrapper symlink needs
no global Bun state.) Without the shim, run the CLI as `bun run src/cli.ts <cmd>`
from inside the repo; the two are equivalent.

## Quick start

```bash
cd fkanban
bun install
ln -sf "$PWD/bin/fkanban" /usr/local/bin/fkanban   # one-time: put fkanban on PATH

# Bootstrap the node, LOAD + RESOLVE the published fkanban schemas, seed the
# default board. Defaults: node http://127.0.0.1:9001, schema service = prod
# Lambda.
fkanban init

# …or point at an ephemeral dev node + the dev schema service:
fkanban init \
  --node-url http://127.0.0.1:9105 \
  --schema-service-url https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com

fkanban add ship-login --title "Ship login flow" --tags auth,p1
fkanban move ship-login doing
fkanban add fix-typo --column todo
fkanban list
```

(Haven't installed the shim? Every `fkanban <cmd>` below works as
`bun run src/cli.ts <cmd>` run from the repo directory.)

If `init` reports `schemas_not_published`, the one-time **App creation** step
above hasn't run against that schema service yet.

```
Default board  (default)

BACKLOG  (0)
  —
TODO  (1)
  • fix-typo  fix-typo
DOING  (1)
  • Ship login flow  ship-login  #auth #p1
REVIEW  (0)
  —
DONE  (0)
  —
```

## Commands

| Command | What it does |
|---|---|
| `fkanban init` | bootstrap node + load/resolve published schemas + seed default board (idempotent) |
| `fkanban add <slug>` | create/update a card (`--title --board --column --assignee --tags --deps --body`, or pipe body on stdin) |
| `fkanban move <slug> <column>` | move a card to a column (`--position N`, `--force` past a dependency block) |
| `fkanban dep add <slug> <dep>` | add a dependency edge (card `<slug>` depends on `<dep>`) |
| `fkanban dep rm <slug> <dep>` | remove a dependency edge |
| `fkanban list` | render a board as columns (`--board --column --json --limit N --all`); blocked cards show 🔒 |
| `fkanban search <query>` | find cards by text across slug/title/body/assignee/tags (`--board --column --json`) |
| `fkanban show <slug>` | print one card in detail incl. deps + blocked state (`--json`) |
| `fkanban rm <slug>` | soft-delete a card (tombstone — fold_db is append-only) |
| `fkanban board create <slug>` | create/update a board (`--title --columns a,b,c`) |
| `fkanban board list` | list boards (`--json`) |
| `fkanban board rm <slug>` | soft-delete a board (tombstone); refuses the `default` board or a board with live cards unless `--force` |
| `fkanban doctor` | health-check config + node + schemas + a query round-trip |
| `fkanban mcp` | start an MCP server over stdio |

Global: `--verbose` (echo HTTP), `--version`, `--help`.

`--json` works on the write commands too — `add`, `move`, `dep add/rm`, `rm`,
`board create`, and `board rm` echo the write result as a JSON object instead of a prose
line, so scripts and agents can confirm the outcome machine-readably (e.g.
`fkanban move ship-login doing --json` → `{"slug":"ship-login","from":"todo","to":"doing"}`).

`list` caps each column at **12** cards by default so a long `done` column
can't flood the terminal; the overflow collapses to a dim `… N more (--all)`
line (the `done`/terminal column keeps the most *recent* cards). `--all` shows
everything, `--limit N` sets a custom cap, and `--json` is always unabridged.

`search <query>` finds cards by a case-insensitive substring across slug,
title, body, assignee, and tags — handy once a board has more cards than fit on
screen. Space-separated terms are AND-matched (`fkanban search auth p1` needs
both), results span columns/boards and are annotated with `[board/column]`,
and `--board` / `--column` scope the search.

## Dependencies

A card can depend on other cards. It stays **🔒 blocked** until every
dependency reaches the `done` column, and `move` refuses to advance a blocked
card into a working column (`doing` / `review` / `done`) unless you pass
`--force`. Backlog/todo moves are always allowed.

```bash
fkanban add api --title "Build API"
fkanban add ui  --title "Build UI" --deps api   # ui depends on api
fkanban move ui doing        # ✗ refused: blocked by "api" (not yet done)
fkanban move api done
fkanban move ui doing        # ✓ unblocked
fkanban dep add ui docs      # add another edge incrementally
fkanban dep rm  ui docs      # …or drop one
```

Edges are stored as reserved `dep:<slug>` entries in the card's `tags`
array, so dependencies needed **no schema change / republish** — the same
trick used for the soft-delete tombstone. A dep pointing at a non-existent
card is surfaced as a warning but never blocks (it could never reach `done`).

## MCP server

Exposes the board as tools (`fkanban_list`, `fkanban_search`, `fkanban_add`,
`fkanban_move`, `fkanban_dep_add`, `fkanban_dep_rm`, `fkanban_show`,
`fkanban_rm`, `fkanban_board_create`, `fkanban_board_list`, `fkanban_board_rm`,
`fkanban_doctor`)
so agents can drive — and self-diagnose — the board:

```bash
claude mcp add fkanban bun "$PWD/src/mcp/main.ts"
```

It reads the same `~/.fkanban/config.json` the CLI writes (override the path
with `$FKANBAN_CONFIG`).

## Design notes

- **NodeOwner writes.** Mutations go in without a capability token — correct
  for a local / ephemeral node with `APP_IDENTITY_ENFORCE` off. Under
  enforcement the app would need a consent handshake (see `fbrain`'s
  `capability.ts`); that's intentionally out of scope here.
- **Soft delete.** fold_db is append-only, so `rm` overwrites the card with a
  `__fkanban_deleted__` tag and every read path filters it.
- **Append-with-gaps positions.** New cards land at `maxPosition + 10` so a
  card can later be inserted between two others.
