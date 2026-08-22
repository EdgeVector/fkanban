#!/usr/bin/env bun
// fkanban CLI entrypoint — a kanban board over fold_db.
//
// `--verbose` (global) echoes each HTTP request + response.

import { parseArgs, format } from "node:util";
import * as fs from "node:fs";
import { basename } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

import {
  expectedHostTrackRoot,
  pathWithinAnyHostTrack,
  realpathOrSelf,
  resolveRunningBuild,
  shortBuild,
  type RunningBuild,
} from "./host_track.ts";

import pkg from "../package.json" with { type: "json" };
import { FkanbanError, groomOpsLabel, type Verbose } from "./client.ts";
import { ConfigMissingError, ConfigInvalidError } from "./config.ts";
import { loadAppCtx, loadCtx } from "./context.ts";
import { runInit } from "./commands/init.ts";
import { addCmd } from "./commands/add.ts";
import { markCmd } from "./commands/mark.ts";
import { setCmd } from "./commands/set.ts";
import { ClaimConflictError, moveCmd } from "./commands/move.ts";
import { listCmd } from "./commands/list.ts";
import { rankCmd } from "./commands/rank.ts";
import { searchCmd } from "./commands/search.ts";
import { showCmd } from "./commands/show.ts";
import { rmCmd } from "./commands/rm.ts";
import { boardCreateCmd, boardListCmd, boardRmCmd } from "./commands/board.ts";
import { milestoneAddCmd, milestoneDetailResult, milestoneGapReportResult, milestoneGroomResult, milestoneListResult, milestonePortfolioResult, milestoneReconcilePayload, milestoneReconcileResult, milestoneShowResult, milestoneStateCmd } from "./commands/milestone.ts";
import { pickupStatusCmd } from "./commands/pickup_status.ts";
import { pickupClaimResult, formatPickupClaim } from "./commands/pickup_claim.ts";
import {
  formatPickupClaimV2,
  pickupClaimV2Error,
  pickupClaimV2Result,
} from "./commands/pickup_claim_v2.ts";
import { pickupLanesCmd } from "./commands/pickup_lanes.ts";
import { pickupExplainCmd } from "./commands/pickup_explain.ts";
import { overlapCmd } from "./commands/overlap.ts";
import {
  GROOM_SUBCOMMANDS,
  groomBodyClobberScanCmd,
  groomStaleBlockersCmd,
  groomStructuredRoutingCmd,
  isGroomSubcommand,
} from "./commands/groom.ts";
import { parityCheckCmd } from "./commands/parity_check.ts";
import {
  archiveDoneResult,
  DEFAULT_ARCHIVE_CUTOFF_HOURS,
  DEFAULT_ARCHIVE_MAX,
} from "./commands/archive_done.ts";
import {
  boardCardsHealCmd,
  DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR,
  DEFAULT_BOARD_CARDS_HEAL_REMOVAL_RATIO,
} from "./commands/board_cards_heal.ts";
import { boardCardsHealScheduledCmd, DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT } from "./commands/board_cards_heal_scheduled.ts";
import { boardCardsRekeyCmd } from "./commands/board_cards_rekey.ts";
import { boardListHealCmd } from "./commands/board_list_heal.ts";
import {
  milestoneIndexesHealResult,
  DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_RATIO,
  DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR,
} from "./commands/milestone_indexes_heal.ts";
import { cardListIndexRetireCmd } from "./commands/card_list_index_retire.ts";
import { hygieneOrphanBunCmd } from "./commands/hygiene.ts";
import { depAddCmd, depRmCmd } from "./commands/dep.ts";
import { tagAddCmd, tagRmCmd } from "./commands/tag.ts";
import { migrateAreaTagsCmd, migrateLegacyColumnsCmd } from "./commands/migrate.ts";
import { normalizePriority, PRIORITY_TIERS, writeBodyHeader, type PriorityTier } from "./record.ts";
import { doctor, runDoctorStructured } from "./commands/doctor.ts";
import { pingCommand } from "./commands/ping.ts";
import { FKANBAN_APP_ID, declareGatesLink, gatesCmd } from "./commands/gates.ts";
import { suggestClosest } from "./suggest.ts";
import {
  formatAdd,
  formatMark,
  formatMove,
  formatDep,
  formatTag,
  formatRm,
  formatBoardCreate,
  formatBoardRm,
  formatRank,
  formatMigrateAreaTags,
  formatMigrateLegacyColumns,
  formatMilestoneAdd,
  formatMilestoneState,
  formatError,
} from "./format.ts";

export const TOP_HELP = `fkanban — a kanban board over fold_db

Usage:
  fkanban <command> [options]

Global:
  --db <locator>       write-target DB (lastdb://personal | lastdb://org/<slug>/<db>);
                       also read from env LASTDB_DB (set by org/fkanban wrappers ...)

Commands:
  init                 bootstrap a node + register schemas + seed default board
                       (--node-url --schema-service-url --node-socket-path --name)
  add <slug>           create/update a card (--title --board --column --assignee --created-by --tags --deps --replace-deps --surfaces --priority P0-P3 --body, --force past a block)
  set <slug>           metadata-only update (north-star/milestone/tags/…); NEVER touches body or stdin
  mark <slug> <line>   append one marker line to a card body, idempotently
  move <slug> <col>    move a card to a column (--from/--expect COL claim guard, --position N, --force past a block)
  dep add <slug> <dep> add a dependency edge (card <slug> depends on <dep>)
  dep rm <slug> <dep>  remove a dependency edge
  tag add <slug> <tag> add one or more tags to a card (incremental; keeps the rest)
  tag rm <slug> <tag>  remove one or more tags from a card
  list                 render columns, --wide table, or --group-by-milestone
  overlap <slug>       report declared surface conflicts with doing cards in the same repo
  pickup status        classify active cards by pickup eligibility (--json)
  pickup explain <slug> full readiness path for one card (write-guard+classify+lane+overlap)
  pickup claim         claim by version 1 lane and priority policy
  pickup claim-v2      claim by board order + deps + surfaces + CAS
  pickup lanes         show logical pickup lanes, starvation, and next claim order
  groom structured-routing dry-run/apply backfill body Repo/Base into structured fields
  groom body-clobber-scan report bodies matching generated/script clobber signatures (--json)
  groom stale-blockers dry-run/apply cleanup for stale generated blocker metadata (--apply --json)
  groom board-cards-heal dry-run/apply fix BoardCards list vs show column drift
  groom board-cards-rekey backfill/cut over a staged board-keyed BoardCards identity
  groom board-cards-heal-scheduled run the scheduled BoardCards repair wrapper
  groom parity-check   READ-ONLY: is any row invisible to the reads the board serves? (--json)
  groom board-list-heal dry-run/apply fix all_boards ghosts (deleted board still listed)
                       and missing boards (live board whose cards list can't see)
  groom card-list-index-retire dry-run/apply clear the superseded all_cards rollup
  groom archive-done   dry-run/apply archive cards long finished in a terminal
                       column, so board reads stop scaling with board history
  hygiene orphan-bun   dry-run/apply PPID-1 Bun helper reaper for fkanban/gstack
                       (--apply --min-age-hours N --pileup-threshold N --json)
  rank                 hard todo ranker: p0 → program/MS frontier → unlaned → papercut (--board --column --mode hard|priority)
  search <query>       find cards by text across slug/title/body/tags/assignee (--board --column --field --limit --all --json --full-body)
                       --semantic ranks by MEANING via the LastSeek plane instead of substring
  gates                list open human gates via fbrain's linked open-decisions ledger (--json; --declare-link setup)
  show <slug>          print one card in detail, incl. deps + blocked state (--json)
  rm <slug>            delete a card (hard erase, no undo; refuses if live
                       cards depend on it)
  board create <slug>  create/update a board (--title; columns fixed)
  board list           list boards (--json)
  board rm <slug>      delete a board (hard erase, no undo; always refuses
                       default; refuses live cards unless --force)
  milestone add <slug> create/update a first-class outcome milestone
  milestone list       list milestone portfolio (--board --state --json)
  milestone show <slug> show one milestone (--json)
  milestone state <slug> <state> transition milestone lifecycle state (--proof-status)
  milestone reconcile <slug> report ready frontier + repair the card index (--dry-run)
  milestone portfolio  show milestone health and ready frontiers
  milestone detail <slug> show outcome, cards by column, proof, and warnings (read-only)
  milestone groom      report actionable milestone health warnings
  milestone gap-report deterministic gap map (in-flight / promote / empty)
  migrate area-tags    one-time: re-derive pickup area:* tags across active cards (--dry-run)
  migrate legacy-columns one-time: move cards off columns the board no longer defines (--dry-run)
  ping                 one cheap liveness request to the node (--json)
  doctor               health-check the local setup (--json)
  which                print CLI provenance or a resolved kanban/fkanban executable path (--json)
  mcp                  start an MCP server over stdio
  version              print the fkanban version and exit (alias of --version)
  help                 print this help

Run \`fkanban help <command>\` or \`fkanban <command> --help\` for command details.

Global flags:
  --verbose            echo HTTP requests + responses
  --json               machine-readable output (add/move/dep/rm/board create/
                       board rm echo the write result as JSON; read commands too)
  --help, -h           print this help
  --version, -V        print the fkanban version and exit

Dependencies: a card with deps is 🔒 blocked until each dep card reaches its
board's final column. \`move\`/\`add\` into doing/done — or the board's own
final column — refuses a blocked card unless --force.

Columns (fixed on every board): backlog → todo → doing → done`;

const HELP_FOOTER = "Run `fkanban help` for all commands.";

function withFooter(body: string): string {
  return `${body}\n\n${HELP_FOOTER}`;
}

