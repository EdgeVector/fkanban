# kanban

A kanban board over [fold_db](https://github.com/EdgeVector/fold/tree/main/fold_db). Cards move through columns; every
change persists in folddb. Modeled on `fbrain` — a thin Bun/TypeScript client
of the LastDB/FoldDB node (`/api/mutation` + `/api/query`) using Mini's
Schema Service-backed app-schema declaration for its private-visibility record
shapes.

Development source of truth is LastGit `lastdb:///fkanban`; GitHub
`EdgeVector/fkanban` is a public read-only mirror for clone/browse. See
`.lastgit/README.md` before opening review artifacts.

Two schemas, registered under the `fkanban/*` app namespace (so they never
collide with `fbrain/*` or any other app on a shared daemon):

- **`fkanban/Card`** — `slug, title, body, board, column, position, assignee, tags, deps, surfaces, created_at, created_by, updated_at, repo, base, kind, block_status, block_reason, north_star, pr_url, branch`
- **`fkanban/Board`** — `slug, title, body, columns, created_at, updated_at`

Default columns: `backlog → todo → doing → done`.

> Contributing to kanban itself? See [AGENTS.md](AGENTS.md) for the
> build/test/run/dogfood + PR workflow and the non-obvious gotchas.

> **Just want to use kanban?** Skip straight to
> [Prerequisites](#prerequisites) + [Quick start](#quick-start).
> **`kanban init` is first-time setup only** (no config yet). If
> `~/.fkanban/config.json` or `~/.kanban/config.json` already exists and
> `kanban list` works, **do not re-run init** — see
> [When *not* to run `init`](#when-not-to-run-init).

Schema setup for a **new** install: `kanban init` calls Mini's
`POST /api/apps/declare-schema`. Mini resolves an existing catalog identity or
registers a novel shape with Schema Service, anchors added fields as an
expansion of the prior identity, loads the exact catalog definition, and only
then returns the hash that fkanban may persist. There is no fkanban-side Schema
Service script and no Mini local-mint fallback. Existing rows remain visible
through expansion field mappers; schema changes do not bulk-copy card data.

## Prerequisites

You need three things before the Quick start, in this order:

**1. Bun.** kanban is a Bun/TypeScript app, so you need the Bun runtime.

```bash
curl -fsSL https://bun.sh/install | bash   # or: brew install oven-sh/bun/bun
```

**2. The kanban repo.** Clone it and install its dependencies — this is where
the Quick start's `cd kanban` comes from.

```bash
git clone https://github.com/EdgeVector/fkanban.git
cd kanban
bun install
```

**3. A running folddb node.** kanban is a thin client — it needs a running
**folddb node** to talk to (defaults to Unix socket
`~/.lastdb/data/folddb.sock`). Start one in one of two ways:

- **Homebrew (recommended for just using kanban):** install folddb from the
  [EdgeVector/homebrew-folddb](https://github.com/EdgeVector/homebrew-folddb)
  tap and start the daemon. It serves the Unix socket
  **~/.lastdb/data/folddb.sock** by default — the same socket the CLI uses.

  ```bash
  brew install edgevector/folddb/folddb
  brew services start folddb          # background daemon, restarts at login
  ```

  (`folddb daemon start` works too if you'd rather not run it as a service.)

  You don't need to run `folddb setup` first: on a **fresh** machine, first-time
  `kanban init` auto-provisions node identity against an unprovisioned node
  (handy for headless/SSH/CI). `folddb setup` remains the way to set up a full
  folddb identity (24-word recovery phrase, cloud sync) if you want one.

- **From the fold monorepo (for fold devs):**

  ```bash
  cd fold/fold_db_node && ./run.sh --local --dev
  ```

Once a node is up:

```bash
bun src/cli.ts doctor    # confirm reachable
# Only if you have NO kanban/fkanban config yet:
bun src/cli.ts init      # first-time bootstrap — see "When not to run init"
```

## Install the global `kanban` shim

The commands below are written as `kanban <cmd>`. To make a bare `kanban`
resolve from any directory, run the one-line installer from the repo root:

```bash
cd kanban
bun run install-cli   # symlinks kanban/kanban-mcp plus fkanban/fkanban-mcp aliases
kanban doctor        # confirms the shim is on PATH
```

`install-cli` auto-picks a writable PATH directory (`/usr/local/bin`,
`~/.local/bin`, or `~/bin`); pass an explicit one if you prefer
(`bun run install-cli ~/bin`). If the directory you pass isn't on your
PATH, it links the shims anyway but tells you so (and prints the exact
`export PATH=…` line to add) rather than falsely claiming success. Under the hood it just symlinks the bundled
`bin/kanban` wrapper (a tiny `bun run src/cli.ts "$@"` script, plus a matching
`kanban-mcp` one, with `fkanban` and `fkanban-mcp` aliases kept for compatibility)
— so it's fully local and reversible, nothing is published to
a registry, and the `rm …` line it prints removes all four shims. Without the shim, run the
CLI as `bun run src/cli.ts <cmd>` from inside the repo; the two are equivalent.

For long-lived agent machines, use the host-track refresh helper instead of
pointing PATH at a workspace checkout:

```bash
bin/host-track-refresh
kanban which --json
kanban which --check
```

**Preferred install (Kind B local-safe, host-track apps.json):**

```text
~/.host-track/apps/fkanban/current → versions/<oid>
~/.local/bin/{kanban,fkanban,…}    → …/current/bin/…
```

Upgrade with `last-stack-safe-upgrade-cli fkanban` (or `host-track refresh
fkanban` when wired). `which --check` accepts both that layout and the legacy
checkout `~/.host-track/fkanban` (still used by `bin/host-track-refresh` on
older machines). Override with `FKANBAN_HOST_TRACK_DIR`.

Host-track registers this repo under the app ids `kanban` and `fkanban`
(same install root). Use `host-track status kanban` for the registered app
status, and `fkanban which --json` or `~/.host-track/stamps/fkanban.json` to
inspect the live install.

## Quick start

With the prerequisites in place (Bun installed, repo cloned, `bun install` run,
a folddb node up), from inside the `kanban` repo:

```bash
bun run install-cli   # one-time: put kanban on PATH (see "Install the global shim")

# --- First-time only (no ~/.fkanban/config.json and no ~/.kanban/config.json) ---
# Bootstrap identity, register/resolve fkanban schemas, seed the default board.
# On a fresh bootstrap, `init` prints a "Next steps" block including
# `claude mcp add fkanban …` when useful.
#
# If config already exists and `kanban list` works — skip this. Re-running init
# on a live board is a common agent footgun (see below).
kanban init

# …or point first-time setup at an ephemeral dev node. --schema-service-url is
# recorded for diagnostics only; Mini owns Schema Service registration.
kanban init \
  --node-url http://127.0.0.1:9105 \
  --schema-service-url https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com

kanban add ship-login --title "Ship login flow" --tags auth,p1
kanban move ship-login doing
kanban add fix-typo --column todo
kanban list
```

(Haven't installed the shim? Every `kanban <cmd>` below works as
`bun run src/cli.ts <cmd>` run from the repo directory.)

### When *not* to run `init`

**If kanban is already working on this machine, do not re-run `init` as a heal.**

Preflight before any `init`:

```bash
test -f ~/.fkanban/config.json -o -f ~/.kanban/config.json && echo "config present"
kanban list --column todo    # or: kanban board list
```

| Situation | Do this |
|-----------|---------|
| No config file, first install | `kanban init` once |
| Config present, `kanban list` works | **Stop.** Use normal commands; not init |
| Board empty / weird after someone re-init'd | Do **not** init again — recover pins / indexes; see below |
| New EXTRA schema keys (e.g. reverse indexes) on an existing board | Prefer a **targeted** declare + patch of *only* the new `schemaHashes` keys + load + heal — **not** full init |
| Ephemeral throwaway node / CI | `init` against that node’s socket with a **separate** `KANBAN_CONFIG` path |

Why re-init is unsafe as a “heal”:

1. **Re-declares every schema** (card, board, milestone, extras), not just the
   one you care about, and **rewrites the whole** `schemaHashes` map in config.
2. If Mini resolve returns a **different Board hash** than the one your cards
   were written against, `findBoard("default")` looks at an empty namespace and
   **seeds a fresh Board row** titled `Default board` with slug still
   `default` — same slug, empty shell. Cards live in the Card schema; they are
   not children of the Board row, so this looks like a “new empty default board.”
3. Board seed is only “idempotent” **under the currently pinned Board hash**.
   It is not a safe global “ensure my real board exists.”

Health checks and recovery: prefer `kanban doctor`, `kanban list`,
`kanban board list`, and feature-specific heals (e.g.
`kanban groom board-cards-heal`, `kanban groom milestone-indexes-heal`). Do
**not** treat `init` as the default repair for timeouts, empty columns, or
missing index rows.

If `init` reports `app_schema_declare_unsupported`, the node does not expose
Mini's registered app-schema declaration route. Upgrade LastDB/FoldDB to a Mini
build whose `/api/apps/declare-schema` resolves or registers every proposal
with Schema Service; `--schema-service-url` is diagnostic because Mini owns the
service call. This error is about **first-time** declare capability — it is not
a reason to re-init a working primary board.

Schema synchronization has one executable transport: F-Kanban's node client
calls Mini's `POST /api/apps/declare-schema` (normally through first-time
`kanban init`, or a deliberate targeted declare for new EXTRA keys).
F-Kanban must not call Schema Service, use the legacy owner-declare route,
accept `local_mint`, or copy rows as part of a field expansion. The LastGit CI gate runs
`bun run check:schema-sync-boundary` and rejects those bypasses. An incompatible
key-layout migration is a separately designed and reviewed operation; it is
never inferred from schema synchronization.

If `init` reports `schema_not_writable`, the node has a `fkanban/*` schema that
**resolves but isn't writable for all fields** — usually an older, narrower
version of the schema (fewer fields than this kanban build expects), sometimes
loaded *alongside* the current one. `init` refuses to adopt such a hash
(it would 400 every subsequent write) and **leaves your existing config
untouched**, so the board keeps working. Fix node-side (repair/upgrade Mini
declare path). Only re-run `init` after that if you still have **no** working
config — if the board already works under the old pins, keep them and do not
re-init “to be safe.” `init` and `kanban doctor` write-probe hashes before
trusting them.

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
| `kanban init` | **first-time only:** bootstrap + declare/resolve schemas + seed `default` board. Not a heal — see [When not to run init](#when-not-to-run-init) |
| `kanban add <slug>` | create/update a card (`--title --board --column --assignee --tags --deps --replace-deps --surfaces --priority P0-P3 --milestone <slug> --kind pr\|registry\|tracker\|umbrella\|meta\|program\|capstone\|validation --body`, or pipe body on stdin) |
| `kanban mark <slug> <line>` | append one marker line to an existing card body, idempotently (`--json`) |
| `kanban move <slug> <column>` | move a card to a column (`--from/--expect COL` as a compare-and-swap claim guard, `--position N`, `--force` as an explicit override for dependency blocks and default/todo pickup-readiness policy) |
| `kanban dep add <slug> <dep>` | add a dependency edge (card `<slug>` depends on existing live card `<dep>`) |
| `kanban dep rm <slug> <dep>` | remove a dependency edge |
| `kanban tag add <slug> <tag…>` | add one or more tags to a card, incrementally (keeps the rest) |
| `kanban tag rm <slug> <tag…>` | remove one or more tags from a card |
| `kanban list` | render a board as columns, a wide table, or grouped beneath milestone headings (`--group-by-milestone`); blocked cards show 🔒 |
| `kanban overlap <slug>` | compare a candidate card's surfaces against doing cards in the same repo (exit 2 on declared conflict) |
| `kanban pickup status` | classify active cards by pickup eligibility and explain why non-ready cards are skipped (`--json`) |
| `kanban pickup claim` | atomic next-card claim: priority order + surface-overlap skip + CAS `todo→doing` (`--worker --prefer-repo --exclude-repo --max-doing --dry-run --json`) |
| `kanban groom stale-blockers` | dry-run/apply cleanup for stale generated blocker metadata (`--apply --json`) |
| `kanban hygiene orphan-bun` | dry-run/apply a path-scoped PPID-1 Bun helper reaper for kanban/gstack (`--apply --min-age-hours N --pileup-threshold N --json`) |
| `kanban rank` | reorder work cards by priority so pickup works urgent cards first (`--board --column`, default `todo`; grouping kinds are skipped) |
| `kanban search <query>` | find cards by text across slug/title/body/assignee/tags (`--board --column --limit N --all --json --full-body`) |
| `kanban show <slug>` | print one card in detail incl. deps + blocked state (`--json`) |
| `kanban rm <slug>` | delete a card with fold_db's native tombstone mutation |
| `kanban board create <slug>` | create/update a board (`--title`; `--columns` may be omitted or set to `backlog,todo,doing,done`) |
| `kanban board list` | list boards (`--json`) |
| `kanban board rm <slug>` | delete a board with native tombstones; always refuses `default`, and refuses non-default boards with live cards unless `--force` |
| `kanban milestone add <slug>` | create/update a first-class outcome milestone (`--state --north-star --driver --deps --proof-card --proof-status`) |
| `kanban milestone list` | list the milestone portfolio (`--board --state --json`) |
| `kanban milestone show <slug>` | show one milestone's outcome, lifecycle, dependencies, driver, and proof linkage (`--json`) |
| `kanban milestone state <slug> <state>` | transition `planned\|active\|blocked\|proving\|complete\|abandoned` (`--json`) |
| `kanban milestone reconcile <slug>` | report ready child-card frontier, proof state, and actionable lifecycle warnings (`--json`) |
| `kanban milestone portfolio` | show milestone North Star, lifecycle, proof, ready frontier, blocker, and warning count (`--board --json`) |
| `kanban milestone detail <slug>` | show the outcome, proof, warnings, and child cards grouped by fixed columns (`--json`) |
| `kanban milestone groom` | report actionable driver, proof, frontier, lifecycle, and relationship warnings (`--board --json`) |
| `kanban migrate area-tags` | one-time cleanup of stale generated `area:*` tags (`--dry-run --json`) |
| `kanban doctor` | health-check config + node + schemas + a query round-trip |
| `kanban mcp` | start an MCP server over stdio |

Global: `--verbose` (echo HTTP), `--version`, `--help`.

`--json` works on the write commands too — `add`, `move`, `dep add/rm`,
`tag add/rm`, `rm`, `board create`, and `board rm` echo the write result as a JSON object instead of a prose
line, so scripts and agents can confirm the outcome machine-readably (e.g.
`kanban move ship-login doing --json` → `{"slug":"ship-login","from":"todo","to":"doing"}`).
Use `kanban move ship-login doing --from todo` when claiming work: if another
writer moved the card first, the command exits non-zero and `--json` prints
`{"error":"claim_conflict","current":"<col>","expected":"todo"}` without
moving it.

### Milestones

Milestones are first-class supervisory records between Brain North Stars and
executable cards. They are not tagged cards, never occupy card columns, and can
never be selected by `pickup`. Cards link to them with `--milestone <slug>`;
F-Kanban refuses missing milestone references and board/North-Star mismatches.
Milestones are driven and proven while cards remain the atomic pickup work.
Transitions are explicit and proof-gated. Entering `proving` requires a live
proof card linked back to the same milestone and board. Entering `complete`
also requires that card to be in the board's terminal column, milestone
`proof_status` to be `passing`, and the card body to contain an exact
`PROOF: PASS` or `RESULT: PASS` line. Finishing implementation cards alone
never completes the milestone. A failed proof returns to `active` with
`--proof-status failing` for fix-forward work. `milestone reconcile` exposes
the next ready card frontier and warnings without making the milestone pickup
work.

Use `milestone portfolio` for the cross-outcome view, `milestone detail` to
groom one outcome and its card frontier, and `milestone groom` for the health
queue. The ordinary board remains card-native; `list --group-by-milestone`
adds milestone headings while keeping cards in their fixed columns and puts
unlinked work in a final `Unassigned / Operational` section. Milestone records
themselves never appear as cards.

`list` caps each column at **12** cards by default so a long `done` column
can't flood the terminal; the overflow collapses to a dim `… N more (--all)`
line (the `done`/terminal column keeps the most *recent* cards). `--all` shows
everything and `--limit N` sets a custom per-column cap — both apply to text
**and** `--json`. Default `--json` reads, including `--column`, use the same
12-card-per-column default cap and return single-line body previews with
`bodyTruncated`; pass `--all` to return every row, or `--full-body` /
`--full_body` for the historical complete card-body JSON surface. `--wide`
prints one fixed-width row per card with
`COLUMN SLUG REPO BASE PR UPDATED TITLE` for agent/reconcile scans.

`--tag <tag>` and `--assignee <name>` apply **exact-match** filters to the
listing (contrast the fuzzy substring `search` below), e.g.
`kanban list --tag kanban --column doing`.

For hook-safe scripting, `list` and `search` also accept repeatable
`--field <name>` projection. It prints TSV with no header and no JSON:
`kanban list --column todo --field slug` prints one slug per line, while
`kanban list --field slug --field pr` prints `slug<TAB>pr` per card. `pr` is
the shorthand for the stored `pr_url` field. Existing filters such as
`--board`, `--column`, `--tag`, `--assignee`, `--limit`, and `--all` still
apply before projection.

`search <query>` finds cards by a case-insensitive substring across slug,
title, body, assignee, and tags — handy once a board has more cards than fit on
screen. Space-separated terms are AND-matched (`kanban search auth p1` needs
both), results span columns/boards and are annotated with `[board/column]`,
and `--board` / `--column` scope the search. Like `list`, the text output caps
the rendered matches at **20** by default so a busy board doesn't flood the
terminal; the overflow collapses to a dim `… N more (use --limit N or --all)`
line. `--all` shows every match and `--limit N` sets a custom cap — both apply
to text **and** `--json`. Broad `--json` reads use the same 20-match default cap
and return single-line body previews with `bodyTruncated`; pass `--all` to
return every match, or `--full-body` / `--full_body` for the historical
complete-body JSON surface.

## Pickup Status And Parking

`default/todo` is the pickup lane: a `pr` card there must carry clean routing
data (`Repo: owner/name` and `Base: branch`, or the matching structured
`--repo`/`--base` fields) so an agent can clone the repo and start once its
dependencies are done. `kanban add` and `kanban move` reject malformed
default-todo cards by default, including inline-commented `Repo:` headers,
missing base branches, intentional `block_status` holds, and non-pickup
`--kind` values. Use `--force` only as an explicit operator override; otherwise
put human-gated, deferred, tracker, program, capstone, validation, and other
non-pickup work on a parking surface until it is split into concrete PR work.

Use `pickup status` before grooming or pickup:

```bash
kanban pickup status
kanban pickup status --json
```

**Agents should claim with `pickup claim`**, not hand-roll list → overlap → move:

```bash
kanban pickup claim --json --worker last-stack-fkanban-pickup-w2
# dry-run selection only:
kanban pickup claim --dry-run --json
```

`pickup claim` walks pickup-ready `todo` cards in priority order (P0→P3), skips
surface conflicts with `doing` cards in the same repo, and CAS-moves the first
winner into `doing`. Concurrent workers that lose a race get `claim_conflict`
and the command continues to the next candidate. Idle boards return
`{ "claimed": false, "reason": "no-eligible" }` with exit 0. JSON responses
include bounded `diagnostics.exemplars` for non-ready categories so automations
can report concrete blockers without broad board scans.

For automation idle decisions, treat the queue as truly empty only when the
claim result is all of:

- `claimed: false`
- `reason: "no-eligible"`
- `scanned_ready: 0`
- `skipped: []`

If `scanned_ready > 0`, or `skipped` contains `surface-overlap`,
`exclude-repo`, `claim_conflict`, or another skip reason, ready work existed but
could not be claimed by this worker. That is queue backpressure or routing
selection, not idle capacity; a pickup routine should report the skip and exit
instead of inventing idle work.

It classifies each active card as `pickup-ready`,
`blocked-on-dependency`, `human-gated`, `malformed-routing`,
`parked/non-work`, `collision`, or `stale-metadata`. The JSON shape carries the
same counts and per-card reason/suggestion fields for automations.

The conventional human/parking surface is a board named `human`:

```bash
kanban board create human \
  --title "Human / parked work" \
  --columns todo,waiting,validated,done

kanban add legal-review \
  --board human \
  --column todo \
  --block-status needs_human \
  --block-reason "waiting on legal review"
```

Cards on `human` are visible through `kanban list --board human` and
`kanban board list`, but `pickup status` never treats them as pickup-ready.
Dependencies still work across boards: a `default/todo` card can depend on a
human-board prerequisite and remains `blocked-on-dependency` until that
prerequisite reaches the human board's terminal column (`done` by the convention
above).

Return work to the pickup lane only when the human gate is actually cleared:

```bash
kanban add legal-review --board default --column todo \
  --block-status none --block-reason ""
kanban rank
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
  `kanban groom stale-blockers` to find generated/stale blocker metadata, then
  review the dry-run before applying safe generated cleanup.

`groom stale-blockers` is dry-run by default:

```bash
kanban groom stale-blockers
kanban groom stale-blockers --apply
```

It reports stale generated `BLOCKED:` prose, malformed `Repo:` header lines,
block status/reason mismatches, stale pickup-area overlap holds, and
human/parking candidates. With `--apply`, it rewrites only generated boilerplate
and structured fields it can prove stale; ambiguous or real human gates stay as
review-only candidates.

`hygiene orphan-bun` is dry-run by default and does not talk to the folddb node:

```bash
kanban hygiene orphan-bun
kanban hygiene orphan-bun --apply
```

It only targets PPID-1 Bun processes older than 24 hours whose command path
matches the explicit agent-tooling allowlist: kanban MCP (`src/cli.ts mcp` or
`src/mcp/main.ts`), gstack browse server (`gstack/.../browse/src/server.ts`), or
gstack terminal-agent (`gstack/.../browse/src/terminal-agent.ts`). It also flags
same-parent Bun pileups above 100 processes so the machine-hygiene loop can
surface Codex-style process explosions without killing by process name.

## Dependencies

A card can depend on other cards, including cards on another board such as the
`human` parking board. It stays **🔒 blocked** until every dependency reaches
its own board's terminal column, and `move` refuses to advance a blocked card
into a working column (`doing` / `done`) unless you pass `--force`.
Backlog/todo moves are always allowed.

Cards marked `--kind tracker`, `--kind umbrella`, `--kind meta`,
`--kind registry`, `--kind program`, `--kind capstone`, or `--kind validation`
are context/grouping cards, not prerequisites: if another card lists one as a
dep, it is treated as satisfied by default and does not block pickup. A parked
human prerequisite that should block downstream implementation should remain a
concrete `pr` dependency until it reaches the parking board's terminal column.

Deleting/tombstoning a card with live dependents is refused (the policy landed
in PR #149) so dependency edges cannot silently turn into missing slugs.

```bash
kanban add api --title "Build API"
kanban add ui  --title "Build UI" --deps api   # ui depends on api
kanban move ui doing        # ✗ refused: blocked by "api" (not yet done)
kanban move api done
kanban move ui doing        # ✓ unblocked
kanban dep add ui docs      # add another edge incrementally
kanban dep rm  ui docs      # …or drop one
kanban add ui --deps "" --replace-deps  # explicitly clear all deps
```

Edges are stored in the Card schema's canonical `deps` array field. They are
not part of the body and they are not user tags, so an agent cannot accidentally
erase or forge a dependency while editing prose or labels. Historical
`dep:<slug>` tags are still read as a compatibility fallback, but new writes
strip them and persist edges only in `deps`. Mini local declaration expands the
existing `fkanban/Card` schema to add `deps`; no data migration is required.

`add --deps` and `dep add` require every dependency slug to resolve to an
existing live card before writing. Generic card updates preserve existing deps
unless `--replace-deps` is set, so a cleanup call with `deps: []` cannot
silently erase real dependency edges. If older data already contains a missing
dep, read paths surface it in `missingDeps` and treat it as blocking until the
edge is repaired. `rm` refuses to delete/tombstone a card while any live card
still depends on it, so normal operations cannot create new missing dependency
slugs.

## Surfaces

Cards can declare the repo-relative paths or subsystem names they expect to
touch. Declare surfaces when filing the card, and update them if the scope
grows:

```bash
kanban add ship-cli --surfaces "src/cli.ts,src/mcp/**"
```

The same data can live in the body for incremental adoption:

```text
Surfaces: src/cli.ts, src/mcp/**
```

Run `kanban overlap <slug>` before picking up or widening a card. It compares
the candidate against `doing`/`review` cards with the same repo and prints the
conflicting card slugs plus matched patterns. Declared conflicts exit `2`; cards
with missing surfaces only warn and exit `0` so older cards do not block
adoption.

Use `kanban mark <slug> "<line>"` for routine annotations. `kanban add --body`
replaces the full body, and refuses a body made only of a newline-joined list of
existing card slugs to catch accidental candidate-list clobbers.

## Tags

Tags are freeform labels for filtering (`kanban list --tag <tag>`). There are
two ways to set them, mirroring dependencies exactly:

```bash
kanban add ship-login --tags auth,p1     # REPLACES the whole tag list
kanban tag add ship-login blocked        # add one tag, keep the rest
kanban tag rm  ship-login blocked        # drop one tag, keep the rest
kanban tag add ship-login p1 needs-review  # add several at once
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
`kanban rank` order a column so the `fkanban-pickup` routine (which works the
**lowest `position` first**) picks up the most urgent cards first.

```bash
kanban add ship-login --priority P0      # stored as a `p0` tag
kanban rank                              # reorder the `todo` column by priority
kanban rank --board roadmap --column backlog
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
`fkanban_move`, `fkanban_rank`, `fkanban_pickup_claim`, `fkanban_overlap`, `fkanban_dep_add`, `fkanban_dep_rm`, `fkanban_tag_add`,
`fkanban_tag_rm`, `fkanban_show`,
`fkanban_pickup_status`,
`fkanban_rm`, `fkanban_board_create`, `fkanban_board_list`, `fkanban_board_rm`,
`fkanban_milestone_add`, `fkanban_milestone_list`, `fkanban_milestone_show`,
`fkanban_milestone_state`,
`fkanban_milestone_reconcile`,
`fkanban_milestone_portfolio`, `fkanban_milestone_detail`,
`fkanban_milestone_groom`,
`fkanban_doctor`)
so agents can drive — and self-diagnose — the board.

For MCP writes, omit `deps` on `fkanban_add` unless you are intentionally
setting dependencies. Existing deps are preserved by default; replacing or
clearing them requires `replace_deps: true`, and every dependency slug must
already be an existing live card. Prefer `fkanban_dep_add` and `fkanban_dep_rm`
for ordinary edge edits.

Register it with Claude Code (the `--` separates the `claude mcp add` flags from
the command it runs). With the global `kanban` shim on PATH, use the short
form:

```bash
claude mcp add fkanban -- kanban mcp
```

Otherwise point bun at this repo's entrypoint:

```bash
claude mcp add fkanban -- bun "$PWD/src/mcp/main.ts"
```

`kanban doctor` prints whichever of these applies to your setup. It reads the
same `~/.kanban/config.json` the CLI writes (override the path with
`$KANBAN_CONFIG`, or the compatibility `$FKANBAN_CONFIG`).

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

## Registered vs Shared Schemas

The `fkanban/Card` and `fkanban/Board` schemas are private in visibility, but
every identity is registered with Schema Service. On **first-time** setup,
`kanban init` asks Mini to resolve/register them and persists the returned
catalog hashes in config after write-probing them. An existing install already
has those pins; do not re-init just to “refresh” hashes (see
[When not to run init](#when-not-to-run-init)).

Shared-surface publication is only for contracts fkanban deliberately exposes
to another app or an external surface. Ordinary board storage does not publish
its schemas, but registration with Schema Service is still mandatory.

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
  kanban builds.
- **Append-with-gaps positions.** New cards land at `maxPosition + 10` so a
  card can later be inserted between two others.
- **Priority is a signal over `position`.** A card's priority (`Priority:` header
  or `p0`..`p3` tag) does nothing on its own; `kanban rank` is what turns it into
  the `position` field pickup/list/sort already order by. Keeps priority
  republish-free (rides on `tags`) and keeps one ordering primitive (`position`).
