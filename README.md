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

## Quick start

```bash
cd fkanban
bun install

# Bootstrap the node, LOAD + RESOLVE the published fkanban schemas, seed the
# default board. Defaults: node http://127.0.0.1:9001, schema service = prod
# Lambda.
bun src/cli.ts init

# …or point at an ephemeral dev node + the dev schema service:
bun src/cli.ts init \
  --node-url http://127.0.0.1:9105 \
  --schema-service-url https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com

bun src/cli.ts add ship-login --title "Ship login flow" --tags auth,p1
bun src/cli.ts move ship-login doing
bun src/cli.ts add fix-typo --column todo
bun src/cli.ts list
```

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
| `fkanban show <slug>` | print one card in detail incl. deps + blocked state (`--json`) |
| `fkanban rm <slug>` | soft-delete a card (tombstone — fold_db is append-only) |
| `fkanban board create <slug>` | create/update a board (`--title --columns a,b,c`) |
| `fkanban board list` | list boards (`--json`) |
| `fkanban doctor` | health-check config + node + schemas + a query round-trip |
| `fkanban mcp` | start an MCP server over stdio |

Global: `--verbose` (echo HTTP), `--version`, `--help`.

`list` caps each column at **12** cards by default so a long `done` column
can't flood the terminal; the overflow collapses to a dim `… N more (--all)`
line (the `done`/terminal column keeps the most *recent* cards). `--all` shows
everything, `--limit N` sets a custom cap, and `--json` is always unabridged.

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

Exposes the board as tools (`fkanban_list`, `fkanban_add`, `fkanban_move`,
`fkanban_dep_add`, `fkanban_dep_rm`, `fkanban_show`, `fkanban_rm`,
`fkanban_board_create`, `fkanban_board_list`) so agents can drive the board:

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