// Per-command usage. `fkanban <cmd> --help` (or `-h`) prints the matching
// entry instead of the global TOP_HELP firehose. Every command listed in
// TOP_HELP must have an entry here (a unit test enforces they can't drift).
export const COMMAND_HELP: Record<string, string> = {
  init: withFooter(`fkanban init — bootstrap a node + register schemas + seed the default board

Usage:
  fkanban init [options]

Options:
  --node-url <url>            base URL of the fold_db node (e.g. http://127.0.0.1)
  --schema-service-url <url>  schema_service URL recorded in config for diagnostics
  --node-socket-path <path>   unix socket of the node, instead of --node-url
  --name <name>               display name to seed the default board with
  --accept-schema-repin       adopt resolved schema hashes even when they differ
                              from the ones config already pins. A schema hash is
                              the ADDRESS of a record type: rows written under the
                              old hash are invisible under the new one, and a
                              re-pointed index reads exactly like an empty index.
                              Without this flag init refuses and changes nothing.

Schema setup is orchestrated by the NODE through Mini's
/api/apps/declare-schema route. The CLI does not contact --schema-service-url
directly, but Mini must resolve or register every schema with Schema Service
before returning its catalog identity. That URL is also recorded in
~/.fkanban/config.json for diagnostics (it shows up in \`fkanban doctor\`). If
init fails with app_schema_declare_unsupported, upgrade the node to a Mini
build with registered app-schema declaration.

Example:
  fkanban init --node-url http://127.0.0.1 --name "Tom's board"`),

  add: withFooter(`fkanban add — create or update a card (idempotent by slug)

Usage:
  fkanban add <slug> [options]            # --body also reads stdin if piped

Options:
  --title <text>        card title
  --board <slug>        board to place the card on (default: default)
  --column <col>        column to place the card in (default: first column)
  --assignee <name>     who owns the card
  --created-by <id>     creator override for a NEW card (normally inferred from
                        routine/Codex environment; immutable after creation)
  --tags a,b,c          comma-separated tags
  --deps a,b            comma-separated slugs this card depends on
                        On update, this requires --replace-deps when it changes
                        existing deps. Missing cards and edges that would form
                        a cycle are rejected, exit 2.
  --replace-deps        explicitly replace/clear deps on an existing card
  --surfaces a,b        comma-separated repo-relative path globs or subsystem
                        names this card expects to touch
  --priority <P0-P3>    card priority (P0 = most urgent … P3 = least); stored as
                        a p0–p3 tag. \`fkanban rank\` orders a column by this so
                        fkanban-pickup works urgent cards first.
  --body <text>         card body (Markdown); replaces the whole body.
                        Also reads the body from piped stdin when no --body
                        is given (recommended for multi-line/Markdown bodies).
                        Metadata-only stamps (north-star/milestone/tags) should
                        use \`fkanban set\` instead — that verb cannot touch body.
  --force               explicit operator override for dependency blocks and
                        default/todo pickup-readiness policy
  --json                echo the write result as JSON

Structured fields (auto-derived from the body/tags when omitted):
  --repo <owner/name>   repo a build agent clones (else: inferred from a subsystem
                        tag; >1-repo tags hold needs_human, no-signal cards stay headerless)
  --base <branch>       base branch a PR targets (default: main)
  --kind <k>            pr|registry|tracker|umbrella|meta|program|capstone|validation
                        (non-pr kinds are context/grouping cards, never picked up)
  --block-status <s>    none|needs_human|design_first|deferred (intentional holds)
  --block-reason <text> why, when --block-status is set
  --north-star <slug>   fbrain North Star this card advances
  --milestone <slug>    fkanban Milestone this card advances
  --pr-url <url>        the PR driving this card (when in flight)
  --branch <name>       worktree/feature branch

Multi-line bodies — pipe via stdin, don't inline:
  For any multi-line/Markdown body, PIPE it on stdin instead of passing
  --body "$(cat …)" or --body "$VAR". A body interpolated into the command
  line is re-evaluated by the shell: backticks and $(...) inside the body
  run as commands ((eval): command not found: <word>) and the written body
  is silently corrupted/truncated. The stdin path never puts the body on the
  command line, so it is verbatim and immune.
  printf '%s' "$BODY" | fkanban add ship-login --title "Ship login" --column todo

Example:
  fkanban add ship-login --title "Ship login" --column todo --priority P1 --tags auth`),

  milestone: withFooter(`fkanban milestone — manage bounded, provable outcomes

Usage:
  fkanban milestone add <slug> [options]
  fkanban milestone list [--board <slug>] [--state <state>] [--json]
  fkanban milestone show <slug> [--json]
  fkanban milestone state <slug> <state> [--proof-status <status>] [--json]
  fkanban milestone reconcile <slug> [--dry-run] [--max-repairs N|unlimited] [--force-milestone-card-payload-upsert] [--json]
  fkanban milestone portfolio [--board <slug>] [--json]
  fkanban milestone detail <slug> [--json]
  fkanban milestone groom [--board <slug>] [--json] [--json-array]
  fkanban milestone gap-report [--board <slug>] [--json]

Add options:
  --title <text>        outcome title
  --body <markdown>     outcome, acceptance criteria, and rationale
  --board <slug>        owning board (default: default)
  --state <state>       planned|active|blocked|proving|complete|abandoned
  --position <N>        portfolio ordering
  --north-star <slug>   parent Brain North Star
  --driver <name>       person, agent, or routine driving reconciliation
                        (default: last-stack-milestone-driver; program-driver is refused)
  --deps a,b            milestone dependencies
  --proof-card <slug>   terminal validation card
  --proof-status <s>    pending|passing|failing|not_required
  --block-reason <text> why the milestone is blocked

Reconcile options:
  --dry-run             classify index drift and report it, writing nothing
  --max-repairs <N>     cap repair writes for one run (default 25; "unlimited"
                        to lift the cap, 0 to classify only). Reconcile is
                        convergent, so a capped run makes strict progress and
                        reports the remainder.
  --force-milestone-card-payload-upsert
                        emergency repair override: direct-write MilestoneCards
                        payloads instead of requesting BoardCards protein fold

reconcile repairs the MilestoneCards index as it reads by defaulting to
BoardCards protein-fold requests; detail and portfolio never write. A direct
payload repair costs seconds per row on the shared node and requires the force
flag above.

Milestones are supervisory records, never pickup cards.
New milestones default to driver last-stack-milestone-driver. Superseded
program-driver is rejected — use the hierarchical north-star-driver →
milestone-driver pipeline instead of bulk card scaffolding.`),

  mark: withFooter(`fkanban mark — append one marker line to an existing card body

Usage:
  fkanban mark <slug> "<line>" [--json]

Appends the line only if it is not already present. This preserves the card's
board, column, tags, kind, and other metadata; it never replaces the full body.
Use this for routine annotations instead of \`add --body\`.

Options:
  --json                echo the write result as JSON

Example:
  fkanban mark ship-login "NEEDS-HUMAN: missing DONE-WHEN"`),

  set: withFooter(`fkanban set — metadata-only update (never touches body)

Usage:
  fkanban set <slug> [options]

Update structured / display fields on an EXISTING card. This verb has no
\`--body\` flag and never reads stdin, so a grooming/backfill loop that only
stamps north_star, milestone, tags, priority, or similar cannot destroy the
card's GOAL/END STATE brief as a side effect of a whole-body replace.

Use this for NS/MS assignment and other metadata stamps. Use \`add --body\` (or
piped stdin) only when you intentionally rewrite the brief; use \`mark\` to
append one line.

Options (at least one required):
  --title <text>        card title
  --assignee <name>     who owns the card
  --tags a,b,c          replace the freeform tag list
  --priority <P0-P3>    priority tier (stored as a p0–p3 tag)
  --repo <owner/name>   repo a build agent clones
  --base <branch>       base branch a PR targets
  --kind <k>            pr|registry|tracker|umbrella|meta|program|capstone|validation
  --block-status <s>    none|needs_human|design_first|deferred
  --block-reason <text> why, when --block-status is set
  --north-star <slug>   fbrain North Star this card advances
  --milestone <slug>    fkanban Milestone this card advances
  --pr-url <url>        the PR driving this card (when in flight)
  --branch <name>       worktree/feature branch
  --surfaces a,b        path globs / subsystem names this card expects to touch
  --force               operator override for dependency / pickup-readiness gates
  --json                echo the write result as JSON

Example:
  fkanban set ship-login --north-star ns-auth --milestone ms-login-v1`),

  move: withFooter(`fkanban move — move a card to another column

Usage:
  fkanban move <slug> <column> [options]

Options:
  --from <col>          claim guard: only move if the card is currently in col
  --expect <col>        alias for --from
  --position <N>        insert at position N within the column
  --assignee <id>       when moving into doing: stamp claim owner
  --worker <id>         alias for --assignee (same stamp as pickup claim)
  --allow-unclaimed     allow move into doing WITHOUT stamping assignee
                        (not a claim; sweeps may reclaim as a zombie)
  --force               explicit operator override for dependency blocks and
                        default/todo pickup-readiness policy
  --json                echo the write result as JSON

Claim note: bare \`move … doing\` is not a full claim by itself. Prefer
\`pickup claim --worker <id>\`, which CAS-claims and stamps assignee. A hand
move into doing stamps assignee from --assignee/--worker or from
LASTGIT_ACTOR / AUTOMATION_ID (DRIVEN_BY=routine) so closeout cannot treat
the card as an empty zombie. Pass --allow-unclaimed only when you mean it.

Example:
  fkanban move ship-login doing --from todo --worker last-stack-fkanban-pickup`),

  dep: withFooter(`fkanban dep — manage dependency edges between cards

Usage:
  fkanban dep add <slug> <dep>     # card <slug> depends on <dep>
  fkanban dep rm  <slug> <dep>     # remove the edge

Options:
  --json                echo the write result as JSON

A card with deps is 🔒 blocked until each dep card reaches its board's final column.
Dependency edges are stored in the card's canonical deps field, not in tags or
body. The dependency card must already exist, and edges that would form a cycle
(direct or transitive) are rejected (exit 2).

Example:
  fkanban dep add ui api`),

  tag: withFooter(`fkanban tag — add or remove tags on a card, incrementally

Usage:
  fkanban tag add <slug> <tag> [tag...]   # union into the card's tags
  fkanban tag rm  <slug> <tag> [tag...]   # remove from the card's tags

Options:
  --json                echo the write result as JSON

Unlike \`add --tags a,b,c\` (which REPLACES the whole tag list), \`tag add\`/
\`tag rm\` edit one tag at a time without disturbing the rest. Adding a tag the
card already carries is a no-op; removing one it lacks warns but succeeds.
Reserved tags (\`dep:<slug>\` legacy dependency tags, the historical
\`__fkanban_deleted__\` tag) are rejected — use \`dep\`/\`rm\`. Dependency
edges live in the separate deps field.

Example:
  fkanban tag add ship-login p1
  fkanban tag rm  ship-login blocked`),

  overlap: withFooter(`fkanban overlap — report declared file-surface conflicts

Usage:
  fkanban overlap <slug> [--json]

Compares the candidate card's surfaces against every doing card with the
same repo. Surfaces come from the structured field or a body header:
  Surfaces: src/cli.ts, src/mcp/**

Missing surfaces are adoption warnings, not conflicts: the command exits 0 when
the answer is unknown. Declared conflicts exit 2 and name the matching patterns.

Example:
  fkanban overlap ship-login`),

  list: withFooter(`fkanban list — render a board as columns of cards

Usage:
  fkanban list [options]

Options:
  --board <slug>        board to render (default: default)
  --column <col>        only show one column
  --tag <tag>           only cards carrying this tag (EXACT membership, not
                        the fuzzy text match of \`search\`)
  --assignee <name>     only cards assigned to this person (exact match)
  --wide                fixed-width table: column/slug/repo/base/pr/updated/title
  --field <name>        project one field as TSV; repeat for multiple fields
                        (e.g. --field slug --field pr)
  --limit <N>           cap cards per column (applies to text AND --json)
  --all                 show every card (no per-column cap; --json previews bodies)
  --json                machine-readable output: {cards, total, truncated}
                        (broad reads are capped previews; total is pre-cap)
  --json-array          legacy bare-array stdout (compat; prefer the envelope)
  --full-body, --full_body
                        compatibility alias for --json with complete bodies
  --group-by-milestone group cards beneath milestone headings, with an
                        Unassigned / Operational section

Example:
  fkanban list --board default --limit 10
  fkanban list --full-body
  fkanban list --tag fkanban --column doing
  fkanban list --column todo --field slug
  fkanban list --wide --column doing`),

  pickup: withFooter(`fkanban pickup — readiness report + atomic next-card claim

Usage:
  fkanban pickup status [--json]
  fkanban pickup explain <slug> [--json]
  fkanban pickup lanes [--json] [--board <slug>]
  fkanban pickup claim [options]
  fkanban pickup claim-v2 [--worker <id>] [--dry-run] [--json]

status — Classifies every active (non-terminal) card as pickup-ready,
blocked-on-dependency, human-gated, malformed-routing, unattached-outcome,
parked/non-work, collision, or stale-metadata. Read-only hygiene report.
malformed-routing is a card nothing can route (no Repo:/Base:);
unattached-outcome is a well-formed card one --milestone from ready.

explain — Full readiness path for ONE card: write-guard
(assertDefaultTodoPickupReady), classify category, lane, surface-overlap vs
doing, situation fence, and eligible_for_claim. Prefer this over re-deriving
policy from prompts.

lanes — Logical lanes on the default board todo queue: p0-now, program:*,
unlaned, papercut. Shows ready/doing pressure, starved lanes (ready>0 and
doing=0), claim sequence cursor, and next claim order (fair-share).

claim — Give the agent the next workable card: walk pickup-ready todo cards
in lane order (p0-now → fair-share among program:* and unlaned → papercut;
P0–P3 within a band), skip surface conflicts with doing in the same repo, and
CAS-claim the first winner into doing (\`move --from todo\`). On
claim_conflict (another worker won), try the next candidate. Prefer this
over hand-rolling list + overlap + move in prompts.

claim-v2 — Read keyed todo and doing ranges. Select the first card in board
order whose dependencies are terminal and whose effective surfaces do not
overlap doing work. Missing surfaces reserve the complete repository. Claim
with one CAS write that also sets the worker. No lanes, cursors, repair,
fair-share, repository policy, capacity policy, Loom, State Machine, or LLM.

status / explain options:
  --json                machine-readable report

lanes options:
  --board <slug>        board (default: default)
  --json                machine-readable lane pressure + state

claim options:
  --board <slug>        board to claim from (default: default)
  --worker <id>         stamp card assignee after claim (e.g. last-stack-fkanban-pickup-w2)
  --prefer-repo a,b     try these repos first (still falls through; never before p0-now)
  --exclude-repo a,b    never claim these repos
  --max-doing <n>       refuse with at-capacity when board doing count ≥ n
  --dry-run             select the next card without moving it
  --json                machine-readable claim result

claim-v2 options:
  --worker <id>         worker identity; required unless --dry-run
  --dry-run             select one card without a write
  --json                result is claimed, none, or error

Example:
  fkanban pickup status
  fkanban pickup explain my-card-slug --json
  fkanban pickup lanes
  fkanban pickup claim --json --worker last-stack-fkanban-pickup
  fkanban pickup claim --dry-run --prefer-repo EdgeVector/fold
  fkanban pickup claim-v2 --dry-run --json`),

  rank: withFooter(`fkanban rank — hard todo ranker (position rewrite for pickup)

Usage:
  fkanban rank [options]

Reassigns each work card's \`position\` so \`pickup claim\` (lowest position first
for list displays) matches the **hard todo ranker**:

  p0-now → program (North Star / MS frontier) → unlaned → papercut

Within a tier: children of active|proving milestones first, then Priority
P0→P3 (body header or p0–p3 tag; default P2), then oldest created_at.
Papercuts never outrank program frontier solely by age or P0 tags.
Registry/tracker/umbrella/meta cards are skipped. Idempotent.

Options:
  --board <slug>        board whose column to rank (default: default)
  --column <col>        column to rank (default: todo — the column pickup reads)
  --mode hard|priority  hard (default) = lane+frontier+priority; priority = legacy P0→P3 only
  --json                echo the resulting order as JSON

Example:
  fkanban rank
  fkanban rank --mode priority
  fkanban rank --board roadmap --column backlog`),

  search: withFooter(`fkanban search — find cards by text across slug/title/body/tags/assignee

Usage:
  fkanban search <query> [options]        # multi-word queries are AND-matched

Options:
  --board <slug>        restrict to one board
  --column <col>        restrict to one column
  --field <name>        project one field as TSV; repeat for multiple fields
                        (e.g. --field slug --field pr)
  --limit <N>           cap rendered matches (applies to text AND --json)
  --all                 show every match (no cap; --json previews bodies)
  --json                machine-readable output: {cards, total, truncated}
                        (broad reads are capped previews; total is pre-cap)
  --json-array          legacy bare-array stdout (compat; prefer the envelope)
  --full-body, --full_body
                        compatibility alias for --json with complete bodies

Example:
  fkanban search "auth p1"
  fkanban search auth --limit 5
  fkanban search auth --all
  fkanban search auth --full-body`),

  gates: withFooter(`fkanban gates — list open human gates from fbrain's open-decisions ledger

Usage:
  fkanban gates [options]

Options:
  --declare-link       ask the node to declare fkanban's local Reference schema
                       as a read-only LINK to fbrain's shared Reference canonical
                       (setup/proof step; requires the dev node matcher)
  --json               machine-readable open gate array

Plain \`fkanban gates\` is read-only: it queries fkanban's app-local Reference
schema, which the node translates through the persisted read-only LINK. It does
not copy, write, clear, or own gate state.

On app-isolation nodes, set FKANBAN_APP_CAPABILITY to a granted fkanban
CapabilityToken blob so the node treats the request as the fkanban app.

Example:
  fkanban gates
  fkanban gates --declare-link`),

  show: withFooter(`fkanban show — print one card in detail (deps + blocked state)

Usage:
  fkanban show <slug> [options]

Options:
  --json                machine-readable output
  --board <slug>        accepted as a compatibility no-op; card slugs are global

Example:
  fkanban show ship-login`),

  rm: withFooter(`fkanban rm — delete a card (hard erase; no trash / undo)

Usage:
  fkanban rm <slug> [options]

Options:
  --json                echo the write result as JSON

Deletes the card permanently. There is no trash or undo. It refuses if any live
card still depends on the target; remove or retarget those dependency edges
first.

Example:
  fkanban rm ship-login`),

  board: withFooter(`fkanban board — create/update, list, or remove boards

Usage:
  fkanban board create <slug> [options]
  fkanban board list [options]
  fkanban board rm <slug> [options]

Options:
  --title <text>        board title (create)
  --columns a,b,c       must be exactly backlog,todo,doing,done (or omit)
  --body <text>         board body (create)
  --force               delete a board with live cards (rm); refuses if
                        outside live cards depend on cards being deleted
  --json                machine-readable list: {boards, total, truncated}
  --json-array          legacy bare-array stdout for board list

Examples:
  fkanban board create sprint --title "Sprint 1"
  fkanban board rm sprint`),

  migrate: withFooter(`fkanban migrate — one-time board data migrations

Usage:
  fkanban migrate area-tags [--dry-run] [--json]
  fkanban migrate legacy-columns [--dry-run] [--json] [--slug S]...

Subcommands:
  legacy-columns       move every card sitting on a column the board no longer
                       defines onto the fixed set (backlog | todo | doing |
                       done). Columns became fixed on 2026-07-16 and the write
                       path has rejected anything else since; cards written
                       before that keep their old value and are iterated by no
                       board view, so \`list\` cannot see them while
                       \`show <slug>\` renders them fine. Maps \`review\` →
                       \`doing\` (an open PR is in-flight work, not a completed
                       one) and REPORTS anything it has no mapping for rather
                       than guessing. Run this BEFORE
                       \`groom board-cards-heal --apply\`, which faithfully
                       projects truth and would otherwise write index rows into
                       a column nothing iterates.

  area-tags            re-derive the pickup \`area:*\` tags on every active
                       (non-done, non-tombstoned) card and rewrite only the
                       cards whose derived set changed. Clears stale boilerplate
                       tags (\`area:fkanban-agent\`, \`area:fbrain-got\`, …) minted
                       by the pre-#130 prose-scraping bug on cards that were
                       never re-written since. Re-derives TAGS only — never
                       touches column, assignee, or an intentional block hold.

Flags:
  --dry-run            report the per-card deltas without writing anything
  --slug S             (legacy-columns) limit to one or more card slugs
  --json               machine-readable report

Example:
  fkanban migrate area-tags --dry-run        # preview
  fkanban migrate area-tags                  # apply
  fkanban migrate legacy-columns --dry-run   # preview the column repair
  fkanban migrate legacy-columns             # apply`),

  groom: withFooter(`fkanban groom — board hygiene reports and safe repairs

Usage:
  fkanban groom structured-routing [--apply] [--json]
  fkanban groom body-clobber-scan [--json]
  fkanban groom stale-blockers [--apply] [--json]
  fkanban groom board-cards-heal [--apply] [--json] [--board SLUG] [--slug S]... [--max-removals N|unlimited]
  fkanban groom board-cards-rekey [--apply] [--json] [--board SLUG]
  fkanban groom board-cards-heal-scheduled [--json] [--board SLUG] [--max-drift N] [--dry-run]
  fkanban groom parity-check [--json] [--board SLUG]
  fkanban groom board-list-heal [--apply] [--json]
  fkanban groom milestone-indexes-heal [--dry-run] [--json] [--board SLUG] [--max-repairs N|unlimited] [--max-removals N|unlimited] [--force-milestone-card-payload-upsert]
  fkanban groom card-list-index-retire [--apply] [--json]
  fkanban groom archive-done [--apply] [--json] [--board SLUG] [--cutoff-hours N] [--max N]

Subcommands:
  structured-routing  backfill empty structured repo/base fields from parseable
                       body Repo:/Base: headers on active cards. Registry cards,
                       absent/ambiguous headers, and already-set fields are left
                       untouched.
  body-clobber-scan   non-mutating scan for card bodies that match the known
                       generated/script clobber signature.
  stale-blockers       detect stale generated pickup/blocker metadata, malformed
                       Repo header lines, stale area-overlap holds, and
                       human/parking candidates; --apply also parks unheld
                       non-pr-kind cards (tracker/validation/capstone/meta)
                       out of default/todo into backlog.
  board-cards-heal     repair BoardCards membership (ONLY path that may delete orphans;
                       list is read-only on Card miss) so list --column agrees with
                       show <slug> (delete orphan column#pos rows, upsert truth).
  board-cards-heal-scheduled
                       scheduled wrapper for the default board: dry-run first,
                       report drifted count, apply only when drift is non-zero
                       and at or below --max-drift.
  board-list-heal      repair the CardListIndex all_boards rollup against Board truth:
                       drop GHOSTS (entry with no Board record — a deleted board that
                       keeps showing in board list and costs a dead partition query
                       on every list) and add MISSING boards (record live, no entry —
                       every card on that board is invisible to list).
  milestone-indexes-heal
                       repair BoardMilestones explicitly and MilestoneCards via
                       BoardCards protein-fold requests by default, with dry-run
                       classification and a bounded per-run write budget.
  card-list-index-retire
                       clear the superseded CardListIndex all_cards rollup. BoardCards
                       already holds the same body-free summary one row per card; the
                       rollup was one unbounded document rewritten in full per mutation.
                       --apply refuses while any card lacks a BoardCards row.
  archive-done         archive cards that have sat in a board's TERMINAL column
                       past --cutoff-hours. The terminal column shares the
                       BoardCards partition with the working set, so every
                       whole-partition read pays for it: measured 581 of 783 rows
                       and 83% of a board read on the live default board. Cards a
                       live non-terminal card still depends on are skipped, oldest
                       cards go first, and a delete failure exits non-zero.

Flags:
  --apply              rewrite only generated boilerplate and structured fields
                       proven stale. Omitted by default: dry-run only.
  --json               machine-readable report
  --board SLUG         (board-cards-heal) limit to one board partition
  --slug S             (board-cards-heal) limit to one or more card slugs
  --max-drift N        (board-cards-heal-scheduled) refuse to apply above this
                       count, default ${DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT}
  --max-repairs N      (milestone-indexes-heal) cap repair writes for one run,
                       default 25; "unlimited" opts out
  --max-removals N     (board-cards-heal, milestone-indexes-heal) refuse the
                       whole apply when a run classifies more removals than
                       this.
                       On board-cards-heal it counts delete-orphan ONLY (the
                       one action that leaves a card on no board); its default
                       is ${Math.round(DEFAULT_BOARD_CARDS_HEAL_REMOVAL_RATIO * 100)}% of rows examined, floor ${DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR} — a wider
                       ratio than the sibling below because this command's
                       legitimate bootstrap reap was measured at 27% of the
                       board.
                       On milestone-indexes-heal: unlike
                       --max-repairs, which RATIONS deletions, this REFUSES
                       them: an index far enough from truth is more likely
                       misclassified than genuinely orphaned. Default scales
                       with the rows examined (${Math.round(DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_RATIO * 100)}%, floor
                       ${DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR}); "unlimited" opts out. Upserts are
                       deliberately unbounded here — a first heal of an empty
                       index is all upserts and must not be refused.
  --force-milestone-card-payload-upsert
                       (milestone-indexes-heal) emergency direct payload repair
  --cutoff-hours N     (archive-done) minimum age in a terminal column, default
                       ${DEFAULT_ARCHIVE_CUTOFF_HOURS}
  --max N              (archive-done) per-run delete ceiling, default
                       ${DEFAULT_ARCHIVE_MAX}. Older cards are archived first, so
                       a capped run drains the coldest end of the archive.

Examples:
  fkanban groom structured-routing
  fkanban groom body-clobber-scan
  fkanban groom structured-routing --apply
  fkanban groom stale-blockers
  fkanban groom stale-blockers --apply
  fkanban groom board-cards-heal
  fkanban groom board-cards-heal --apply
  fkanban groom board-cards-heal-scheduled --json
  fkanban groom board-list-heal
  fkanban groom board-list-heal --apply
  fkanban groom milestone-indexes-heal --dry-run
  fkanban groom milestone-indexes-heal --max-removals 3
  fkanban groom card-list-index-retire
  fkanban groom card-list-index-retire --apply
  fkanban groom archive-done
  fkanban groom archive-done --apply --max 100`),

  hygiene: withFooter(`fkanban hygiene — local machine-hygiene helpers

Usage:
  fkanban hygiene orphan-bun [--apply] [--min-age-hours N] [--pileup-threshold N] [--json]

Subcommands:
  orphan-bun           list or signal stale PPID-1 Bun helper processes whose
                       command path matches the explicit fkanban/gstack
                       allowlist: fkanban MCP, gstack browse server, and
                       gstack terminal-agent. Dry-run by default.

Flags:
  --apply              send SIGTERM to matching candidates. Omitted by default:
                       dry-run only.
  --min-age-hours N    minimum elapsed age, default 24
  --pileup-threshold N flag a same-parent Bun pileup above N processes, default 100
  --json               machine-readable report

Examples:
  fkanban hygiene orphan-bun
  fkanban hygiene orphan-bun --apply`),

  ping: withFooter(`fkanban ping — one cheap liveness request to the node

Usage:
  fkanban ping [--json]

Sends a single unauthenticated status read over the node's socket — no board
read, no schema resolution — and exits 0 iff the node answered. Use this for
"is the node up" health checks instead of \`kanban list\`; reach for
\`kanban doctor\` only when something is actually misconfigured.

Flags:
  --json               machine-readable { ok, latency_ms, version, ... } report`),

  doctor: withFooter(`fkanban doctor — health-check the local setup

Usage:
  fkanban doctor [--json]

Verifies config, node reachability, and resolved schemas. Exits non-zero on
any failed check.

Flags:
  --json               machine-readable { ok, checks } report`),

  which: withFooter(`fkanban which — print CLI provenance or show the PATH shim that will run

Usage:
  fkanban which [kanban|fkanban|kanban-mcp|fkanban-mcp|host-track-refresh|kanban-host-track-refresh] [--json] [--check]

Without a target, prints the running CLI entrypoint, package version, source
root, Bun runtime, and current working directory. This never contacts the board
node, so it is safe for host-track and pickup preflight diagnostics.

With a target, prints the resolved executable path. With --json, also reports
the realpath and whether it lives under the expected host-track checkout.
With --check, exits nonzero when the running CLI or resolved target is not
host-track managed.

Example:
  fkanban which
  fkanban which --json
  fkanban which --check
  fkanban which fkanban-mcp --json`),

  mcp: withFooter(`fkanban mcp — start an MCP server over stdio

Usage:
  fkanban mcp

Exposes the board to MCP clients (e.g. Claude). Speaks JSON-RPC on
stdin/stdout; not meant to be run interactively.

Register with Claude Code (the \`--\` separates \`claude mcp add\` flags from
the command):
  claude mcp add fkanban -- fkanban mcp

Run \`fkanban doctor\` to print the exact \`claude mcp add\` line for your setup
(it resolves the shim-on-PATH vs bun-entrypoint form automatically).`),

  version: withFooter(`fkanban version — print the fkanban version and exit

Usage:
  fkanban version

An alias of the \`--version\`/\`-V\` flag: prints just the version (from
package.json) to stdout and exits 0.

Example:
  fkanban version`),
};

