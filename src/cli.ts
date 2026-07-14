#!/usr/bin/env bun
// fkanban CLI entrypoint — a kanban board over fold_db.
//
// `--verbose` (global) echoes each HTTP request + response.

import { parseArgs, format } from "node:util";
import * as fs from "node:fs";

import pkg from "../package.json" with { type: "json" };
import { FkanbanError, type Verbose } from "./client.ts";
import { ConfigMissingError, ConfigInvalidError } from "./config.ts";
import { loadAppCtx, loadCtx } from "./context.ts";
import { runInit } from "./commands/init.ts";
import { addCmd } from "./commands/add.ts";
import { markCmd } from "./commands/mark.ts";
import { ClaimConflictError, moveCmd } from "./commands/move.ts";
import { listCmd } from "./commands/list.ts";
import { rankCmd } from "./commands/rank.ts";
import { searchCmd } from "./commands/search.ts";
import { showCmd } from "./commands/show.ts";
import { rmCmd } from "./commands/rm.ts";
import { boardCreateCmd, boardListCmd, boardRmCmd } from "./commands/board.ts";
import { pickupStatusCmd } from "./commands/pickup_status.ts";
import { overlapCmd } from "./commands/overlap.ts";
import { groomStaleBlockersCmd } from "./commands/groom.ts";
import { hygieneOrphanBunCmd } from "./commands/hygiene.ts";
import { depAddCmd, depRmCmd } from "./commands/dep.ts";
import { tagAddCmd, tagRmCmd } from "./commands/tag.ts";
import { migrateAreaTagsCmd } from "./commands/migrate.ts";
import { normalizePriority, PRIORITY_TIERS, writeBodyHeader, type PriorityTier } from "./record.ts";
import { doctor, runDoctorStructured } from "./commands/doctor.ts";
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
  formatError,
} from "./format.ts";

export const TOP_HELP = `kanban — a kanban board over fold_db

Usage:
  kanban <command> [options]

Global:
  --db <locator>       write-target DB (lastdb://personal | lastdb://org/<slug>/<db>);
                       also read from env LASTDB_DB (set by org kanban ...)

Commands:
  init                 bootstrap a node + declare private schemas + seed default board
                       (--node-url --schema-service-url --node-socket-path --name)
  add <slug>           create/update a card (--title --board --column --assignee --tags --deps --replace-deps --surfaces --priority P0-P3 --body, --force past a block)
  mark <slug> <line>   append one marker line to a card body, idempotently
  move <slug> <col>    move a card to a column (--from/--expect COL claim guard, --position N, --force past a block)
  dep add <slug> <dep> add a dependency edge (card <slug> depends on <dep>)
  dep rm <slug> <dep>  remove a dependency edge
  tag add <slug> <tag> add one or more tags to a card (incremental; keeps the rest)
  tag rm <slug> <tag>  remove one or more tags from a card
  list                 render cards as columns or --wide table (--board --column --tag --assignee --wide --field --json --full-body --limit N --all)
  overlap <slug>       report declared surface conflicts with doing/review cards in the same repo
  pickup status        classify active cards by pickup eligibility (--json)
  groom stale-blockers dry-run/apply cleanup for stale generated blocker metadata (--apply --json)
  hygiene orphan-bun   dry-run/apply PPID-1 Bun helper reaper for kanban/gstack
                       (--apply --min-age-hours N --pileup-threshold N --json)
  rank                 reorder a column by card priority so pickup works urgent cards first (--board --column, default todo)
  search <query>       find cards by text across slug/title/body/tags/assignee (--board --column --field --limit --all --json)
  gates                list open human gates via fbrain's linked open-decisions ledger (--json; --declare-link setup)
  show <slug>          print one card in detail, incl. deps + blocked state (--json)
  rm <slug>            soft-delete a card (refuses if live cards depend on it)
  board create <slug>  create/update a board (--title --columns a,b,c)
  board list           list boards (--json)
  board rm <slug>      soft-delete a board (always refuses default; refuses
                       live cards unless --force)
  migrate area-tags    one-time: re-derive pickup area:* tags across active cards (--dry-run)
  doctor               health-check the local setup (--json)
  mcp                  start an MCP server over stdio
  version              print the kanban version and exit (alias of --version)
  help                 print this help

Run \`kanban help <command>\` or \`kanban <command> --help\` for command details.

Global flags:
  --verbose            echo HTTP requests + responses
  --json               machine-readable output (add/move/dep/rm/board create/
                       board rm echo the write result as JSON; read commands too)
  --help, -h           print this help
  --version, -V        print the kanban version and exit

Dependencies: a card with deps is 🔒 blocked until each dep card reaches its
board's final column. \`move\`/\`add\` into doing/review/done — or the board's own
final column — refuses a blocked card unless --force.

Columns (default board): backlog → todo → doing → review → done`;

