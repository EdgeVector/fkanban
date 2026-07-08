# fkanban

A kanban board over [fold_db](https://github.com/EdgeVector/fold/tree/main/fold_db). Cards move through columns; every
change persists in folddb. Modeled on `fbrain` — a thin Bun/TypeScript client
of the `fold_db_node` (`/api/mutation` + `/api/query`) and the `schema_service`
(`POST /v1/schemas`).

Two schemas, registered under the `fkanban/*` app namespace (so they never
collide with `fbrain/*` or any other app on a shared daemon):

- **`fkanban/Card`** — `slug, title, body, board, column, position, assignee, tags, deps, created_at, updated_at, repo, base, kind, block_status, block_reason, north_star, pr_url, branch`
- **`fkanban/Board`** — `slug, title, body, columns, created_at, updated_at`

Default columns: `backlog → todo → doing → review → done`.

> Contributing to fkanban itself? See [AGENTS.md](AGENTS.md) for the
> build/test/run/dogfood + PR workflow and the non-obvious gotchas.

> **Just want to use fkanban?** The `fkanban/*` schemas are already published —
> skip straight to [Prerequisites](#prerequisites) + [Quick start](#quick-start);
> `fkanban init` only loads them. (Re-publishing those schemas to a *new*
> schema_service is a one-time maintainer task — see
> [Republishing the schemas](#republishing-the-schemas-maintainers--one-time).)

## Prerequisites

You need three things before the Quick start, in this order:

**1. Bun.** fkanban is a Bun/TypeScript app, so you need the Bun runtime.

```bash
curl -fsSL https://bun.sh/install | bash   # or: brew install oven-sh/bun/bun
```

**2. The fkanban repo.** Clone it and install its dependencies — this is where
the Quick start's `cd fkanban` comes from.

```bash
git clone https://github.com/EdgeVector/fkanban.git
cd fkanban
bun install
```

**3. A running folddb node.** fkanban is a thin client — it needs a running
**folddb node** to talk to (`init` defaults to `http://127.0.0.1:9001`). Start
one before `init` in one of two ways:

- **Homebrew (recommended for just using fkanban):** install folddb from the
  [EdgeVector/homebrew-folddb](https://github.com/EdgeVector/homebrew-folddb)
  tap and start the daemon. It listens on **:9001** by default — exactly
  `init`'s default `--node-url`.

  ```bash
  brew install edgevector/folddb/folddb
  brew services start folddb          # background daemon, restarts at login
  ```

  (`folddb daemon start` works too if you'd rather not run it as a service.)

  You don't need to run `folddb setup` first: `fkanban init` auto-provisions
  the node identity on first run against a fresh, unprovisioned node — so a
  fkanban-only user can skip it (handy for headless/SSH/CI: just start a node,
  then `fkanban init`, no interactive wizard required). `folddb setup` remains
  the way to set up a full folddb identity (24-word recovery phrase, cloud
  sync) if you want one.

- **From the fold monorepo (for fold devs):**

  ```bash
  cd fold/fold_db_node && ./run.sh --local --dev
  ```

Once a node is up, run `bun src/cli.ts doctor` to confirm it's reachable, then
`bun src/cli.ts init` to bootstrap the board.

## Install the global `fkanban` shim

The commands below are written as `fkanban <cmd>`. To make a bare `fkanban`
resolve from any directory, run the one-line installer from the repo root:

```bash
cd fkanban
bun run install-cli   # symlinks the fkanban + fkanban-mcp shims onto your PATH
fkanban doctor        # confirms the shim is on PATH
```

`install-cli` auto-picks a writable PATH directory (`/usr/local/bin`,
`~/.local/bin`, or `~/bin`); pass an explicit one if you prefer
(`bun run install-cli ~/bin`). If the directory you pass isn't on your
PATH, it links the shims anyway but tells you so (and prints the exact
`export PATH=…` line to add) rather than falsely claiming success. Under the hood it just symlinks the bundled
`bin/fkanban` wrapper (a tiny `bun run src/cli.ts "$@"` script, plus a matching
`fkanban-mcp` one) — so it's fully local and reversible, nothing is published to
a registry, and the `rm …` line it prints removes it. Without the shim, run the
CLI as `bun run src/cli.ts <cmd>` from inside the repo; the two are equivalent.

## Quick start

With the prerequisites in place (Bun installed, repo cloned, `bun install` run,
a folddb node up), from inside the `fkanban` repo:

```bash
bun run install-cli   # one-time: put fkanban on PATH (see "Install the global shim")

# Bootstrap the node, LOAD + RESOLVE the published fkanban schemas, seed the
# default board. Defaults: node http://127.0.0.1:9001, schema service = prod
# Lambda. On a fresh bootstrap, `init` ends by printing a "Next steps" block —
# including the `claude mcp add fkanban …` command to register the MCP server
# (the form is picked for you based on whether the `fkanban` shim is on PATH).
fkanban init

# …or point at an ephemeral dev node. The NODE loads schemas from its own
# configured schema_service; the CLI's --schema-service-url is recorded in
# config for diagnostics only (it shows in `fkanban doctor`) and does NOT
# change where schemas load from.
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

If `init` reports `schemas_not_published`, the **node's** configured
schema_service doesn't have the `fkanban/*` schemas — the node, not the CLI,
loads schemas (`--schema-service-url` is diagnostic-only and won't fix it). The
one-time
[Republishing the schemas](#republishing-the-schemas-maintainers--one-time)
maintainer step hasn't run against the schema_service the node uses yet.

If `init` reports `schema_not_writable`, the node has a `fkanban/*` schema that
**resolves but isn't writable for all fields** — usually an older, narrower
version of the schema (fewer fields than this fkanban build expects), sometimes
loaded *alongside* the current one. `init` now refuses to adopt such a hash
(it would 400 every subsequent write) and **leaves your existing config
untouched**, so the board keeps working. The fix is node-side: load/republish
the current `fkanban/*` schemas (see
[Republishing the schemas](#republishing-the-schemas-maintainers--one-time)),
then re-run `fkanban init`. `init` resolves to — and `fkanban doctor`
write-probes — the schema version whose fields cover the full set fkanban
writes, so a stale duplicate can't silently break writes.

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
| `fkanban add <slug>` | create/update a card (`--title --board --column --assignee --tags --deps --replace-deps --priority P0-P3 --kind pr\|registry\|tracker\|umbrella\|meta\|program\|capstone\|validation --body`, or pipe body on stdin) |
| `fkanban move <slug> <column>` | move a card to a column (`--position N`, `--force` as an explicit override for dependency blocks and default/todo pickup-readiness policy) |
| `fkanban dep add <slug> <dep>` | add a dependency edge (card `<slug>` depends on existing live card `<dep>`) |
| `fkanban dep rm <slug> <dep>` | remove a dependency edge |
| `fkanban tag add <slug> <tag…>` | add one or more tags to a card, incrementally (keeps the rest) |
| `fkanban tag rm <slug> <tag…>` | remove one or more tags from a card |
| `fkanban list` | render a board as columns or a wide table (`--board --column --tag --assignee --wide --json --full-body --limit N --all`); blocked cards show 🔒 |
| `fkanban pickup status` | classify active cards by pickup eligibility and explain why non-ready cards are skipped (`--json`) |
| `fkanban groom stale-blockers` | dry-run/apply cleanup for stale generated blocker metadata (`--apply --json`) |
| `fkanban hygiene orphan-bun` | dry-run/apply a path-scoped PPID-1 Bun helper reaper for fkanban/gstack (`--apply --min-age-hours N --pileup-threshold N --json`) |
| `fkanban rank` | reorder work cards by priority so pickup works urgent cards first (`--board --column`, default `todo`; grouping kinds are skipped) |
| `fkanban search <query>` | find cards by text across slug/title/body/assignee/tags (`--board --column --limit N --all --json`) |
| `fkanban show <slug>` | print one card in detail incl. deps + blocked state (`--json`) |
| `fkanban rm <slug>` | delete a card with fold_db's native tombstone mutation |
| `fkanban board create <slug>` | create/update a board (`--title --columns a,b,c`) |
| `fkanban board list` | list boards (`--json`) |
| `fkanban board rm <slug>` | delete a board with native tombstones; always refuses `default`, and refuses non-default boards with live cards unless `--force` |
| `fkanban migrate area-tags` | one-time cleanup of stale generated `area:*` tags (`--dry-run --json`) |
| `fkanban doctor` | health-check config + node + schemas + a query round-trip |
| `fkanban mcp` | start an MCP server over stdio |

Global: `--verbose` (echo HTTP), `--version`, `--help`.

`--json` works on the write commands too — `add`, `move`, `dep add/rm`,
`tag add/rm`, `rm`, `board create`, and `board rm` echo the write result as a JSON object instead of a prose
line, so scripts and agents can confirm the outcome machine-readably (e.g.
`fkanban move ship-login doing --json` → `{"slug":"ship-login","from":"todo","to":"doing"}`).

`list` caps each column at **12** cards by default so a long `done` column
can't flood the terminal; the overflow collapses to a dim `… N more (--all)`
line (the `done`/terminal column keeps the most *recent* cards). `--all` shows
everything and `--limit N` sets a custom per-column cap — both apply to text
**and** `--json`. The 12-card default is a *text display* affordance only:
`--json` and `--wide` return the complete filtered board by default, and honor
an explicit `--limit N`/`--all` to mean the same bounded (or unbounded) set the
text view shows. `--wide` prints one fixed-width row per card with
`COLUMN SLUG REPO BASE PR UPDATED TITLE` for agent/reconcile scans.
`--full-body` and `--full_body` are compatibility aliases for `--json` with
complete card bodies.

`--tag <tag>` and `--assignee <name>` apply **exact-match** filters to the
listing (contrast the fuzzy substring `search` below), e.g.
`fkanban list --tag fkanban --column doing`.

For hook-safe scripting, `list` and `search` also accept repeatable
`--field <name>` projection. It prints TSV with no header and no JSON:
`fkanban list --column todo --field slug` prints one slug per line, while
`fkanban list --field slug --field pr` prints `slug<TAB>pr` per card. `pr` is
the shorthand for the stored `pr_url` field. Existing filters such as
`--board`, `--column`, `--tag`, `--assignee`, `--limit`, and `--all` still
apply before projection.

`search <query>` finds cards by a case-insensitive substring across slug,
title, body, assignee, and tags — handy once a board has more cards than fit on
screen. Space-separated terms are AND-matched (`fkanban search auth p1` needs
both), results span columns/boards and are annotated with `[board/column]`,
and `--board` / `--column` scope the search. Like `list`, the text output caps
the rendered matches at **20** by default so a busy board doesn't flood the
terminal; the overflow collapses to a dim `… N more (use --limit N or --all)`
line. `--all` shows every match and `--limit N` sets a custom cap — both apply
to text **and** `--json`. As with `list`, the 20-match default is a *text
display* affordance only: `--json` returns the complete match set by default and
honors an explicit `--limit N`/`--all` to mean the same bounded (or unbounded)
set the text view shows.

## Pickup Status And Parking

`default/todo` is the pickup lane: a `pr` card there must carry clean routing
data (`Repo: owner/name` and `Base: branch`, or the matching structured
`--repo`/`--base` fields) so an agent can clone the repo and start once its
dependencies are done. `fkanban add` and `fkanban move` reject malformed
default-todo cards by default, including inline-commented `Repo:` headers,
missing base branches, intentional `block_status` holds, and non-pickup
`--kind` values. Use `--force` only as an explicit operator override; otherwise
put human-gated, deferred, tracker, program, capstone, validation, and other
non-pickup work on a parking surface until it is split into concrete PR work.

Use `pickup status` before grooming or pickup:

```bash
fkanban pickup status
fkanban pickup status --json
```

It classifies each active card as `pickup-ready`,
`blocked-on-dependency`, `human-gated`, `malformed-routing`,
`parked/non-work`, `collision`, or `stale-metadata`. The JSON shape carries the
same counts and per-card reason/suggestion fields for automations.

The conventional human/parking surface is a board named `human`:

```bash
fkanban board create human \
  --title "Human / parked work" \
  --columns todo,waiting,validated,done

fkanban add legal-review \
  --board human \
  --column todo \
  --block-status needs_human \
  --block-reason "waiting on legal review"
```

Cards on `human` are visible through `fkanban list --board human` and
`fkanban board list`, but `pickup status` never treats them as pickup-ready.
Dependencies still work across boards: a `default/todo` card can depend on a
human-board prerequisite and remains `blocked-on-dependency` until that
prerequisite reaches the human board's terminal column (`done` by the convention
above).

Return work to the pickup lane only when the human gate is actually cleared:

```bash
fkanban add legal-review --board default --column todo \
  --block-status none --block-reason ""
fkanban rank
```

Migration guidance:

- Move true Tom/human, legal, hardware, product-decision, or validation-evidence
  gates to `human` and keep the explicit `block_status`/`block_reason`.
- Move deliberately deferred or sequencing-only rows to a parking board, or keep
  them out of `default/todo` with `--block-status deferred`.
- Mark trackers, programs, capstones, validations, registries, and context rows
  with their non-`pr` `--kind`; split out a concrete `pr` card when code is
  ready.
- Do not auto-clear real human gates. Use
  `fkanban groom stale-blockers` to find generated/stale blocker metadata, then
  review the dry-run before applying safe generated cleanup.

`groom stale-blockers` is dry-run by default:

```bash
fkanban groom stale-blockers
fkanban groom stale-blockers --apply
```

It reports stale generated `BLOCKED:` prose, malformed `Repo:` header lines,
block status/reason mismatches, stale pickup-area overlap holds, and
human/parking candidates. With `--apply`, it rewrites only generated boilerplate
and structured fields it can prove stale; ambiguous or real human gates stay as
review-only candidates.

`hygiene orphan-bun` is dry-run by default and does not talk to the folddb node:

```bash
fkanban hygiene orphan-bun
fkanban hygiene orphan-bun --apply
```

It only targets PPID-1 Bun processes older than 24 hours whose command path
matches the explicit agent-tooling allowlist: fkanban MCP (`src/cli.ts mcp` or
`src/mcp/main.ts`), gstack browse server (`gstack/.../browse/src/server.ts`), or
gstack terminal-agent (`gstack/.../browse/src/terminal-agent.ts`). It also flags
same-parent Bun pileups above 100 processes so the machine-hygiene loop can
surface Codex-style process explosions without killing by process name.

## Dependencies

A card can depend on other cards, including cards on another board such as the
`human` parking board. It stays **🔒 blocked** until every dependency reaches
its own board's terminal column, and `move` refuses to advance a blocked card
into a working column (`doing` / `review` / `done`, or a custom board's terminal
column) unless you pass `--force`. Backlog/todo moves are always allowed.

Cards marked `--kind tracker`, `--kind umbrella`, `--kind meta`,
`--kind registry`, `--kind program`, `--kind capstone`, or `--kind validation`
are context/grouping cards, not prerequisites: if another card lists one as a
dep, it is treated as satisfied by default and does not block pickup. A parked
human prerequisite that should block downstream implementation should remain a
concrete `pr` dependency until it reaches the parking board's terminal column.

Deleting/tombstoning a card with live dependents is refused (the policy landed
in PR #149) so dependency edges cannot silently turn into missing slugs.

```bash
fkanban add api --title "Build API"
fkanban add ui  --title "Build UI" --deps api   # ui depends on api
fkanban move ui doing        # ✗ refused: blocked by "api" (not yet done)
fkanban move api done
fkanban move ui doing        # ✓ unblocked
fkanban dep add ui docs      # add another edge incrementally
fkanban dep rm  ui docs      # …or drop one
fkanban add ui --deps "" --replace-deps  # explicitly clear all deps
```

Edges are stored in the Card schema's canonical `deps` array field. They are
not part of the body and they are not user tags, so an agent cannot accidentally
erase or forge a dependency while editing prose or labels. Historical
`dep:<slug>` tags are still read as a compatibility fallback, but new writes
strip them and persist edges only in `deps`. The schema_service expands the
existing `fkanban/Card` schema to add `deps`; no data migration is required.

`add --deps` and `dep add` require every dependency slug to resolve to an
existing live card before writing. Generic card updates preserve existing deps
unless `--replace-deps` is set, so a cleanup call with `deps: []` cannot
silently erase real dependency edges. If older data already contains a missing
dep, read paths surface it in `missingDeps` and treat it as blocking until the
edge is repaired. `rm` refuses to delete/tombstone a card while any live card
still depends on it, so normal operations cannot create new missing dependency
slugs.

## Tags

Tags are freeform labels for filtering (`fkanban list --tag <tag>`). There are
two ways to set them, mirroring dependencies exactly:

```bash
fkanban add ship-login --tags auth,p1     # REPLACES the whole tag list
fkanban tag add ship-login blocked        # add one tag, keep the rest
fkanban tag rm  ship-login blocked        # drop one tag, keep the rest
fkanban tag add ship-login p1 needs-review  # add several at once
```

`--tags a,b,c` on `add` overwrites the entire list — supplying it drops any tag
not in the new set. `tag add`/`tag rm` edit a card's labels **incrementally**,
so a groomer can add `p1` without first reading and re-sending every existing
tag (the same distinction `dep add`/`dep rm` have to `add --deps`). Adding a tag
the card already carries is a no-op; removing one it lacks warns but succeeds.
Reserved tags (`dep:<slug>` legacy dependency tags, the delete tombstone) are
rejected — use `dep add`/`dep rm` and `rm` for those. Dependency edges live in
the card's separate `deps` field, not in tags.

## Priority

A card has an optional **priority** — `P0` (most urgent) … `P3` (least). It lets
`fkanban rank` order a column so the `fkanban-pickup` routine (which works the
**lowest `position` first**) picks up the most urgent cards first.

```bash
fkanban add ship-login --priority P0      # stored as a `p0` tag
fkanban rank                              # reorder the `todo` column by priority
fkanban rank --board roadmap --column backlog
```

Priority is read, in precedence order, from **(1)** a line-anchored
`Priority: P<n>` header in the card body (most explicit), then **(2)** a
`p0`..`p3` tag (what `--priority` writes), else **(3)** `P2` (normal). Priority
still rides on the existing `tags` array; dependency edges do not.

`rank` reassigns each work card's `position` in priority order (ties broken by
`created_at`, oldest first), leaving gaps (`10, 20, 30, …`) so a card can be
hand-inserted between two without a full re-rank. Context/grouping cards
(`registry`, `tracker`, `umbrella`, `meta`) are skipped so they do not affect
pickup order. It's **idempotent** — re-running an already-ranked column writes
nothing — and is the step the board groomer runs after promoting cards into
`todo`. The priority *signal* alone does nothing until `rank` turns it into
`position`.

## MCP server

Exposes the board as tools (`fkanban_list`, `fkanban_search`, `fkanban_add`,
`fkanban_move`, `fkanban_rank`, `fkanban_dep_add`, `fkanban_dep_rm`, `fkanban_tag_add`,
`fkanban_tag_rm`, `fkanban_show`,
`fkanban_pickup_status`,
`fkanban_rm`, `fkanban_board_create`, `fkanban_board_list`, `fkanban_board_rm`,
`fkanban_doctor`)
so agents can drive — and self-diagnose — the board.

For MCP writes, omit `deps` on `fkanban_add` unless you are intentionally
setting dependencies. Existing deps are preserved by default; replacing or
clearing them requires `replace_deps: true`, and every dependency slug must
already be an existing live card. Prefer `fkanban_dep_add` and `fkanban_dep_rm`
for ordinary edge edits.

Register it with Claude Code (the `--` separates the `claude mcp add` flags from
the command it runs). With the global `fkanban` shim on PATH, use the short
form:

```bash
claude mcp add fkanban -- fkanban mcp
```

Otherwise point bun at this repo's entrypoint:

```bash
claude mcp add fkanban -- bun "$PWD/src/mcp/main.ts"
```

`fkanban doctor` prints whichever of these applies to your setup. It reads the
same `~/.fkanban/config.json` the CLI writes (override the path with
`$FKANBAN_CONFIG`).

### Token economy (list / search)

The read tools `fkanban_list` and `fkanban_search` are token-budgeted by
default, so a board with hundreds of cards doesn't blow an agent's context
window — card bodies are the bulk of a page's tokens, so both the result count
and each body are capped unless you opt out.

- **Count cap.** Results default-cap to 20 cards (`DEFAULT_SEARCH_LIMIT`), and
  every response reports `total` (matches before the cap) and `truncated`
  (whether the cap hid any). Raise the cap with `limit: N` (`0` = uncapped) or
  `all: true`.
- **Body preview.** Each returned card's `body` is a ~200-char single-line
  PREVIEW with a `bodyTruncated` flag. Pass `full_body: true` to inline complete
  bodies, or call `fkanban_show <slug>` — the full-body path for a single card.

(The CLI's `--json` output is unaffected — it intentionally returns full bodies.)

`done_at` is stamped once when a card first enters its board's final column
(usually `done`) and is preserved across later tag/body grooming updates. Legacy
or not-yet-complete cards expose it as an empty string.

## Republishing the schemas (maintainers / one-time)

> You do **not** need this to use fkanban — the `fkanban/*` schemas are already
> published, and `fkanban init` just loads + resolves them. This section is for
> a maintainer standing the schemas up against a *new* schema_service.

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

## Design notes

- **NodeOwner writes.** Mutations go in without a capability token — correct
  for a local / ephemeral node with `APP_IDENTITY_ENFORCE` off. Under
  enforcement the app would need a consent handshake (see `fbrain`'s
  `capability.ts`); that's intentionally out of scope here.
- **Delete.** `rm` uses fold_db's native delete mutation, so tombstoned records
  are skipped by the node before scans. To preserve dependency resolution, card
  deletion refuses while live dependents still point at the card; `board rm
  --force` has the same guard for cards outside the board being removed. Read
  paths still hide the historical `__fkanban_deleted__` tag written by older
  fkanban builds.
- **Append-with-gaps positions.** New cards land at `maxPosition + 10` so a
  card can later be inserted between two others.
- **Priority is a signal over `position`.** A card's priority (`Priority:` header
  or `p0`..`p3` tag) does nothing on its own; `fkanban rank` is what turns it into
  the `position` field pickup/list/sort already order by. Keeps priority
  republish-free (rides on `tags`) and keeps one ordering primitive (`position`).