// Resolve which help text to print for the parsed argv. `cmd` is positionals[0],
// `topic` is positionals[1] (only consulted for `kanban help <topic>`).
//
// Routing, in order:
//   - `kanban help <command>` → that command's per-command help (byte-identical
//     to `kanban <command> --help`). An unknown topic falls back to TOP_HELP;
//     the caller is responsible for the "unknown command" note on stderr (this
//     stays a pure text->text function so the unit suite can assert it directly).
//   - `kanban help` / `kanban --help` / no command / unknown command → TOP_HELP.
//   - `kanban <command> --help` → that command's per-command help.
export function resolveHelp(
  cmd: string | undefined,
  help: boolean,
  topic?: string,
): string | undefined {
  if (cmd === "help") {
    if (topic !== undefined && topic in COMMAND_HELP) return COMMAND_HELP[topic];
    return TOP_HELP; // bare `help`, or `help <unknown-topic>` (caller notes it)
  }
  if (!cmd) return TOP_HELP;
  if (help) {
    return cmd in COMMAND_HELP ? COMMAND_HELP[cmd] : TOP_HELP;
  }
  return undefined;
}

export function commandHelpHint(cmd: string | undefined): string {
  return cmd !== undefined && cmd in COMMAND_HELP ? `${cmd} --help` : "help";
}