const HELP_FOOTER = "Run `kanban help` for all commands.";

function withFooter(body: string): string {
  return `${body}\n\n${HELP_FOOTER}`;
}

// Per-command usage. `kanban <cmd> --help` (or `-h`) prints the matching
// entry instead of the global TOP_HELP firehose. Every command listed in
// TOP_HELP must have an entry here (a unit test enforces they can't drift).
export const COMMAND_HELP: Record<string, string> = {
  init: withFooter(`kanban init — bootstrap a node + declare private schemas + seed the default board

Usage:
  kanban init [options]

Options:
  --node-url <url>            base URL of the fold_db node (e.g. http://127.0.0.1)
  --schema-service-url <url>  schema_service URL recorded in config for diagnostics
                              (not used for private fkanban schema init)
  --node-socket-path <path>   unix socket of the node, instead of --node-url
  --name <name>               display name to seed the default board with

Private schema setup is performed by the NODE through Mini's local
/api/apps/declare-schema route. The CLI never contacts --schema-service-url;
that URL is only recorded in ~/.kanban/config.json for diagnostics (it shows
up in \`kanban doctor\`). If init fails with app_schema_declare_unsupported,
upgrade the node to a Mini build with local app-schema declaration.

Example:
  kanban init --node-url http://127.0.0.1 --name "Tom's board"`),

  add: withFooter(`kanban add — create or update a card (idempotent by slug)

Usage:
  kanban add <slug> [options]            # --body also reads stdin if piped

Options:
  --title <text>        card title
  --board <slug>        board to place the card on (default: default)
  --column <col>        column to place the card in (default: first column)
  --assignee <name>     who owns the card
  --tags a,b,c          comma-separated tags
  --deps a,b            comma-separated slugs this card depends on
                        On update, this requires --replace-deps when it changes
                        existing deps. Missing cards and edges that would form
                        a cycle are rejected, exit 2.
  --replace-deps        explicitly replace/clear deps on an existing card
  --surfaces a,b        comma-separated repo-relative path globs or subsystem
                        names this card expects to touch
  --priority <P0-P3>    card priority (P0 = most urgent … P3 = least); stored as
                        a p0–p3 tag. \`kanban rank\` orders a column by this so
                        fkanban-pickup works urgent cards first.
  --body <text>         card body (Markdown); replaces the whole body.
                        Also reads the body from piped stdin when no --body
                        is given (recommended for multi-line/Markdown bodies).
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
  --pr-url <url>        the PR driving this card (when in flight)
  --branch <name>       worktree/feature branch

Multi-line bodies — pipe via stdin, don't inline:
  For any multi-line/Markdown body, PIPE it on stdin instead of passing
  --body "$(cat …)" or --body "$VAR". A body interpolated into the command
  line is re-evaluated by the shell: backticks and $(...) inside the body
  run as commands ((eval): command not found: <word>) and the written body
  is silently corrupted/truncated. The stdin path never puts the body on the
  command line, so it is verbatim and immune.
  printf '%s' "$BODY" | kanban add ship-login --title "Ship login" --column todo

Example:
  kanban add ship-login --title "Ship login" --column todo --priority P1 --tags auth`),

  mark: withFooter(`kanban mark — append one marker line to an existing card body

Usage:
  kanban mark <slug> "<line>" [--json]

Appends the line only if it is not already present. This preserves the card's
board, column, tags, kind, and other metadata; it never replaces the full body.
Use this for routine annotations instead of \`add --body\`.

Options:
  --json                echo the write result as JSON

Example:
  kanban mark ship-login "NEEDS-HUMAN: missing DONE-WHEN"`),

  move: withFooter(`kanban move — move a card to another column

Usage:
  kanban move <slug> <column> [options]

Options:
  --from <col>          claim guard: only move if the card is currently in col
  --expect <col>        alias for --from
  --position <N>        insert at position N within the column
  --force               explicit operator override for dependency blocks and
                        default/todo pickup-readiness policy
  --json                echo the write result as JSON

Example:
  kanban move ship-login doing --from todo`),

  dep: withFooter(`kanban dep — manage dependency edges between cards

Usage:
  kanban dep add <slug> <dep>     # card <slug> depends on <dep>
  kanban dep rm  <slug> <dep>     # remove the edge

Options:
  --json                echo the write result as JSON

A card with deps is 🔒 blocked until each dep card reaches its board's final column.
Dependency edges are stored in the card's canonical deps field, not in tags or
body. The dependency card must already exist, and edges that would form a cycle
(direct or transitive) are rejected (exit 2).

Example:
  kanban dep add ui api`),

  tag: withFooter(`kanban tag — add or remove tags on a card, incrementally

Usage:
  kanban tag add <slug> <tag> [tag...]   # union into the card's tags
  kanban tag rm  <slug> <tag> [tag...]   # remove from the card's tags

Options:
  --json                echo the write result as JSON

Unlike \`add --tags a,b,c\` (which REPLACES the whole tag list), \`tag add\`/
\`tag rm\` edit one tag at a time without disturbing the rest. Adding a tag the
card already carries is a no-op; removing one it lacks warns but succeeds.
Reserved tags (\`dep:<slug>\` legacy dependency tags, the delete tombstone) are
rejected — use \`dep\`/\`rm\`. Dependency edges live in the separate deps field.

Example:
  kanban tag add ship-login p1
  kanban tag rm  ship-login blocked`),

  overlap: withFooter(`kanban overlap — report declared file-surface conflicts

Usage:
  kanban overlap <slug> [--json]

Compares the candidate card's surfaces against every doing/review card with the
same repo. Surfaces come from the structured field or a body header:
  Surfaces: src/cli.ts, src/mcp/**

Missing surfaces are adoption warnings, not conflicts: the command exits 0 when
the answer is unknown. Declared conflicts exit 2 and name the matching patterns.

Example:
  kanban overlap ship-login`),

  list: withFooter(`kanban list — render a board as columns of cards

Usage:
  kanban list [options]

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
  --all                 show every card (no per-column cap; --json default)
  --json                machine-readable output (unlimited unless --limit set)
  --full-body, --full_body
                        compatibility alias for --json with complete bodies

Example:
  kanban list --board default --limit 10
  kanban list --full-body
  kanban list --tag kanban --column doing
  kanban list --column todo --field slug
  kanban list --wide --column doing`),

  pickup: withFooter(`kanban pickup — report what can be picked up now

Usage:
  kanban pickup status [--json]

Classifies every active (non-terminal) card as pickup-ready, blocked-on-dependency,
human-gated, malformed-routing, parked/non-work, collision, or stale-metadata.
This is a read-only board hygiene report; it does not start pickup work.

Options:
  --json                machine-readable { scanned, ready, counts, cards }

Example:
  kanban pickup status
  kanban pickup status --json`),

  rank: withFooter(`kanban rank — reorder a column by card priority

Usage:
  kanban rank [options]

Reassigns each work card's \`position\` in priority order so \`fkanban-pickup\` (which
drains the LOWEST position first) works the most urgent cards first. Priority is
read from a \`Priority: P<n>\` body header (wins) or a p0–p3 tag (set via
\`add --priority\`); cards with neither sort as P2 (normal). Ties break by
created_at (oldest first). Registry/tracker/umbrella/meta cards are skipped so
grouping cards do not affect pickup order. Idempotent — re-running an
already-ranked column writes nothing. This is the step the board groomer runs
after promoting cards into \`todo\`.

Options:
  --board <slug>        board whose column to rank (default: default)
  --column <col>        column to rank (default: todo — the column pickup reads)
  --json                echo the resulting order as JSON

Example:
  kanban rank
  kanban rank --board roadmap --column backlog`),

  search: withFooter(`kanban search — find cards by text across slug/title/body/tags/assignee

Usage:
  kanban search <query> [options]        # multi-word queries are AND-matched

Options:
  --board <slug>        restrict to one board
  --column <col>        restrict to one column
  --field <name>        project one field as TSV; repeat for multiple fields
                        (e.g. --field slug --field pr)
  --limit <N>           cap rendered matches (applies to text AND --json)
  --all                 show every match (no cap; --json default)
  --json                machine-readable output (complete unless --limit set)

Example:
  kanban search "auth p1"
  kanban search auth --limit 5
  kanban search auth --all`),

  gates: withFooter(`kanban gates — list open human gates from fbrain's open-decisions ledger

Usage:
  kanban gates [options]

Options:
  --declare-link       ask the node to declare fkanban's local Reference schema
                       as a read-only LINK to fbrain's shared Reference canonical
                       (setup/proof step; requires the dev node matcher)
  --json               machine-readable open gate array

Plain \`kanban gates\` is read-only: it queries kanban's app-local Reference
schema, which the node translates through the persisted read-only LINK. It does
not copy, write, clear, or own gate state.

On app-isolation nodes, set FKANBAN_APP_CAPABILITY to a granted kanban
CapabilityToken blob so the node treats the request as the fkanban app.

Example:
  kanban gates
  kanban gates --declare-link`),

  show: withFooter(`kanban show — print one card in detail (deps + blocked state)

Usage:
  kanban show <slug> [options]

Options:
  --json                machine-readable output
  --board <slug>        accepted as a compatibility no-op; card slugs are global

Example:
  kanban show ship-login`),

  rm: withFooter(`kanban rm — soft-delete a card (refuses while live cards depend on it)

Usage:
  kanban rm <slug> [options]

Options:
  --json                echo the write result as JSON

Deletion uses the node's native tombstone path. It refuses if any live card still
depends on the target; remove or retarget those dependency edges first.

Example:
  kanban rm ship-login`),

  board: withFooter(`kanban board — create/update, list, or remove boards

Usage:
  kanban board create <slug> [options]
  kanban board list [options]
  kanban board rm <slug> [options]

Options:
  --title <text>        board title (create)
  --columns a,b,c       comma-separated column names (create)
  --body <text>         board body (create)
  --force               soft-delete a board with live cards (rm); refuses if
                        outside live cards depend on cards being deleted
  --json                machine-readable output

Examples:
  kanban board create sprint --title "Sprint 1" --columns todo,doing,done
  kanban board rm sprint`),

  migrate: withFooter(`kanban migrate — one-time board data migrations

Usage:
  kanban migrate area-tags [--dry-run] [--json]

Subcommands:
  area-tags            re-derive the pickup \`area:*\` tags on every active
                       (non-done, non-tombstoned) card and rewrite only the
                       cards whose derived set changed. Clears stale boilerplate
                       tags (\`area:fkanban-agent\`, \`area:fbrain-got\`, …) minted
                       by the pre-#130 prose-scraping bug on cards that were
                       never re-written since. Re-derives TAGS only — never
                       touches column, assignee, or an intentional block hold.

Flags:
  --dry-run            report the per-card tag deltas without writing anything
  --json               machine-readable { scanned, changed, skippedDone, cards }

Example:
  kanban migrate area-tags --dry-run   # preview
  kanban migrate area-tags             # apply`),

  groom: withFooter(`kanban groom — board hygiene reports and safe repairs

Usage:
  kanban groom stale-blockers [--apply] [--json]

Subcommands:
  stale-blockers       detect stale generated pickup/blocker metadata, malformed
                       Repo header lines, stale area-overlap holds, and
                       human/parking candidates.

Flags:
  --apply              rewrite only generated boilerplate and structured fields
                       proven stale. Omitted by default: dry-run only.
  --json               machine-readable { scanned, candidates, changed, cards }

Examples:
  kanban groom stale-blockers
  kanban groom stale-blockers --apply`),

  hygiene: withFooter(`kanban hygiene — local machine-hygiene helpers

Usage:
  kanban hygiene orphan-bun [--apply] [--min-age-hours N] [--pileup-threshold N] [--json]

Subcommands:
  orphan-bun           list or signal stale PPID-1 Bun helper processes whose
                       command path matches the explicit kanban/gstack
                       allowlist: kanban MCP, gstack browse server, and
                       gstack terminal-agent. Dry-run by default.

Flags:
  --apply              send SIGTERM to matching candidates. Omitted by default:
                       dry-run only.
  --min-age-hours N    minimum elapsed age, default 24
  --pileup-threshold N flag a same-parent Bun pileup above N processes, default 100
  --json               machine-readable report

Examples:
  kanban hygiene orphan-bun
  kanban hygiene orphan-bun --apply`),

  doctor: withFooter(`kanban doctor — health-check the local setup

Usage:
  kanban doctor [--json]

Verifies config, node reachability, and resolved schemas. Exits non-zero on
any failed check.

Flags:
  --json               machine-readable { ok, checks } report`),

  mcp: withFooter(`kanban mcp — start an MCP server over stdio

Usage:
  kanban mcp

Exposes the board to MCP clients (e.g. Claude). Speaks JSON-RPC on
stdin/stdout; not meant to be run interactively.

Register with Claude Code (the \`--\` separates \`claude mcp add\` flags from
the command):
  claude mcp add fkanban -- kanban mcp

Run \`kanban doctor\` to print the exact \`claude mcp add\` line for your setup
(it resolves the shim-on-PATH vs bun-entrypoint form automatically).`),

  version: withFooter(`kanban version — print the kanban version and exit

Usage:
  kanban version

An alias of the \`--version\`/\`-V\` flag: prints just the version (from
package.json) to stdout and exits 0.

Example:
  kanban version`),
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
  const help = cmd in COMMAND_HELP ? `${cmd} --help` : "help";
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
    const help = cmd in COMMAND_HELP ? `${cmd} --help` : "help";
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
const UNIVERSAL_FLAGS = new Set(["help", "version", "verbose", "json", "db"]);

// Per-command allowed flags (beyond UNIVERSAL_FLAGS), keyed by the same command
// names as COMMAND_HELP. Derived from each command's `--help` text and the
// flags its dispatch branch actually reads. Commands absent here (e.g. `mark`, `show`,
// `rm`, `doctor`, `mcp`, `version`) accept only the universal flags.
const COMMAND_FLAGS: Record<string, Set<string>> = {
  init: new Set(["node-url", "schema-service-url", "node-socket-path", "name"]),
  add: new Set([
    "title", "board", "column", "assignee", "tags", "deps", "replace-deps", "surfaces", "priority", "body", "force",
    "repo", "base", "kind", "block-status", "block-reason", "north-star", "pr-url", "branch",
  ]),
  // move ignores --board on purpose: slugs are global, so it can't scope a
  // lookup. Leaving it out makes `move <slug> doing --board X` an exit-2 error.
  move: new Set(["from", "expect", "position", "force"]),
  list: new Set(["board", "column", "tag", "assignee", "wide", "field", "limit", "all", "full-body", "full_body"]),
  rank: new Set(["board", "column"]),
  search: new Set(["board", "column", "field", "limit", "all"]),
  gates: new Set(["declare-link"]),
  // show accepts --board as a compatibility no-op because agents often copy it
  // from list/add flows. Card slugs are global, so dispatch still ignores it.
  show: new Set(["board"]),
  // board's subcommands read title/columns/body (create) and force (rm).
  board: new Set(["title", "columns", "body", "force"]),
  // migrate's one-time subcommands take --dry-run to preview without writing.
  migrate: new Set(["dry-run"]),
  groom: new Set(["apply", "dry-run"]),
  hygiene: new Set(["apply", "dry-run", "min-age-hours", "pileup-threshold"]),
};

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
        db: { type: "string" },
        title: { type: "string" },
        board: { type: "string" },
        column: { type: "string" },
        tag: { type: "string" },
        assignee: { type: "string" },
        tags: { type: "string" },
        deps: { type: "string" },
        "replace-deps": { type: "boolean" },
        surfaces: { type: "string" },
        priority: { type: "string" },
        repo: { type: "string" },
        base: { type: "string" },
        kind: { type: "string" },
        "block-status": { type: "string" },
        "block-reason": { type: "string" },
        "north-star": { type: "string" },
        "pr-url": { type: "string" },
        branch: { type: "string" },
        force: { type: "boolean" },
        "dry-run": { type: "boolean" },
        apply: { type: "boolean" },
        "min-age-hours": { type: "string" },
        "pileup-threshold": { type: "string" },
        body: { type: "string" },
        columns: { type: "string" },
        from: { type: "string" },
        expect: { type: "string" },
        position: { type: "string" },
        limit: { type: "string" },
        "full-body": { type: "boolean" },
        full_body: { type: "boolean" },
        field: { type: "string", multiple: true },
        wide: { type: "boolean" },
        all: { type: "boolean" },
        "node-url": { type: "string" },
        "schema-service-url": { type: "string" },
        "node-socket-path": { type: "string" },
        "declare-link": { type: "boolean" },
        name: { type: "string" },
      },
    });
  } catch (err) {
    if (isParseArgsError(err)) {
      // Mirror the unknown-command contract: clean one-liner on stderr + exit 2.
      // parseArgs runs before we know the command, but the first arg that isn't
      // a flag is the command name — surface it in the hint when we have it.
      const cmd = argv.find((a) => !a.startsWith("-"));
      const helpCmd = cmd && cmd in COMMAND_HELP ? `${cmd} --help` : "help";
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

    case "version": {
      const extra = rejectExtraPositionals(positionals, 1, "version");
      if (extra !== undefined) return extra;
      // Bare `version` subcommand — an alias for the `--version` flag (humans
      // and agents reflexively type `<tool> version`). Print just the version
      // from package.json (same source as `--version`/`-V`) and exit 0.
      console.log(pkg.version);
      return 0;
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
            err.code === "stdin_body_unavailable"
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
      console.error(`kanban: Unknown migrate subcommand "${sub ?? ""}". Try: migrate area-tags`);
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
        json: fullBodyList ? true : values.json as boolean | undefined,
        wide: values.wide as boolean | undefined,
        fields: parseFields(values.field),
        limit,
        all: values.all as boolean | undefined,
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
      return result.conflicts.length > 0 ? 2 : 0;
    }

    case "pickup":
    case "pickup-status": {
      const usage = cmd === "pickup" ? "pickup status" : "pickup-status";
      if (cmd === "pickup" && positionals[1] !== "status") {
        console.error(`kanban: Unknown pickup subcommand "${positionals[1] ?? ""}". Try: pickup status`);
        return 2;
      }
      const extra = rejectExtraPositionals(positionals, cmd === "pickup" ? 2 : 1, usage);
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      console.log(await pickupStatusCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        json: values.json as boolean | undefined,
      }));
      return 0;
    }

    case "groom": {
      const sub = positionals[1];
      if (sub !== "stale-blockers") {
        console.error(`kanban: Unknown groom subcommand "${sub ?? ""}". Try: groom stale-blockers`);
        return 2;
      }
      const extra = rejectExtraPositionals(positionals, 2, "groom stale-blockers");
      if (extra !== undefined) return extra;
      const ctx = loadCtx({ verbose });
      console.log(await groomStaleBlockersCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        apply: values.apply as boolean | undefined,
        json: values.json as boolean | undefined,
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
      const ctx = loadCtx({ verbose });
      const res = await rankCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
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
      const out = await searchCmd({
        cfg: ctx.cfg,
        node: ctx.node,
        query,
        board: values.board as string | undefined,
        column: values.column as string | undefined,
        json: values.json as boolean | undefined,
        fields: parseFields(values.field),
        limit,
        all: values.all as boolean | undefined,
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
        const out = await boardListCmd({ cfg: ctx.cfg, node: ctx.node, json: values.json as boolean | undefined });
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

/** Stamp `Db: <locator>` when org/kanban --db (or LASTDB_DB) provides a write target. */
export function ensureDbHeader(body: string | undefined, dbLocator: string | undefined): string | undefined {
  if (!dbLocator || dbLocator.length === 0) return body;
  const b = body ?? "";
  return writeBodyHeader(b, "Db", dbLocator);
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

  main(process.argv.slice(2))
    .then((code) => process.exit(code))
    .catch((err) => {
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
        console.error(`kanban: ${err instanceof Error ? err.message : String(err)}`);
      }
      process.exit(1);
    });
}