// Drain piped stdin to source `add --body` when no `--body` flag is given.
// Returns undefined for a TTY or a stream that cleanly reaches EOF with no
// bytes. A pipe that neither delivers bytes nor closes within the first-byte
// grace is a bad invocation: silently treating that as "no body" reports a
// successful update while dropping the caller's intended piped body.
//
// This MUST NOT block on a stdin that never reaches EOF. Under Bun a pipe that
// a parent opens but never writes to or closes — the shape of a background- or
// agent-spawned `fkanban add` that inherits stdin without ever closing it —
// delivers no EOF, so draining it with `for await (...of process.stdin)` hangs
// forever. That is the bug behind "`add` never exits / silently failed to
// persist the card": the await never resolved, so the write below it never ran.
//
// Instead we wait a short grace for the first byte; if none arrives we give up
// with an explicit error. Once bytes do flow we assume a real producer
// (echo/cat/heredoc) that will close its end, and read through to `end`. The
// grace is overridable via FKANBAN_STDIN_IDLE_MS (ms).
export async function readStdinBodyForAdd(
  stdin: NodeJS.ReadStream = process.stdin,
  env: NodeJS.ProcessEnv = process.env,
): Promise<string | undefined> {
  if (stdin.isTTY) return undefined;
  const raw = env.FKANBAN_STDIN_IDLE_MS;
  const parsed = raw === undefined ? NaN : parseInt(raw, 10);
  const firstByteMs = Number.isFinite(parsed) && parsed >= 0 ? parsed : 2000;

  const chunks: Uint8Array[] = [];
  await new Promise<void>((resolve, reject) => {
    let gotData = false;
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", onError);
      resolve();
    };
    const fail = (err: FkanbanError) => {
      if (settled) return;
      settled = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      stdin.off("data", onData);
      stdin.off("end", finish);
      stdin.off("error", onError);
      reject(err);
    };
    const onData = (c: Uint8Array) => {
      gotData = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
      chunks.push(c);
    };
    const onError = (err: Error) => {
      fail(new FkanbanError({
        code: "stdin_body_unavailable",
        message: `Could not read piped stdin body: ${err.message}`,
        hint: "Pass the body with --body, or make the producer close stdin after writing the body.",
        cause: err,
      }));
    };
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      // No first byte within the grace: a silent / never-EOF pipe. Refuse to
      // report success because an intended piped body would be silently lost.
      if (!gotData) {
        fail(new FkanbanError({
          code: "stdin_body_unavailable",
          message: `Timed out waiting for piped stdin body after ${firstByteMs}ms.`,
          hint: "Pass the body with --body, or make the producer write and close stdin before running add.",
        }));
      }
    }, firstByteMs);
    stdin.on("data", onData);
    stdin.on("end", finish);
    stdin.on("error", onError);
  });
  return chunks.length > 0 ? Buffer.concat(chunks).toString("utf8") : undefined;
}

function parseTags(raw: string | undefined): string[] | undefined {
  if (raw === undefined) return undefined;
  return raw.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
}

function parseFields(raw: unknown): string[] | undefined {
  if (raw === undefined) return undefined;
  return (Array.isArray(raw) ? raw : [raw])
    .filter((v): v is string => typeof v === "string")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

// Thrown when a numeric flag (`--limit`, `--position`) is given a value that
// isn't a clean integer at or above its minimum. The message is already
// printed to stderr by parseIntFlag; the dispatch catches this to return the
// exit-2 contract (matching the unknown-flag / list-validate-column handling).
class FlagValidationError extends Error {
  // Discriminant read by key, not by prototype identity. `instanceof` on an
  // Error subclass is unreliable across bun runtimes — it holds on macOS but
  // fails on the Linux CI runner, where the thrown error escaped the dispatch
  // `instanceof` check and hit the top-level catch (exit 1) instead of the
  // exit-2 contract. A tagged property is platform-stable.
  readonly isFlagValidationError = true;
}

function isFlagValidationError(err: unknown): err is FlagValidationError {
  return (
    err instanceof FlagValidationError ||
    (typeof err === "object" &&
      err !== null &&
      (err as { isFlagValidationError?: boolean }).isFlagValidationError === true)
  );
}

// Coerce a numeric flag's raw value to an integer, rejecting non-numeric or
// out-of-range input LOUDLY (stderr + exit 2) instead of silently swallowing
// it into a default. `parseInt` would happily accept "12abc" (→ 12) and turn a
// pure typo into NaN, so we require the whole string to be a clean integer.
// Mirrors the unknown-flag contract: one-line reason + a per-command help hint.
function parseIntFlag(
  raw: string,
  flag: string,
  cmd: string,
  { min }: { min: number },
): number {
  const trimmed = raw.trim();
  const want = min === 1 ? "a positive integer" : `an integer >= ${min}`;
  const help = commandHelpHint(cmd);
  const cleanInteger = /^-?\d+$/.test(trimmed);
  const n = cleanInteger ? Number(trimmed) : NaN;
  if (!cleanInteger || !Number.isSafeInteger(n) || n < min) {
    let msg = `error: --${flag} must be ${want}, got "${raw}".`;
    // --limit 0 used to mean silent-unbounded; point at the documented flag.
    if (flag === "limit" && Number.isInteger(n) && n < 1) {
      msg = `error: --${flag} must be ${want}, got "${raw}". Use --all to show everything.`;
    }
    console.error(`${msg} Run \`kanban ${help}\` to see this command's flags.`);
    throw new FlagValidationError(msg);
  }
  return n;
}

// Coerce a `--priority` value to a canonical tier (P0–P3), rejecting anything
// else LOUDLY (stderr + exit 2) — same contract as parseIntFlag, so a typo'd
// priority is a clean flag error, never a silently-dropped default. Accepts any
// case (`p1`/`P1`).
function parsePriorityFlag(raw: string, cmd: string): PriorityTier {
  const tier = normalizePriority(raw);
  if (tier === null) {
    const help = commandHelpHint(cmd);
    const msg = `error: --priority must be one of ${PRIORITY_TIERS.join(", ")} (P0 = most urgent), got "${raw}".`;
    console.error(`${msg} Run \`kanban ${help}\` to see this command's flags.`);
    throw new FlagValidationError(msg);
  }
  return tier;
}

// Node's parseArgs error codes for malformed flags. With `strict: true`,
// an unknown `--flag`, a value handed to a boolean flag, or a missing value
// for a string flag all throw a TypeError carrying one of these codes. We
// turn them into the same clean error + exit-2 contract as an unknown command,
// instead of silently swallowing the typo (which produced wrong data).
const PARSE_ARGS_ERROR_CODES = new Set([
  "ERR_PARSE_ARGS_UNKNOWN_OPTION",
  "ERR_PARSE_ARGS_INVALID_OPTION_VALUE",
  "ERR_PARSE_ARGS_UNEXPECTED_POSITIONAL",
]);

function isParseArgsError(err: unknown): err is Error & { code: string } {
  return (
    err instanceof Error &&
    typeof (err as { code?: unknown }).code === "string" &&
    PARSE_ARGS_ERROR_CODES.has((err as unknown as { code: string }).code)
  );
}

// Flags accepted by EVERY command. `parseArgs` runs globally (one options set
// spanning all commands), so it only rejects a flag NO command declares. A
// flag that's valid on some *other* command (`show --column`, `move --board`,
// `rm --tags`) slips through and gets silently ignored — contradicting the
// per-command "Run `kanban <cmd> --help` to see this command's flags." hint.
// UNIVERSAL_FLAGS + COMMAND_FLAGS let us re-check each provided flag against
// the command it was actually given to, and reject the misapplied ones with
// the same exit-2 + per-command-help contract as a truly unknown flag.
// `db` is set by org kanban ... (or LASTDB_DB) — explicit write-target locator
// (lastdb://personal | lastdb://org/<slug>/<db>). Stamped on cards as `Db:`.
const UNIVERSAL_FLAGS = new Set(["help", "version", "verbose", "json", "json-array", "db"]);

// Per-command allowed flags (beyond UNIVERSAL_FLAGS), keyed by the same command
// names as COMMAND_HELP. Derived from each command's `--help` text and the
// flags its dispatch branch actually reads. Commands absent here (e.g. `mark`, `show`,
// `rm`, `doctor`, `mcp`, `version`) accept only the universal flags.
const COMMAND_FLAGS: Record<string, Set<string>> = {
  init: new Set(["node-url", "schema-service-url", "node-socket-path", "name", "accept-schema-repin"]),
  add: new Set([
    "title", "board", "column", "assignee", "created-by", "tags", "deps", "replace-deps", "surfaces", "priority", "body", "force",
    "repo", "base", "kind", "block-status", "block-reason", "north-star", "milestone", "pr-url", "branch",
  ]),
  // Metadata-only: no body, no stdin, no placement (board/column), no deps list
  // replace. Grooming scripts that stamp NS/MS/tags must use this so they
  // cannot clobber a brief via accidental body/stdin.
  set: new Set([
    "title", "assignee", "tags", "surfaces", "priority", "force",
    "repo", "base", "kind", "block-status", "block-reason", "north-star", "milestone", "pr-url", "branch",
  ]),
  // reconcile repairs MilestoneCards as it reads; --dry-run classifies without
  // writing and --max-repairs bounds how much it writes in one invocation.
  // --json-array is the legacy bare-array escape for milestone groom.
  milestone: new Set(["title", "body", "board", "state", "position", "north-star", "driver", "deps", "proof-card", "proof-status", "block-reason", "dry-run", "max-repairs", "force-milestone-card-payload-upsert", "json-array"]),
  // move ignores --board on purpose: slugs are global, so it can't scope a
  // lookup. Leaving it out makes `move <slug> doing --board X` an exit-2 error.
  move: new Set(["from", "expect", "position", "force", "assignee", "worker", "allow-unclaimed"]),
  list: new Set(["board", "column", "tag", "assignee", "wide", "field", "limit", "all", "full-body", "full_body", "group-by-milestone", "json-array"]),
  rank: new Set(["board", "column", "mode"]),
  search: new Set(["board", "column", "field", "limit", "all", "full-body", "full_body", "json-array", "semantic"]),
  gates: new Set(["declare-link"]),
  // show accepts --board as a compatibility no-op because agents often copy it
  // from list/add flows. Card slugs are global, so dispatch still ignores it.
  show: new Set(["board"]),
  // board's subcommands read title/columns/body (create) and force (rm).
  // --json-array is the legacy bare-array escape for board list.
  board: new Set(["title", "columns", "body", "force", "json-array"]),
  // migrate's one-time subcommands take --dry-run to preview without writing.
  // legacy-columns also takes repeatable --slug to migrate a named card at a time.
  migrate: new Set(["dry-run", "slug"]),
  groom: new Set(["apply", "dry-run", "board", "slug", "max-drift", "max-repairs", "max-removals", "cutoff-hours", "max", "force-milestone-card-payload-upsert"]),
  hygiene: new Set(["apply", "dry-run", "min-age-hours", "pileup-threshold"]),
  pickup: new Set(["board", "worker", "prefer-repo", "exclude-repo", "max-doing", "dry-run"]),
  which: new Set(["check"]),
};

type WhichReport = {
  package: string;
  version: string;
  command: string;
  executable_path: string;
  source_path: string;
  source_root: string;
  expected_host_track: string;
  in_host_track: boolean;
  build_status: RunningBuild["status"];
  build: string | null;
  current_build: string | null;
  bun_path: string;
  bun_version: string;
  cwd: string;
  issues: string[];
};

function whichReport(): WhichReport {
  const sourcePath = fileURLToPath(import.meta.url);
  const argvPath = process.argv[1] ?? sourcePath;
  const sourceRoot = sourcePath.replace(/\/src\/cli\.ts$/, "");

  // ONE resolution answers both questions this report asks — "is this install
  // managed" and "is it the current build" — because they are the same question
  // about the same tree. Asking `pathWithinAnyHostTrack` a second time here is
  // what let the two halves disagree: under the compiled artifact this report
  // printed `in_host_track: false` while its own `bun_path` line, three lines
  // down, resolved into `~/.host-track/apps/fkanban/versions/<oid>/dist/kanban`.
  //
  // Containment (`in_host_track`) is still reported separately from
  // `build_status`, because it is satisfied forever by any version directory
  // that was ever installed and so cannot tell the current build from a
  // superseded one — that is the field that catches a long-lived `kanban mcp`
  // still serving the version directory it was spawned on. See src/host_track.ts.
  const running = resolveRunningBuild(sourceRoot);
  const inHostTrack = running.installRoot !== null;
  const expectedHostTrack = running.installRoot ?? expectedHostTrackRoot();
  const issues = inHostTrack ? [] : [`fkanban is not running from ${expectedHostTrack}`];
  if (running.status === "superseded") {
    issues.push(
      `running build ${shortBuild(running.build, running.runningRoot)} is superseded — ` +
        `current is ${shortBuild(running.currentBuild, running.currentRoot)}`,
    );
  }

  return {
    package: pkg.name,
    version: pkg.version,
    command: basename(argvPath),
    executable_path: realpathOrSelf(argvPath),
    source_path: sourcePath,
    // The resolved install tree, which under the compiled artifact is NOT
    // `source_path` (that one stays honest about the embedded module URL).
    source_root: running.runningRoot,
    expected_host_track: expectedHostTrack,
    in_host_track: inHostTrack,
    build_status: running.status,
    build: running.build,
    current_build: running.currentBuild,
    bun_path: realpathOrSelf(process.execPath),
    bun_version: Bun.version,
    cwd: process.cwd(),
    issues,
  };
}

function formatWhichReport(report: WhichReport): string {
  return [
    `fkanban v${report.version}`,
    `command: ${report.command}`,
    `executable_path: ${report.executable_path}`,
    `source_path: ${report.source_path}`,
    `source_root: ${report.source_root}`,
    `expected_host_track: ${report.expected_host_track}`,
    `in_host_track: ${report.in_host_track}`,
    `build_status: ${report.build_status}`,
    `build: ${report.build ?? "(n/a)"}`,
    `current_build: ${report.current_build ?? "(n/a)"}`,
    `bun_path: ${report.bun_path}`,
    `bun_version: ${report.bun_version}`,
    `cwd: ${report.cwd}`,
    `issues: ${report.issues.length > 0 ? report.issues.join("; ") : "(none)"}`,
  ].join("\n");
}

// Closest valid flag for a mistyped option on a known command. Mirrors the
// unknown-COMMAND "did you mean" path (suggestClosest over COMMAND_HELP keys),
// but over this command's accepted flags (its COMMAND_FLAGS ∪ UNIVERSAL_FLAGS).
// Returns the bare flag name (no dashes) or null when the token is unknown OR
// too far off to be a likely typo — so `--frobnicate` yields no false positive.
export function suggestFlag(cmd: string, flag: string): string | null {
  if (!(cmd in COMMAND_HELP)) return null;
  const candidates = [...(COMMAND_FLAGS[cmd] ?? []), ...UNIVERSAL_FLAGS];
  return suggestClosest(flag, candidates);
}

// Reject a flag that parseArgs accepted globally but that THIS command doesn't
// declare (e.g. `show --column`, `move --board`). Mirrors the unknown-flag
// contract exactly: same `Unknown option '--<flag>'.` wording + per-command
// help hint + exit 2. Only fires for commands we know; an unknown command
// falls through to its own "Unknown command" handling untouched.
function rejectMisappliedFlags(
  cmd: string,
  values: Record<string, unknown>,
): number | undefined {
  if (!(cmd in COMMAND_HELP)) return undefined;
  const allowed = COMMAND_FLAGS[cmd] ?? new Set<string>();
  for (const flag of Object.keys(values)) {
    if (UNIVERSAL_FLAGS.has(flag) || allowed.has(flag)) continue;
    // First disallowed flag wins — match parseArgs' single-error behavior.
    console.error(`kanban: Unknown option '--${flag}'. Run \`kanban ${cmd} --help\` to see this command's flags.`,
    );
    return 2;
  }
  return undefined;
}

async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        help: { type: "boolean", short: "h" },
        version: { type: "boolean", short: "V" },
        verbose: { type: "boolean" },
        json: { type: "boolean" },
        "json-array": { type: "boolean" },
        db: { type: "string" },
        title: { type: "string" },
        board: { type: "string" },
        slug: { type: "string", multiple: true },
        column: { type: "string" },
        tag: { type: "string" },
        assignee: { type: "string" },
        "created-by": { type: "string" },
        tags: { type: "string" },
        deps: { type: "string" },
        "replace-deps": { type: "boolean" },
        surfaces: { type: "string" },
        priority: { type: "string" },
        mode: { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        kind: { type: "string" },
        "block-status": { type: "string" },
        "block-reason": { type: "string" },
        "north-star": { type: "string" },
        milestone: { type: "string" },
        state: { type: "string" },
        driver: { type: "string" },
        "proof-card": { type: "string" },
        "proof-status": { type: "string" },
        "pr-url": { type: "string" },
        branch: { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        apply: { type: "boolean" },
        "min-age-hours": { type: "string" },
        "pileup-threshold": { type: "string" },
        "max-drift": { type: "string" },
        "max-repairs": { type: "string" },
        "max-removals": { type: "string" },
        "cutoff-hours": { type: "string" },
        max: { type: "string" },
        body: { type: "string" },
        columns: { type: "string" },
        from: { type: "string" },
        expect: { type: "string" },
        position: { type: "string" },
        limit: { type: "string" },
        "full-body": { type: "boolean" },
        full_body: { type: "boolean" },
        semantic: { type: "boolean" },
        field: { type: "string", multiple: true },
        wide: { type: "boolean" },
        all: { type: "boolean" },
        "node-url": { type: "string" },
        "schema-service-url": { type: "string" },
        "node-socket-path": { type: "string" },
        "accept-schema-repin": { type: "boolean" },
        "declare-link": { type: "boolean" },
        name: { type: "string" },
        worker: { type: "string" },
        "prefer-repo": { type: "string" },
        "exclude-repo": { type: "string" },
        "max-doing": { type: "string" },
        "allow-unclaimed": { type: "boolean" },
        check: { type: "boolean" },
        "group-by-milestone": { type: "boolean" },
      },
    });
  } catch (err) {
    if (isParseArgsError(err)) {
      // Mirror the unknown-command contract: clean one-liner on stderr + exit 2.
      // parseArgs runs before we know the command, but the first arg that isn't
      // a flag is the command name — surface it in the hint when we have it.
      const cmd = argv.find((a) => !a.startsWith("-"));
      const helpCmd = commandHelpHint(cmd);
      // Node's default message leaks library internals: a multi-line "argument
      // is ambiguous … use '--flag=-XYZ'" advice for a missing/dash-leading
      // value, or a verbose `. To specify a positional …` clause for an unknown
      // option. Strip both so we emit one clean kanban-styled line.
      let reason: string;
      // Missing value: parseArgs throws "Option '--x' argument is ambiguous"
      // when the next token is itself a flag (or a dash-leading value). Node's
      // own wording is jargon; write a purpose-built one-liner instead.
      const ambiguous = err.code === "ERR_PARSE_ARGS_INVALID_OPTION_VALUE"
        && err.message.includes("is ambiguous");
      if (ambiguous) {
        const flag = err.message.match(/Option '([^']+)'/)?.[1] ?? "the option";
        reason = `Option '${flag}' is missing its value (the next token is another flag). `
          + `If the value must start with a dash, pass it as ${flag}=<value>`;
      } else {
        // Keep just the first line and first clause; drop Node's verbose advice.
        reason = (err.message.split("\n")[0] ?? err.message).split(". To specify")[0] ?? err.message;
      }
      // Never emit a double-period: strip any trailing `.` before our `. Run …`.
      reason = reason.replace(/\.+$/, "");
      // For a genuine unknown-OPTION typo on a known command, name the closest
      // valid flag before the help hint — the same recovery the unknown-COMMAND
      // path already offers (`Did you mean "list"?`). Only the typo path: the
      // ambiguous/missing-value branch above is a different error, not a typo.
      if (err.code === "ERR_PARSE_ARGS_UNKNOWN_OPTION" && cmd) {
        const flag = err.message.match(/'(?:--?)?([^']+)'/)?.[1];
        const suggestion = flag ? suggestFlag(cmd, flag) : null;
        if (suggestion) console.error(`kanban: Did you mean "--${suggestion}"?`);
      }
      console.error(`kanban: ${reason}. Run \`kanban ${helpCmd}\` to see this command's flags.`);
      return 2;
    }
    throw err;
  }
  const { values, positionals } = parsed;

  if (values.version) {
    console.log(pkg.version);
    return 0;
  }

  const cmd = positionals[0];
  const topic = positionals[1];
  const helpText = resolveHelp(cmd, values.help as boolean | undefined ?? false, topic);
  if (helpText !== undefined) {
    // `kanban help <unknown-topic>` falls back to TOP_HELP but says so on
    // stderr first, so the topic isn't silently ignored (the whole point of
    // this command). `help` is not a usage error — keep exit 0, matching bare
    // `help`/no-arg. The exit-2 "Unknown command" path is for a bogus
    // *top-level* command, a distinct case.
    if (cmd === "help" && topic !== undefined && !(topic in COMMAND_HELP)) {
      console.error(`kanban: Unknown command "${topic}".\n`);
    }
    console.log(helpText);
    return 0;
  }

  // Now that the command is known, reject any globally-valid flag that this
  // specific command doesn't accept (parseArgs only catches flags NO command
  // declares). Runs after the help short-circuit so `<cmd> --help` still works.
  if (cmd !== undefined) {
    const misapplied = rejectMisappliedFlags(cmd, values);
    if (misapplied !== undefined) return misapplied;
  }

  const verbose: Verbose | undefined = values.verbose ? (m) => console.error(m) : undefined;

  try {
    return await dispatch(cmd, values, positionals, verbose);
  } catch (err) {
    // A rejected numeric flag has already printed its reason to stderr;
    // surface the exit-2 contract here (matching the unknown-flag handling).
    if (isFlagValidationError(err)) return 2;
    throw err;
  }
}

async function dispatch(
  cmd: string | undefined,
  values: Record<string, unknown>,
  positionals: string[],
  verbose: Verbose | undefined,
): Promise<number> {
  switch (cmd) {
    case "init": {
      const extra = rejectExtraPositionals(positionals, 1, "init");
      if (extra !== undefined) return extra;
      await runInit({
        nodeUrl: values["node-url"] as string | undefined,
        schemaServiceUrl: values["schema-service-url"] as string | undefined,
        nodeSocketPath: values["node-socket-path"] as string | undefined,
        bootstrapName: values.name as string | undefined,
        acceptSchemaRepin: values["accept-schema-repin"] === true,
        verbose,
      });
      return 0;
    }

    case "mcp": {
      const extra = rejectExtraPositionals(positionals, 1, "mcp");
      if (extra !== undefined) return extra;
      // Defer the MCP import so the heavyweight SDK only loads for `mcp`.
      const { startMcpServer } = await import("./mcp/server.ts");
      await startMcpServer({ verbose });
      return 0;
    }

    case "milestone": {
      const action = positionals[1];
      const ctx = loadCtx({ verbose });
      if (action === "add") {
        const slug = requirePositional(positionals[2], "milestone add <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "milestone add <slug>");
        if (extra !== undefined) return extra;
        let body = values.body as string | undefined;
        if (body === undefined) body = await readStdinBodyForAdd();
        const result = await milestoneAddCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          title: values.title as string | undefined,
          body,
          board: values.board as string | undefined,
          state: values.state as string | undefined,
          position: values.position as string | undefined,
          northStar: values["north-star"] as string | undefined,
          driver: values.driver as string | undefined,
          deps: parseTags(values.deps as string | undefined),
          proofCard: values["proof-card"] as string | undefined,
          proofStatus: values["proof-status"] as string | undefined,
          blockReason: values["block-reason"] as string | undefined,
        });
        console.log(formatMilestoneAdd(result, Boolean(values.json)));
        return 0;
      }
      if (action === "list") {
        const extra = rejectExtraPositionals(positionals, 2, "milestone list");
        if (extra !== undefined) return extra;
        const result = await milestoneListResult({
          cfg: ctx.cfg,
          node: ctx.node,
          board: values.board as string | undefined,
          state: values.state as string | undefined,
        });
        // Envelope matches fkanban_list/fkanban_search: bare arrays made silent
        // undercount look like a complete inventory (portfolio undercount
        // recurrences 2026-08-02..04). `total`/`truncated` make a future page
        // cap impossible to miss; today the list is uncapped so truncated=false.
        console.log(values.json
          ? JSON.stringify({
            milestones: result.milestones,
            total: result.milestones.length,
            truncated: false,
          }, null, 2)
          : result.text);
        return 0;
      }
      if (action === "show") {
        const slug = requirePositional(positionals[2], "milestone show <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "milestone show <slug>");
        if (extra !== undefined) return extra;
        const result = await milestoneShowResult({ cfg: ctx.cfg, node: ctx.node, slug });
        // The derived verdict rides in the SAME object as the stored claim. A
        // consumer that reads `proof_status` and stops has no way to learn the
        // evidence is gone, so the correction has to be impossible to miss by
        // reading one level deeper — not parked in a sibling command.
        console.log(values.json
          ? JSON.stringify({ ...result.milestone, proof_verdict: result.proof_verdict, proof_verdict_reason: result.proof_verdict_reason }, null, 2)
          : result.text);
        return 0;
      }
      if (action === "state") {
        const slug = requirePositional(positionals[2], "milestone state <slug> <state>");
        const state = requirePositional(positionals[3], "milestone state <slug> <state>");
        const extra = rejectExtraPositionals(positionals, 4, "milestone state <slug> <state>");
        if (extra !== undefined) return extra;
        const result = await milestoneStateCmd({ cfg: ctx.cfg, node: ctx.node, slug, state, proofStatus: values["proof-status"] as string | undefined });
        console.log(formatMilestoneState(result, Boolean(values.json)));
        return 0;
      }
      if (action === "reconcile") {
        const slug = requirePositional(positionals[2], "milestone reconcile <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "milestone reconcile <slug>");
        if (extra !== undefined) return extra;
        // `unlimited` opts out of the budget explicitly, the same word
        // `lastgit --max-concurrency` uses. `--max-repairs 0` classifies
        // without writing, which is `--dry-run` reached from the other side.
        const rawMax = values["max-repairs"] as string | undefined;
        const maxRepairs = rawMax === undefined
          ? undefined
          : rawMax.trim() === "unlimited"
            ? null
            : parseIntFlag(rawMax, "max-repairs", "milestone", { min: 0 });
        const result = await milestoneReconcileResult({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          apply: !values["dry-run"],
          maxRepairs,
          directPayloadUpsert: Boolean(values["force-milestone-card-payload-upsert"]),
        });
        // `repairs` is a carrier of what THIS invocation did, not part of the
        // reconcile read; the read's own fields come from the one shared
        // projection so this payload cannot omit what `result.text` prints.
        console.log(values.json ? JSON.stringify({ ...milestoneReconcilePayload(result), repairs: result.repairs }, null, 2) : result.text);
        return 0;
      }
      if (action === "portfolio") {
        const extra = rejectExtraPositionals(positionals, 2, "milestone portfolio");
        if (extra !== undefined) return extra;
        const result = await milestonePortfolioResult({ cfg: ctx.cfg, node: ctx.node, board: values.board as string | undefined });
        // Same completeness envelope as `milestone list --json` — see above.
        console.log(values.json
          ? JSON.stringify({
            entries: result.entries,
            total: result.entries.length,
            truncated: false,
          }, null, 2)
          : result.text);
        return 0;
      }
      if (action === "detail") {
        const slug = requirePositional(positionals[2], "milestone detail <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "milestone detail <slug>");
        if (extra !== undefined) return extra;
        const result = await milestoneDetailResult({ cfg: ctx.cfg, node: ctx.node, slug });
        console.log(values.json ? JSON.stringify({ ...result.detail, repairs: result.repairs }, null, 2) : result.text);
        return 0;
      }
      if (action === "groom") {
        const extra = rejectExtraPositionals(positionals, 2, "milestone groom");
        if (extra !== undefined) return extra;
        const result = await milestoneGroomResult({ cfg: ctx.cfg, node: ctx.node, board: values.board as string | undefined });
        if (values.json || values["json-array"]) {
          const issues = result.issues;
          console.log(values["json-array"]
            ? JSON.stringify(issues, null, 2)
            : JSON.stringify({ issues, total: issues.length, truncated: false }, null, 2));
        } else {
          console.log(result.text);
        }
        return 0;
      }
      if (action === "gap-report" || action === "gap") {
        const extra = rejectExtraPositionals(positionals, 2, "milestone gap-report");
        if (extra !== undefined) return extra;
        const result = await milestoneGapReportResult({ cfg: ctx.cfg, node: ctx.node, board: values.board as string | undefined });
        console.log(values.json ? JSON.stringify(result.report, null, 2) : result.text);
        return 0;
      }
      console.error("kanban: Usage: fkanban milestone add|list|show|state|reconcile|portfolio|detail|groom|gap-report");
      return 2;
    }

    case "version": {
      const extra = rejectExtraPositionals(positionals, 1, "version");
      if (extra !== undefined) return extra;
      // Bare `version` subcommand — an alias for the `--version` flag (humans
      // and agents reflexively type `<tool> version`). Print just the version
      // from package.json (same source as `--version`/`-V`) and exit 0.
      console.log(pkg.version);
      return 0;
    }

    case "ping": {
      const extra = rejectExtraPositionals(positionals, 1, "ping");
      if (extra !== undefined) return extra;
      return pingCommand({ json: values.json === true, verbose });
    }

    case "doctor": {
      const extra = rejectExtraPositionals(positionals, 1, "doctor");
      if (extra !== undefined) return extra;
      if (values.json) {
        // Machine-readable: collect the structured report (no human ✓/✗ lines
        // leak to stdout) and emit the SAME { ok, version, checks } shape the
        // `fkanban_doctor` MCP tool returns as structuredContent.
        const { ok, version, checks } = await runDoctorStructured({ verbose });
        console.log(JSON.stringify({ ok, version, checks }));
        return ok ? 0 : 1;
      }
      const ok = await doctor({ verbose });
      return ok ? 0 : 1;
    }

    case "which": {
      const name = positionals[1];
      if (name === undefined) {
        const report = whichReport();
        console.log(values.json ? JSON.stringify(report) : formatWhichReport(report));
        // `--check` fails on any recorded issue, not just containment: a
        // superseded build is exactly the condition a scripted check wants to
        // catch, and it satisfies `in_host_track` by construction.
        return values.check && report.issues.length > 0 ? 1 : 0;
      }
      const allowed = new Set(["kanban", "fkanban", "kanban-mcp", "fkanban-mcp", "host-track-refresh", "kanban-host-track-refresh"]);
      if (!allowed.has(name)) {
        console.error(`kanban: Unknown which target "${name}". Try: kanban | fkanban | kanban-mcp | fkanban-mcp | host-track-refresh | kanban-host-track-refresh`);
        return 2;
      }
      const extra = rejectExtraPositionals(positionals, 2, "which [kanban|fkanban|kanban-mcp|fkanban-mcp|host-track-refresh|kanban-host-track-refresh]");
      if (extra !== undefined) return extra;
      const execPath = resolveCommandPath(name);
      if (!execPath) {
        console.error(`kanban: ${name} not found on PATH`);
        return 1;
      }
      const realPath = safeRealpath(execPath);
      const match = pathWithinAnyHostTrack(realPath);
      const hostTrack = match.ok ? match.root : expectedHostTrackRoot();
      const underHostTrack = match.ok;
      if (values.json) {
        console.log(JSON.stringify({
          command: name,
          exec_path: execPath,
          real_path: realPath,
          host_track: hostTrack,
          under_host_track: underHostTrack,
          issues: underHostTrack ? [] : [`${name} does not resolve under ${hostTrack}`],
        }));
      } else {
        console.log(execPath);
      }
      return values.check && !underHostTrack ? 1 : 0;
    }

    case "add": {
      const slug = requirePositional(positionals[1], "add <slug>");
      const extra = rejectExtraPositionals(positionals, 2, "add <slug>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      // `--body` as a flag wins, and when it's present we must NOT touch stdin
      // at all: draining a stdin that never reaches EOF (a background-/agent-
      // spawned `add` that inherits but never closes the pipe) used to block
      // here indefinitely, so the card never persisted. Only consult stdin to
      // source the body when no `--body` flag was given, and even then the read
      // is bounded (see readStdinBodyForAdd) so it can't hang.
      let body = values.body as string | undefined;
      try {
        if (body === undefined) {
          body = await readStdinBodyForAdd();
        }
        // Explicit DB from org wrapper / --db / LASTDB_DB — stamp home DB on card.
        const dbLocator = ambientDbLocator(values);
        body = ensureDbHeader(body, dbLocator);
        // Validate --priority before touching the node, so a bad value reports the
        // exit-2 flag error rather than a config/node error (same as --position).
        const priority =
          values.priority !== undefined ? parsePriorityFlag(values.priority as string, "add") : undefined;
        const res = await addCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          title: values.title as string | undefined,
          board: values.board as string | undefined,
          column: values.column as string | undefined,
          assignee: values.assignee as string | undefined,
          createdBy: values["created-by"] as string | undefined,
          tags: parseTags(values.tags as string | undefined),
          deps: parseTags(values.deps as string | undefined),
          replaceDeps: values["replace-deps"] as boolean | undefined,
          surfaces: parseTags(values.surfaces as string | undefined),
          priority,
          body,
          force: values.force as boolean | undefined,
          repo: values.repo as string | undefined,
          base: values.base as string | undefined,
          kind: values.kind as string | undefined,
          blockStatus: values["block-status"] as string | undefined,
          blockReason: values["block-reason"] as string | undefined,
          northStar: values["north-star"] as string | undefined,
          milestone: values.milestone as string | undefined,
          prUrl: values["pr-url"] as string | undefined,
          branch: values.branch as string | undefined,
          dbLocator,
        });
        console.log(formatAdd(res, values.json as boolean | undefined));
        return 0;
      } catch (err) {
        // A `--deps` edge that would close a cycle is a bad-input error, not a
        // node failure: report it LOUDLY with the exit-2 contract (matching
        // `dep add`), and as a clean envelope under --json — never a half write.
        if (
          err instanceof FkanbanError &&
          (
            err.code === "dep_cycle" ||
            err.code === "missing_dependency" ||
            err.code === "deps_replace_requires_explicit" ||
            err.code === "invalid_kind" ||
            err.code === "invalid_block_status" ||
            err.code === "invalid_db_locator" ||
            err.code === "db_locator_mismatch" ||
            err.code === "body_slug_list_tripwire" ||
            err.code === "body_source_tripwire" ||
            err.code === "destructive_body_replace" ||
            err.code === "stdin_body_unavailable" ||
            err.code === "created_by_immutable"
          )
        ) {
          if (values.json) {
            console.log(formatError(err));
          } else {
            console.error(`kanban: ${err.message}`);
            if (err.hint) console.error(`  hint: ${err.hint}`);
          }
          return 2;
        }
        throw err;
      }
    }

    case "mark": {
      const slug = requirePositional(positionals[1], "mark <slug> <line>");
      const line = requirePositional(positionals[2], "mark <slug> <line>");
      const extra = rejectExtraPositionals(positionals, 3, "mark <slug> <line>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      try {
        const res = await markCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          line,
        });
        console.log(formatMark(res, values.json as boolean | undefined));
        return 0;
      } catch (err) {
        if (err instanceof FkanbanError && err.code === "invalid_mark_line") {
          if (values.json) {
            console.log(formatError(err));
          } else {
            console.error(`kanban: ${err.message}`);
            if (err.hint) console.error(`  hint: ${err.hint}`);
          }
          return 2;
        }
        throw err;
      }
    }

    case "set": {
      const slug = requirePositional(positionals[1], "set <slug>");
      const extra = rejectExtraPositionals(positionals, 2, "set <slug>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      try {
        // Never read stdin. Never accept --body. Metadata-only by construction.
        const dbLocator = ambientDbLocator(values);
        const priority =
          values.priority !== undefined ? parsePriorityFlag(values.priority as string, "set") : undefined;
        const res = await setCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          title: values.title as string | undefined,
          assignee: values.assignee as string | undefined,
          tags: parseTags(values.tags as string | undefined),
          surfaces: parseTags(values.surfaces as string | undefined),
          priority,
          force: values.force as boolean | undefined,
          repo: values.repo as string | undefined,
          base: values.base as string | undefined,
          kind: values.kind as string | undefined,
          blockStatus: values["block-status"] as string | undefined,
          blockReason: values["block-reason"] as string | undefined,
          northStar: values["north-star"] as string | undefined,
          milestone: values.milestone as string | undefined,
          prUrl: values["pr-url"] as string | undefined,
          branch: values.branch as string | undefined,
          dbLocator,
        });
        console.log(formatAdd(res, values.json as boolean | undefined));
        return 0;
      } catch (err) {
        if (
          err instanceof FkanbanError &&
          (
            err.code === "set_no_fields" ||
            err.code === "invalid_kind" ||
            err.code === "invalid_block_status" ||
            err.code === "card_not_found" ||
            err.code === "milestone_not_found" ||
            err.code === "milestone_north_star_mismatch" ||
            err.code === "milestone_board_mismatch"
          )
        ) {
          if (values.json) {
            console.log(formatError(err));
          } else {
            console.error(`kanban: ${err.message}`);
            if (err.hint) console.error(`  hint: ${err.hint}`);
          }
          return 2;
        }
        throw err;
      }
    }

    case "move": {
      const slug = requirePositional(positionals[1], "move <slug> <column>");
      const column = requirePositional(positionals[2], "move <slug> <column>");
      const extra = rejectExtraPositionals(positionals, 3, "move <slug> <column>");
      if (extra !== undefined) return extra;
      // Validate the numeric flag before touching config/node, so a bad
      // `--position` reports the exit-2 flag error rather than a config error.
      const position =
        values.position !== undefined
          ? parseIntFlag(values.position as string, "position", "move", { min: 0 })
          : undefined;
      const from = values.from as string | undefined;
      const expect = values.expect as string | undefined;
      if (from !== undefined && expect !== undefined && from !== expect) {
        console.error("kanban: --from and --expect disagree; pass only one expected column.");
        return 2;
      }
      const ctx = loadCtx({ verbose });
      try {
        const res = await moveCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          column,
          expectColumn: from ?? expect,
          position,
          force: values.force as boolean | undefined,
          dbLocator: ambientDbLocator(values),
          assignee: values.assignee as string | undefined,
          worker: values.worker as string | undefined,
          allowUnclaimed: values["allow-unclaimed"] as boolean | undefined,
        });
        console.log(formatMove(res, values.json as boolean | undefined));
        return 0;
      } catch (err) {
        if (err instanceof ClaimConflictError) {
          if (values.json) {
            console.log(JSON.stringify({ error: "claim_conflict", current: err.current, expected: err.expected }));
          } else {
            console.error(`kanban: ${err.message}`);
          }
          return 2;
        }
        throw err;
      }
    }

    case "dep": {
      const sub = positionals[1];
      if (sub !== "add" && sub !== "rm" && sub !== "remove") {
        console.error(`kanban: Unknown dep subcommand "${sub ?? ""}". Try: dep add | dep rm`);
        return 2;
      }
      const slug = requirePositional(positionals[2], "dep <add|rm> <slug> <dep>");
      const dep = requirePositional(positionals[3], "dep <add|rm> <slug> <dep>");
      const extra = rejectExtraPositionals(positionals, 4, "dep <add|rm> <slug> <dep>");
      if (extra !== undefined) return extra;
      if (sub === "add") {
        const ctx = loadCtx({ verbose });
        try {
          const res = await depAddCmd({
            cfg: ctx.cfg,
            node: ctx.node,
            slug,
            dep,
          });
          console.log(formatDep(res, values.json as boolean | undefined));
          return 0;
        } catch (err) {
          // A rejected cycle is a bad-input error, not a node failure: report it
          // LOUDLY with the exit-2 contract (like an unknown flag), and as a
          // clean machine-readable envelope under --json — never a half write.
          if (
            err instanceof FkanbanError &&
            (err.code === "dep_cycle" || err.code === "missing_dependency")
          ) {
            if (values.json) {
              console.log(formatError(err));
            } else {
              console.error(`kanban: ${err.message}`);
              if (err.hint) console.error(`  hint: ${err.hint}`);
            }
            return 2;
          }
          throw err;
        }
      }
      if (sub === "rm" || sub === "remove") {
        const ctx = loadCtx({ verbose });
        const res = await depRmCmd({ cfg: ctx.cfg, node: ctx.node, slug, dep });
        console.log(formatDep(res, values.json as boolean | undefined));
        return 0;
      }
      return 2;
    }

    case "tag": {
      const sub = positionals[1];
      if (sub !== "add" && sub !== "rm" && sub !== "remove") {
        console.error(`kanban: Unknown tag subcommand "${sub ?? ""}". Try: tag add | tag rm`);
        return 2;
      }
      const slug = requirePositional(positionals[2], "tag <add|rm> <slug> <tag...>");
      // Accept one OR MORE tags as positional rest (a card carries many).
      const tags = positionals.slice(3);
      if (tags.length === 0) {
        requirePositional(undefined, "tag <add|rm> <slug> <tag...>");
      }
      if (sub === "add") {
        const ctx = loadCtx({ verbose });
        try {
          const res = await tagAddCmd({ cfg: ctx.cfg, node: ctx.node, slug, tag: tags });
          console.log(formatTag(res, values.json as boolean | undefined));
          return 0;
        } catch (err) {
          // A reserved tag (dep:<slug> / tombstone) is a bad-input error, not a
          // node failure: report it LOUDLY with the exit-2 contract (matching
          // `dep_cycle`), and as a clean envelope under --json — never a half write.
          if (err instanceof FkanbanError && err.code === "reserved_tag") {
            if (values.json) {
              console.log(formatError(err));
            } else {
              console.error(`kanban: ${err.message}`);
              if (err.hint) console.error(`  hint: ${err.hint}`);
            }
            return 2;
          }
          throw err;
        }
      }
      if (sub === "rm" || sub === "remove") {
        const ctx = loadCtx({ verbose });
        const res = await tagRmCmd({ cfg: ctx.cfg, node: ctx.node, slug, tag: tags });
        console.log(formatTag(res, values.json as boolean | undefined));
        return 0;
      }
      return 2;
    }

    case "migrate": {
      const sub = positionals[1];
      if (sub === "area-tags") {
        const extra = rejectExtraPositionals(positionals, 2, "migrate area-tags");
        if (extra !== undefined) return extra;
        const ctx = loadCtx({ verbose });
        const res = await migrateAreaTagsCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          dryRun: values["dry-run"] as boolean | undefined,
        });
        console.log(formatMigrateAreaTags(res, values.json as boolean | undefined));
        return 0;
      }
      if (sub === "legacy-columns") {
        const extra = rejectExtraPositionals(positionals, 2, "migrate legacy-columns");
        if (extra !== undefined) return extra;
        const ctx = loadCtx({ verbose });
        const res = await migrateLegacyColumnsCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          dryRun: values["dry-run"] as boolean | undefined,
          slugs: values.slug as string[] | undefined,
        });
        console.log(formatMigrateLegacyColumns(res, values.json as boolean | undefined));
        return 0;
      }
      console.error(
        `kanban: Unknown migrate subcommand "${sub ?? ""}". Try: migrate area-tags, migrate legacy-columns`,
      );
      return 2;
    }

    case "list": {
      const extra = rejectExtraPositionals(positionals, 1, "list");
      if (extra !== undefined) return extra;
      // Validate the numeric flag before touching config/node, so a bad
      // `--limit` reports the exit-2 flag error rather than a config error.
      const limit =
        values.limit !== undefined
          ? parseIntFlag(values.limit as string, "limit", "list", { min: 1 })
          : undefined;
      const ctx = loadCtx({ verbose });
      const fullBodyList = Boolean(values["full-body"] || values.full_body);
      const out = await listCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        tag: values.tag as string | undefined,
        assignee: values.assignee as string | undefined,
        json: fullBodyList || values["json-array"] ? true : values.json as boolean | undefined,
        wide: values.wide as boolean | undefined,
        fields: parseFields(values.field),
        limit,
        all: values.all as boolean | undefined,
        fullBody: fullBodyList,
        groupByMilestone: values["group-by-milestone"] as boolean | undefined,
        jsonArray: Boolean(values["json-array"]),
      });
      console.log(out);
      return 0;
    }

    case "overlap": {
      const slug = requirePositional(positionals[1], "overlap <slug>");
      const extra = rejectExtraPositionals(positionals, 2, "overlap <slug>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      const { text, result } = await overlapCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        slug,
        json: values.json as boolean | undefined,
      });
      console.log(text);
      // `conflicts`, NOT the verdict, on purpose. The verdict changed what this
      // command SAYS; it must not change what it BLOCKS. Exiting 2 on `unknown`
      // would fail every caller on a board where — as measured — essentially
      // nothing declares surfaces. Same boundary `pickup claim` draws.
      return result.conflicts.length > 0 ? 2 : 0;
    }

    case "pickup":
    case "pickup-status":
    case "pickup-claim": {
      // Subcommand resolution:
      //   pickup status | pickup explain <slug> | pickup claim | pickup claim-v2 | pickup lanes
      //   bare `pickup` (= status, back-compat)
      //   pickup-status / pickup-claim aliases (single positional)
      let sub: "status" | "claim" | "claim-v2" | "lanes" | "explain";
      if (cmd === "pickup-status") sub = "status";
      else if (cmd === "pickup-claim") sub = "claim";
      else if (positionals[1] === undefined || positionals[1] === "status") sub = "status";
      else if (positionals[1] === "claim") sub = "claim";
      else if (positionals[1] === "claim-v2") sub = "claim-v2";
      else if (positionals[1] === "lanes") sub = "lanes";
      else if (positionals[1] === "explain") sub = "explain";
      else {
        console.error(
          `kanban: Unknown pickup subcommand "${positionals[1]}". Try: pickup status | pickup explain <slug> | pickup lanes | pickup claim | pickup claim-v2`,
        );
        return 2;
      }

      const maxPos = cmd === "pickup"
        ? (sub === "explain" ? 3 : (positionals[1] === undefined ? 1 : 2))
        : 1;
      const usage = cmd === "pickup" ? `pickup ${sub}` : cmd;
      const extra = rejectExtraPositionals(positionals, maxPos, usage);
      if (extra !== undefined) return extra;

      const ctx = loadCtx({ verbose });
      if (sub === "status") {
        console.log(await pickupStatusCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "explain") {
        const explainSlug = positionals[2];
        if (!explainSlug) {
          console.error("kanban: pickup explain requires a card slug. Usage: pickup explain <slug> [--json]");
          return 2;
        }
        console.log(await pickupExplainCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug: explainSlug,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "lanes") {
        console.log(await pickupLanesCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          board: values.board as string | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }

      if (sub === "claim-v2") {
        const unsupported = ["board", "prefer-repo", "exclude-repo", "max-doing"]
          .find((flag) => values[flag] !== undefined);
        if (unsupported) {
          console.error(`kanban: --${unsupported} does not apply to pickup claim-v2.`);
          return 2;
        }
        try {
          const result = await pickupClaimV2Result({
            cfg: ctx.cfg,
            node: ctx.node,
            worker: values.worker as string | undefined,
            dryRun: values["dry-run"] as boolean | undefined,
          });
          console.log(formatPickupClaimV2(result, values.json as boolean | undefined));
          return 0;
        } catch (err) {
          const result = pickupClaimV2Error(err);
          if (values.json) console.log(formatPickupClaimV2(result, true));
          else console.error(`kanban: ${formatPickupClaimV2(result)}`);
          return 1;
        }
      }

      const maxDoingRaw = values["max-doing"] as string | undefined;
      const maxDoing = maxDoingRaw !== undefined
        ? parseIntFlag(maxDoingRaw, "max-doing", "pickup claim", { min: 0 })
        : undefined;
      const result = await pickupClaimResult({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        worker: values.worker as string | undefined,
        preferRepo: values["prefer-repo"] !== undefined
          ? [values["prefer-repo"] as string]
          : undefined,
        excludeRepo: values["exclude-repo"] !== undefined
          ? [values["exclude-repo"] as string]
          : undefined,
        maxDoing,
        dryRun: values["dry-run"] as boolean | undefined,
      });
      console.log(formatPickupClaim(result, values.json as boolean | undefined));
      // 0 even when nothing claimed — idle is a successful outcome for agents.
      return 0;
    }

    case "groom": {
      const sub = positionals[1];
      if (!isGroomSubcommand(sub)) {
        console.error(
          `kanban: Unknown groom subcommand "${sub ?? ""}". Try: ${GROOM_SUBCOMMANDS.map((s) => `groom ${s}`).join(" | ")}`,
        );
        return 2;
      }
      // Every groom subcommand is MAINTENANCE and says so on the wire. Not just
      // the read-only sweep: a `board-cards-heal --apply` was measured emitting
      // 686 board_cards writes at avg 9.4s under the plain `kanban` label, which
      // is indistinguishable in `lastdb ops` from a user moving a card. See
      // groomOpsLabel() for the measurement and the rule.
      const ctx = loadCtx({ verbose, opsLabel: groomOpsLabel(sub) });
      if (sub === "archive-done") {
        const extra = rejectExtraPositionals(positionals, 2, "groom archive-done");
        if (extra !== undefined) return extra;
        const report = await archiveDoneResult({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          board: values.board as string | undefined,
          cutoffHours:
            values["cutoff-hours"] !== undefined
              ? parseIntFlag(values["cutoff-hours"] as string, "cutoff-hours", "groom", { min: 1 })
              : undefined,
          max:
            values.max !== undefined
              ? parseIntFlag(values.max as string, "max", "groom", { min: 1 })
              : undefined,
        });
        console.log(values.json ? JSON.stringify(report.report, null, 2) : report.text);
        // A delete that failed is the one outcome a daily sweep must not report as
        // success. The predecessor script swallowed every error and exit(0)'d, so
        // launchd logged 8 days of green while the archive grew unbounded.
        return report.report.failed > 0 ? 1 : 0;
      }
      if (sub === "parity-check") {
        const extra = rejectExtraPositionals(positionals, 2, "groom parity-check");
        if (extra !== undefined) return extra;
        const res = await parityCheckCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          json: values.json as boolean | undefined,
          board: values.board as string | undefined,
        });
        console.log(res.text);
        // Nonzero ONLY on confirmed drift, an incomplete enumeration, or a
        // flagged partition that could not be re-checked. Ordinary board churn
        // exits 0: a gate that pages on normal traffic gets muted, and then the
        // one detector for silent row loss is unstaffed again.
        return res.ok ? 0 : 1;
      }

      if (sub === "board-list-heal") {
        const extra = rejectExtraPositionals(positionals, 2, "groom board-list-heal");
        if (extra !== undefined) return extra;
        console.log(await boardListHealCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "stale-blockers") {
        const extra = rejectExtraPositionals(positionals, 2, "groom stale-blockers");
        if (extra !== undefined) return extra;
        console.log(await groomStaleBlockersCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "structured-routing") {
        const extra = rejectExtraPositionals(positionals, 2, "groom structured-routing");
        if (extra !== undefined) return extra;
        console.log(await groomStructuredRoutingCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "body-clobber-scan") {
        const extra = rejectExtraPositionals(positionals, 2, "groom body-clobber-scan");
        if (extra !== undefined) return extra;
        console.log(await groomBodyClobberScanCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "card-list-index-retire") {
        const extra = rejectExtraPositionals(positionals, 2, "groom card-list-index-retire");
        if (extra !== undefined) return extra;
        console.log(await cardListIndexRetireCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "milestone-indexes-heal") {
        const extra = rejectExtraPositionals(positionals, 2, "groom milestone-indexes-heal");
        if (extra !== undefined) return extra;
        const rawMax = values["max-repairs"] as string | undefined;
        const maxRepairs = rawMax === undefined
          ? undefined
          : rawMax.trim() === "unlimited"
            ? null
            : parseIntFlag(rawMax, "max-repairs", "groom", { min: 0 });
        const rawMaxRemovals = values["max-removals"] as string | undefined;
        const maxRemovals = rawMaxRemovals === undefined
          ? undefined
          : rawMaxRemovals.trim() === "unlimited"
            ? null
            : parseIntFlag(rawMaxRemovals, "max-removals", "groom", { min: 0 });
        const healed = await milestoneIndexesHealResult({
          cfg: ctx.cfg,
          node: ctx.node,
          board: typeof values.board === "string" ? values.board : undefined,
          apply: !values["dry-run"],
          maxRepairs,
          maxRemovals,
          directMilestoneCardPayloadUpsert: Boolean(values["force-milestone-card-payload-upsert"]),
        });
        console.log(values.json ? JSON.stringify(healed, null, 2) : healed.text);
        return 0;
      }
      if (sub === "board-cards-heal-scheduled") {
        const extra = rejectExtraPositionals(positionals, 2, "groom board-cards-heal-scheduled");
        if (extra !== undefined) return extra;
        const maxDrift =
          values["max-drift"] !== undefined
            ? parseIntFlag(values["max-drift"] as string, "max-drift", "groom", { min: 1 })
            : undefined;
        console.log(await boardCardsHealScheduledCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          board: typeof values.board === "string" ? values.board : undefined,
          maxDrift,
          dryRunOnly: values["dry-run"] as boolean | undefined,
          json: values.json as boolean | undefined,
        }));
        return 0;
      }
      if (sub === "board-cards-rekey") {
        const extra = rejectExtraPositionals(positionals, 2, "groom board-cards-rekey");
        if (extra !== undefined) return extra;
        console.log(await boardCardsRekeyCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          apply: values.apply as boolean | undefined,
          json: values.json as boolean | undefined,
          board: typeof values.board === "string" ? values.board : undefined,
        }));
        return 0;
      }
      // board-cards-heal: optional extra positionals are slugs; --slug also works.
      const slugFlag = values.slug;
      const fromFlag = Array.isArray(slugFlag)
        ? slugFlag.filter((s): s is string => typeof s === "string" && s.length > 0)
        : typeof slugFlag === "string" && slugFlag.length > 0
          ? [slugFlag]
          : [];
      const slugs = [...fromFlag, ...positionals.slice(2).filter((s) => s.length > 0)];
      const rawHealMaxRemovals = values["max-removals"] as string | undefined;
      const healMaxRemovals = rawHealMaxRemovals === undefined
        ? undefined
        : rawHealMaxRemovals.trim() === "unlimited"
          ? null
          : parseIntFlag(rawHealMaxRemovals, "max-removals", "groom", { min: 0 });
      console.log(await boardCardsHealCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        apply: values.apply as boolean | undefined,
        json: values.json as boolean | undefined,
        board: typeof values.board === "string" ? values.board : undefined,
        slugs: slugs.length > 0 ? slugs : undefined,
        maxRemovals: healMaxRemovals,
      }));
      return 0;
    }

    case "hygiene": {
      const sub = positionals[1];
      if (sub !== "orphan-bun") {
        console.error(`kanban: Unknown hygiene subcommand "${sub ?? ""}". Try: hygiene orphan-bun`);
        return 2;
      }
      const extra = rejectExtraPositionals(positionals, 2, "hygiene orphan-bun");
      if (extra !== undefined) return extra;
      const minAgeHours =
        values["min-age-hours"] !== undefined
          ? parseIntFlag(values["min-age-hours"] as string, "min-age-hours", "hygiene", { min: 0 })
          : undefined;
      const pileupThreshold =
        values["pileup-threshold"] !== undefined
          ? parseIntFlag(values["pileup-threshold"] as string, "pileup-threshold", "hygiene", { min: 1 })
          : undefined;
      console.log(await hygieneOrphanBunCmd({
        apply: Boolean(values.apply) && !values["dry-run"],
        json: values.json as boolean | undefined,
        minAgeHours,
        pileupThreshold,
      }));
      return 0;
    }

    case "rank": {
      const extra = rejectExtraPositionals(positionals, 1, "rank");
      if (extra !== undefined) return extra;
      const modeRaw = (values.mode as string | undefined)?.trim().toLowerCase();
      if (modeRaw && modeRaw !== "hard" && modeRaw !== "priority") {
        console.error(`kanban: --mode must be hard or priority (got ${modeRaw})`);
        return 2;
      }
      const ctx = loadCtx({ verbose });
      const res = await rankCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        mode: modeRaw === "priority" ? "priority" : "hard",
      });
      console.log(formatRank(res, values.json as boolean | undefined));
      return 0;
    }

    case "search": {
      const query = requirePositional(positionals[1], "search <query>");
      const extra = rejectExtraPositionals(positionals, 2, "search <query>");
      if (extra !== undefined) return extra;
      // Validate the numeric flag before touching config/node, so a bad
      // `--limit` reports the exit-2 flag error rather than a config error
      // (same contract as `list`).
      const limit =
        values.limit !== undefined
          ? parseIntFlag(values.limit as string, "limit", "search", { min: 1 })
          : undefined;
      const ctx = loadCtx({ verbose });
      const fullBodySearch = Boolean(values["full-body"] || values.full_body);
      const out = await searchCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        query,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        json: fullBodySearch || values["json-array"] ? true : values.json as boolean | undefined,
        fields: parseFields(values.field),
        limit,
        all: values.all as boolean | undefined,
        fullBody: fullBodySearch,
        jsonArray: Boolean(values["json-array"]),
        semantic: Boolean(values.semantic),
      });
      console.log(out);
      return 0;
    }

    case "gates": {
      if (values["declare-link"]) {
        const ctx = loadCtx({ verbose });
        const res = await declareGatesLink({ node: ctx.node });
        if (values.json) {
          console.log(JSON.stringify(res));
        } else {
          console.log(
            `declared ${res.app_id}/${res.schema} → ${res.canonical} (${res.resolution}; decision=${res.decision ?? res.resolution})`,
          );
        }
        return 0;
      }
      const ctx = loadAppCtx({ appId: FKANBAN_APP_ID, verbose });
      const out = await gatesCmd({
        node: ctx.node,
        json: values.json as boolean | undefined,
      });
      console.log(out);
      return 0;
    }

    case "show": {
      const slug = requirePositional(positionals[1], "show <slug>");
      const extra = rejectExtraPositionals(positionals, 2, "show <slug>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      const out = await showCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        slug,
        dbLocator: ambientDbLocator(values),
        json: values.json as boolean | undefined,
      });
      console.log(out);
      return 0;
    }

    case "rm": {
      const slug = requirePositional(positionals[1], "rm <slug>");
      const extra = rejectExtraPositionals(positionals, 2, "rm <slug>");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      const res = await rmCmd({ cfg: ctx.cfg, node: ctx.node, slug });
      console.log(formatRm(res, values.json as boolean | undefined));
      return 0;
    }

    case "board": {
      const sub = positionals[1];
      if (sub !== undefined && sub !== "create" && sub !== "list" && sub !== "rm") {
        console.error(`kanban: Unknown board subcommand "${sub}". Try: board create | board list | board rm`);
        return 2;
      }
      if (sub === "create") {
        const slug = requirePositional(positionals[2], "board create <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "board create <slug>");
        if (extra !== undefined) return extra;
        const ctx = loadCtx({ verbose });
        try {
          const res = await boardCreateCmd({
            cfg: ctx.cfg,
            node: ctx.node,
            slug,
            title: values.title as string | undefined,
            columns: parseTags(values.columns as string | undefined),
            body: values.body as string | undefined,
          });
          console.log(formatBoardCreate(res, values.json as boolean | undefined));
          return 0;
        } catch (err) {
          // A `--columns` list with a duplicate name is a bad-input error, not a
          // node failure: report it LOUDLY with the exit-2 contract (matching
          // `dep add` / `dep_cycle`), and as a clean envelope under --json —
          // never a half write.
          if (err instanceof FkanbanError && err.code === "dup_columns") {
            if (values.json) {
              console.log(formatError(err));
            } else {
              console.error(`kanban: ${err.message}`);
              if (err.hint) console.error(`  hint: ${err.hint}`);
            }
            return 2;
          }
          throw err;
        }
      }
      if (sub === "list" || sub === undefined) {
        const extra = rejectExtraPositionals(positionals, sub === undefined ? 1 : 2, "board list");
        if (extra !== undefined) return extra;
        const ctx = loadCtx({ verbose });
        const out = await boardListCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          json: values.json || values["json-array"] ? true : undefined,
          jsonArray: Boolean(values["json-array"]),
        });
        console.log(out);
        return 0;
      }
      if (sub === "rm") {
        const slug = requirePositional(positionals[2], "board rm <slug>");
        const extra = rejectExtraPositionals(positionals, 3, "board rm <slug>");
        if (extra !== undefined) return extra;
        const ctx = loadCtx({ verbose });
        const res = await boardRmCmd({
          cfg: ctx.cfg,
          node: ctx.node,
          slug,
          force: values.force as boolean | undefined,
        });
        console.log(formatBoardRm(res, values.json as boolean | undefined));
        return 0;
      }
      return 2;
    }

    default:
      console.error(`kanban: Unknown command "${cmd}".`);
      // Source the candidate set from COMMAND_HELP so it can never drift from
      // the documented/dispatched commands. When the typo is close to a known
      // command (`lst`→`list`, `ad`→`add`), name it before the help wall — the
      // recovery every dev already expects from git/cargo/npm/gh. A genuinely
      // unrelated token (`frobnicate`) yields no suggestion and falls back to
      // the full help unchanged.
      {
        const suggestion = cmd ? suggestClosest(cmd, Object.keys(COMMAND_HELP)) : null;
        if (suggestion) console.error(`kanban: Did you mean "${suggestion}"?`);
      }
      console.error("");
      console.log(TOP_HELP);
      return 2;
  }
}

function requirePositional(value: string | undefined, usage: string): string {
  if (!value || value.length === 0) {
    throw new FkanbanError({ code: "missing_arg", message: `Missing argument — usage: kanban ${usage}` });
  }
  return value;
}

function ambientDbLocator(values: Record<string, unknown>): string | undefined {
  return (
    (values.db as string | undefined)?.trim() ||
    process.env.LASTDB_DB?.trim() ||
    undefined
  );
}

function resolveCommandPath(name: string): string | undefined {
  const proc = spawnSync("sh", ["-c", `command -v ${name}`], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const out = proc.stdout.trim();
  return proc.status === 0 && out.length > 0 ? out : undefined;
}

function safeRealpath(path: string): string {
  try {
    return fs.realpathSync(path);
  } catch {
    return path;
  }
}

/** Stamp `Db: <locator>` when org/kanban --db (or LASTDB_DB) provides a write target. */
/**
 * Stamp a `Db:` header onto a body that is ALREADY being written.
 *
 * When `body` is undefined this must stay undefined: inventing `"Db: …"` from
 * an ambient LASTDB_DB / `--db` turns a metadata-only `add` into a full-body
 * replace (empty brief + Db header), which is how NS/MS backfill loops can
 * destroy GOAL/END STATE briefs without ever passing `--body`. Structured
 * `db` still lands via `applyDbLocatorForWrite` on the card row; the body
 * header is only for intentional body writes (create or explicit replace).
 */
export function ensureDbHeader(body: string | undefined, dbLocator: string | undefined): string | undefined {
  if (body === undefined) return undefined;
  if (!dbLocator || dbLocator.length === 0) return body;
  return writeBodyHeader(body, "Db", dbLocator);
}

function rejectExtraPositionals(positionals: string[], max: number, usage: string): number | undefined {
  if (positionals.length <= max) return undefined;
  const extras = positionals.slice(max).map((arg) => `"${arg}"`).join(" ");
  console.error(`kanban: Too many arguments: ${extras}. Usage: kanban ${usage}`);
  return 2;
}

// Write `data` to a raw fd, looping until every byte is accepted. `console.log`
// is asynchronous (non-blocking) when stdout is a PIPE — the opposite of a
// file/TTY, where it's synchronous — and `process.exit()` tears the process
// down (as does Bun on an empty event loop) WITHOUT draining that async pipe
// buffer. The tail is then dropped at a 64 KB boundary, so a large
// `list --json` / `board` reaches a piped consumer (an agent capturing stdout,
// `| jq`, …) as truncated, unterminated JSON. A SYNCHRONOUS fd write blocks
// until the bytes are handed off, so the data is already out the door before we
// exit. The loop handles partial writes and a non-blocking fd (EAGAIN) by
// retrying until the consumer drains.
function writeAllSync(fd: number, data: string): void {
  const buf = Buffer.from(data, "utf8");
  let off = 0;
  while (off < buf.length) {
    try {
      off += fs.writeSync(fd, buf, off, buf.length - off);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EAGAIN") continue;
      throw err;
    }
  }
}

type CaptureSentryException = (error: unknown, tags?: Record<string, string>) => Promise<void>;

async function initCliSentry(): Promise<CaptureSentryException> {
  if (!process.env.OBS_SENTRY_DSN?.trim()) {
    return async () => {};
  }
  const sentry = await import("./observability/sentry.ts");
  await sentry.initSentry({
    service: "fkanban-cli",
    env: {
      ...process.env,
      OBS_SENTRY_RELEASE: process.env.OBS_SENTRY_RELEASE ?? `fkanban@${pkg.version}`,
    },
  });
  return sentry.captureSentryException;
}

// Route ALL CLI output through the synchronous writer. We override `console`
// directly, NOT `process.stdout.write`: in Bun, `console.log` writes to the fd
// natively and does NOT delegate to `process.stdout.write`, so patching the
// stream is a no-op. `format` reproduces console's normal arg handling (%s,
// space-joining). Scoped to the CLI entry only — the MCP stdio server is a
// separate entrypoint and is untouched.
//
// Output now flushes synchronously, so `process.exit()` is safe (and necessary
// — `add` keeps stdin open, so falling back to a natural event-loop exit would
// HANG until stdin EOFs; the explicit exit terminates regardless).
if (import.meta.main) {
  console.log = (...args: unknown[]): void => writeAllSync(1, format(...args) + "\n");
  console.error = (...args: unknown[]): void => writeAllSync(2, format(...args) + "\n");

  const argv = process.argv.slice(2);
  let captureTopLevel: CaptureSentryException = async () => {};
  const dispatch =
    argv[0] === "add"
      ? main(argv)
      : initCliSentry()
        .then((capture) => {
          captureTopLevel = capture;
          return main(argv);
        });

  dispatch
    .then((code) => process.exit(code))
    .catch(async (err) => {
      if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
        console.error(`kanban: ${err.message}`);
      } else if (err instanceof FkanbanError) {
        console.error(`kanban: ${err.message}`);
        if (err.hint) console.error(`  hint: ${err.hint}`);
        // A missing required argument is a usage error, like an unknown
        // command or a bad flag — exit 2 ("bad invocation"). Every other
        // FkanbanError (card_not_found, service_unreachable, card_blocked, …)
        // is a genuine operational failure and stays exit 1.
        process.exit(["missing_arg", "invalid_db_locator", "db_locator_mismatch"].includes(err.code) ? 2 : 1);
      } else {
        await captureTopLevel(err, { entrypoint: "cli", top_level: "true" });
        console.error(`kanban: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    });
}
