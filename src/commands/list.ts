// `fkanban list` — render a board (default board unless --board) as columns
// of cards. Broad `--json` reads default to bounded body previews.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  CARD_DISPLAY_FIELDS,
  CARD_LIST_FIELDS,
  blockedSlugSet,
  boardTerminalMap,
  depStatus,
  ensureColumn,
  findBoard,
  hydrateCardBodies,
  listBoards,
  listCardsByColumn,
  listCardsForDisplay,
  listCardsOnBoard,
  listDependencyStatusesForCards,
  listOtherBoardCardsForFooter,
  listMilestones,
  requireBoard,
  sortCards,
  type Card,
  type Board,
} from "../record.ts";
import { BOARD_CARDS_DEP_SEED_FIELDS } from "../board-cards.ts";
import {
  capPerColumn,
  previewCardBodies,
  renderBoard,
  buildMilestoneCardGroups,
  renderBoardGroupedByMilestone,
  renderWideTable,
  resolveLimits,
  type RenderOptions,
} from "../board.ts";
import { fieldProjectionNeedsFullCards, renderFieldProjection } from "../field_projection.ts";
import { fkanbanInvocation } from "../mcp/register.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";
import { type CardDetail } from "./show.ts";

// Cards shown per column before the rest collapse to a "… N more" line.
// Comfortably above a healthy active column; trims an unbounded `done`.
export const DEFAULT_COLUMN_LIMIT = 12;

/**
 * Above this many off-set dep slugs, `list --column` resolves 🔒 by scanning the
 * terminal column instead of point-reading each slug.
 *
 * The two reads scale on different axes, which is the whole reason to choose:
 * the scan is flat in k and linear in the size of an append-only archive that
 * only grows; the point-reads are flat in the archive and linear in k. Measured
 * on the live `default` board 2026-08-02 (138 `done` rows, interleaved reps,
 * probe-dep-seed-vs-point.ts):
 *
 * | k (off-set deps) | scan   | point-reads | winner        |
 * |------------------|--------|-------------|---------------|
 * | 1  (`todo`)      | 303ms  | 21ms        | point, 14.5x  |
 * | 7  (`backlog`)   | 375ms  | 237ms       | point, 1.6x   |
 *
 * ~34ms per point-read against ~2.7ms per archive row puts the crossover near
 * k ≈ rows/13 ≈ 11 here, so 12 is that crossover at today's board — a balance
 * point, not a constant of nature. It is deliberately NOT scaled by archive size
 * (which would cost a read to learn) because the fallback above the threshold is
 * exactly the behavior that shipped before this: the choice can match today or
 * beat it, never lose to it. As `done` grows the true crossover rises and a
 * fixed 12 gets conservative — in the direction that keeps the guard honest.
 *
 * This replaces a design justified by "a rows=1 Card point-read averages ~2s"
 * (concurrency.ts, 2026-07-29, node 0.23.1 HashGroup warm-cap). Re-measured
 * 2026-08-02 that read is ~21–34ms. The design was dodging a cost that had
 * already gone away, and paying an unbounded archive scan to do it.
 */
export const DEP_SEED_POINT_READ_MAX = 12;

// How many other-board names the multi-board footer enumerates inline before
// collapsing the remainder to a `+K more` tail — keeps the hint a single line.
export const OTHER_BOARDS_FOOTER_LIMIT = 5;

// One-line footer pointing a dev at OTHER boards that hold live cards, so a
// card created on a non-default board (e.g. `add x --board roadmap`) is
// discoverable from the default `list` view instead of seeming to vanish.
// Pure: derives counts from the already-fetched cross-board card set (no extra
// node read) so it's unit-testable and `list.ts`'s only node read stays the
// existing one. Returns "" (no footer) when no OTHER board has a live card —
// a dev on a single board sees nothing. `cards` must already be the live
// (non-tombstoned) set, as `listCards` returns. `viewedBoard` is the board
// being rendered; its own cards are excluded. The other-board count is an
// unfiltered live-card count (it ignores any --tag/--column/--assignee that
// narrow the CURRENT view) — "these other boards have cards" is the useful
// navigation signal, independent of the current filter.
// `unreadable` names boards whose partition could not be read at all. They are
// reported SEPARATELY from the counts rather than omitted, because "this board
// has no cards" and "this board could not be read" are different facts and the
// footer is the only place the second one would ever surface. Omitting them
// would make an unreadable board indistinguishable from an empty one — the
// failure mode `listOtherBoardCardsForFooter` exists to avoid.
export function otherBoardsFooter(
  cards: Card[],
  viewedBoard: string,
  invocation: string,
  unreadable: string[] = [],
): string {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (c.board === viewedBoard) continue;
    counts.set(c.board, (counts.get(c.board) ?? 0) + 1);
  }
  const warn = unreadable.filter((slug) => slug !== viewedBoard).sort();
  const warnLine = warn.length > 0
    ? `⚠ ${warn.length} board${warn.length === 1 ? "" : "s"} could not be read: ${warn.join(", ")}. ` +
      `Card counts above exclude ${warn.length === 1 ? "it" : "them"}; run \`${invocation} doctor\`.`
    : "";
  if (counts.size === 0) return warnLine;

  const boards = [...counts.entries()].sort(([a], [b]) => a.localeCompare(b));
  const n = boards.length;
  const shown = boards.slice(0, OTHER_BOARDS_FOOTER_LIMIT);
  const hidden = n - shown.length;
  const list = shown.map(([slug, count]) => `${slug} (${count})`).join(", ");
  const tail = hidden > 0 ? `, +${hidden} more` : "";
  const noun = n === 1 ? "board has" : "boards have";
  // `counts.size > 0` guarantees a first entry; the `?? ""` only satisfies the
  // compiler's index-access check (noUncheckedIndexedAccess) and never fires.
  const hintSlug = boards[0]?.[0] ?? "";
  const hint =
    `ℹ ${n} other ${noun} cards: ${list}${tail}. View with \`${invocation} list --board ${hintSlug}\`.`;
  return warnLine ? `${hint}\n${warnLine}` : hint;
}

export type ListOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
  // Exact filters — tag is a membership test, assignee an equality test. Both
  // are distinct from `search`'s fuzzy substring match. A tag/assignee need not
  // pre-exist; an unmatched value renders an empty board, never an error.
  tag?: string;
  assignee?: string;
  json?: boolean;
  wide?: boolean;
  fields?: string[];
  // Per-column cap (defaults to DEFAULT_COLUMN_LIMIT). `all` removes the cap.
  limit?: number;
  all?: boolean;
  // Fetch a body-free card set (CARD_DISPLAY_FIELDS) instead of full bodies.
  // The text board render + filters never read `body`, so the CLI text path sets
  // this to avoid dragging every card's multi-paragraph spec over the wire. Left
  // unset (full bodies) by the `--json` CLI path and the MCP tool, which DO
  // surface bodies (the MCP previews/inlines them). The returned `cards` array
  // then carries empty `body` strings — safe only when no caller reads them.
  displayOnly?: boolean;
  // CLI compatibility escape hatch: `--full-body` asks for the historical
  // unpreviewed JSON surface. MCP has its own `full_body` option.
  fullBody?: boolean;
  groupByMilestone?: boolean;
};

// Both the human text and the structured (`--json`) payload, built from a
// single board+cards read. `listCmd` (CLI) returns one or the other; the MCP
// tool returns both, so it computes the data once and hands the structured
// `cards` array straight to `structuredContent`.
//
// `cards` is the full filtered set. Callers decide whether to apply an
// implicit text cap, an explicit `--limit`, or the CLI broad-JSON safe default.
// `jsonLimit`: 0 = no explicit cap (`--all` also resolves to 0); >0 = explicit
// `--limit` cap.
//
// Each returned card is enriched with its resolved dependency status (`blocked`,
// `blockedBy`, `missingDeps`) — the SAME shape `show --json` emits — so the
// structured/JSON surface tells a machine consumer which cards are blocked
// without re-deriving dep status or a per-card `show`. The text render is
// unchanged (it consumes only the 🔒 marker via `blockedSlugSet`).
export async function listResult(
  opts: ListOptions,
): Promise<{ text: string; cards: CardDetail[]; board: Board; jsonLimit: number; milestones?: Awaited<ReturnType<typeof listMilestones>> }> {
  const boardSlug = opts.board ?? "default";
  // An explicitly-passed board must exist — a typo'd name should error loudly
  // (matching `add`), not silently render an empty default-column board. The
  // no-`--board` path defaults to `default`, which always exists, so it stays
  // on the cheap `findBoard` lookup with no extra read on the hot path.
  const board =
    opts.board !== undefined
      ? await requireBoard(opts.node, opts.cfg, boardSlug)
      : await findBoard(opts.node, opts.cfg, boardSlug);

  const resolvedBoard = board ?? {
    slug: boardSlug,
    title: boardSlug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "",
    updated_at: "",
  };
  // An explicitly-passed `--column` must be a real column on the resolved
  // board — a typo'd name should error loudly (matching `move`/`add` via the
  // shared `ensureColumn`), not silently filter every card out and render an
  // empty board. Only checked when `--column` is set, so the no-`--column` hot
  // path is unchanged.
  if (opts.column !== undefined) ensureColumn(opts.column, resolvedBoard.columns);

  // Body-free fetch on the text path (`displayOnly`): the render + filters need
  // CARD_DISPLAY_FIELDS, never `body`.
  //
  // Latency bar. The 2026-07-29 figures below were taken on node 0.23.1 under
  // HashGroup thrash and are kept because they are why this path is shaped the
  // way it is — but the third line no longer holds, and a stale number that
  // rules out a whole read shape is worth re-timing before trusting:
  //   - BoardCards HashRangePrefix one column ≈ 1–2s
  //   - Full board HashKey partition ≈ 2–7s (798 rows)
  //   - Card HashKey point-read ≈ 0.7–10s each  ← re-measured 2026-08-02: 21–34ms
  //
  // Hot path — **no UNBOUNDED reads on list**:
  //   - With --column: BoardCards prefix for that column. Deps that point off
  //     that column are then resolved by whichever seed is cheaper for the
  //     number of them, k — see DEP_SEED_POINT_READ_MAX. k is free to compute
  //     from rows already in hand, so the choice costs nothing to make.
  //   - Without --column: one full board partition (all columns already present).
  // show/move call the same listDependencyStatusesForCards for their
  // authoritative check, so at k <= threshold list now agrees with them by
  // construction rather than by two paths happening to concur.
  // Text → CARD_DISPLAY_FIELDS (~half the BoardCards atoms). JSON / structured
  // → CARD_LIST_FIELDS (body-free product fields). Never fieldsFor("card") —
  // that includes body, which BoardCards does not store and which forced the
  // wide 24-field partition projection by accident.
  const visibleFields = opts.displayOnly ? CARD_DISPLAY_FIELDS : CARD_LIST_FIELDS;
  // Terminal map first — needed for dep seed column and blocked rendering.
  // Keep the board list itself: the footer needs the other boards' slugs, and
  // re-deriving them would be a second Board read for data already in hand.
  const allBoards = await listBoards(opts.node, opts.cfg);
  const boardTerminal = boardTerminalMap(allBoards);
  const terminalCol = boardTerminal.get(boardSlug) ?? "done";

  let boardCards: Card[];
  let cards: Card[];
  if (opts.column) {
    const columnOnly = await listCardsByColumn(
      opts.node,
      opts.cfg,
      opts.column,
      visibleFields,
      boardSlug,
    );
    cards = sortCards(
      columnOnly.filter(
        (c) =>
          (!opts.tag || c.tags?.includes(opts.tag)) &&
          (!opts.assignee || c.assignee === opts.assignee),
      ),
    );
    // How many dep edges actually point OFF the column we just read? That is
    // the only thing the seed has to resolve, it is known for free here (deps
    // are already on the rows in hand), and until now it was never asked.
    const inColumn = new Set(columnOnly.map((c) => c.slug));
    const offSetDeps = [...new Set(cards.flatMap((c) => c.deps ?? []))].filter(
      (slug) => slug.length > 0 && !inColumn.has(slug),
    );
    if (offSetDeps.length === 0 || opts.column === terminalCol) {
      // Nothing to resolve. Note the gate this replaced fired on "any visible
      // card has any dep" — so a column whose deps all point WITHIN itself read
      // the whole archive to learn what it already had.
      boardCards = columnOnly;
    } else if (offSetDeps.length <= DEP_SEED_POINT_READ_MAX) {
      // Resolve exactly those slugs. `listDependencyStatusesForCards` is the
      // same path `show`/`move` use for their authoritative check, so this makes
      // the list agree with them rather than diverge.
      boardCards = await listDependencyStatusesForCards(
        opts.node,
        opts.cfg,
        cards,
        columnOnly,
      );
    } else {
      // Seed finished-dep columns without a full-board HashKey scan.
      //
      // These rows are never rendered — they exist only so `depStatus` can see
      // that a dependency has finished. So ask for the seven fields that verdict
      // reads, not all 24: the terminal column is an append-only archive, and at
      // the wide projection listing an ACTIVE column cost 1299ms of archive read
      // against 416ms here (live board, 567 `done` rows).
      const terminalCards = await listCardsByColumn(
        opts.node,
        opts.cfg,
        terminalCol,
        visibleFields,
        boardSlug,
        { projection: BOARD_CARDS_DEP_SEED_FIELDS },
      );
      const bySlug = new Map<string, Card>();
      for (const c of columnOnly) bySlug.set(c.slug, c);
      for (const c of terminalCards) bySlug.set(c.slug, c);
      boardCards = [...bySlug.values()];
    }
  } else {
    boardCards = await listCardsOnBoard(opts.node, opts.cfg, boardSlug, visibleFields);
    cards = sortCards(
      boardCards.filter(
        (c) =>
          c.board === boardSlug &&
          (!opts.tag || c.tags?.includes(opts.tag)) &&
          (!opts.assignee || c.assignee === opts.assignee),
      ),
    );
  }
  // Dep / 🔒 status from BoardCards rows only — never Card fan-out on list.
  const allCards = boardCards;

  // Resolve blocked status against ALL live cards so cross-board deps count.
  // Text render cap: an explicit `--limit` (always >= 1 after flag parsing),
  // `--all` removes the cap (0), and the no-flag default falls back to
  // DEFAULT_COLUMN_LIMIT so a long column collapses to a "… N more" line.
  const { textLimit, jsonLimit } = resolveLimits(opts, DEFAULT_COLUMN_LIMIT);
  // Print the empty-board first-touch hint in the form that actually runs for
  // THIS dev — the `fkanban` shim if it's on PATH, else `bun run src/cli.ts`
  // (the fresh-clone default). Mirrors how init injects its Next-steps
  // invocation (PR #69); board.ts stays pure and defaults to bare `fkanban`.
  const renderOpts: RenderOptions = {
    blocked: blockedSlugSet(cards, allCards, boardTerminal),
    limit: textLimit,
    invocation: fkanbanInvocation(),
  };
  if (opts.column) renderOpts.column = opts.column;
  // Enrich each filtered card with its dependency status (resolved against ALL
  // live cards so cross-board deps count), matching show's CardDetail shape.
  const enriched: CardDetail[] = cards.map((c) => {
    const status = depStatus(c, allCards, boardTerminal);
    return { ...c, blocked: status.blocked, blockedBy: status.blockedBy, missingDeps: status.missing };
  });
  // `jsonLimit` only reflects an explicit `--limit`; the CLI broad-JSON default
  // cap is applied in listCmd so MCP structuredContent keeps its own contract.
  // Multi-board discoverability footer (column-text path only). Skip for
  // --json / --wide / --column (wide never shows the footer; column is a
  // focused view).
  //
  // Read only the boards the footer actually reports on. The cross-board read
  // this replaced re-fetched the partition already on screen — 783 of the
  // board's 829 rows, at the wide projection, discarded by the reducer's first
  // line — and it did so on the hottest query fkanban makes. See
  // listOtherBoardCardsForFooter. Falls back to the cross-board read if
  // BoardCards cannot serve it, so a footer never silently disappears.
  let footer = "";
  if (!opts.column && !opts.json && !opts.wide) {
    const others = await listOtherBoardCardsForFooter(
      opts.node,
      opts.cfg,
      boardSlug,
      allBoards,
    );
    // `null` means BoardCards cannot serve the footer read at all (unconfigured
    // schema) — fall back to the cross-board path. A per-board FAILURE is a
    // different thing: those slugs come back in `unreadable` and get named in
    // the footer instead of failing the command. See
    // listOtherBoardCardsForFooter.
    const cross = others?.cards ??
      (await listCardsForDisplay(opts.node, opts.cfg, { boards: allBoards }));
    footer = otherBoardsFooter(cross, boardSlug, fkanbanInvocation(), others?.unreadable ?? []);
  }
  const milestones = opts.groupByMilestone ? (await listMilestones(opts.node, opts.cfg, { boards: allBoards })).filter((milestone) => milestone.board === boardSlug) : undefined;
  const rendered = milestones
    ? renderBoardGroupedByMilestone(resolvedBoard, buildMilestoneCardGroups(cards, milestones), renderOpts)
    : renderBoard(resolvedBoard, cards, renderOpts);
  const text = footer ? `${rendered}\n${footer}\n` : rendered;
  return { text, cards: enriched, board: resolvedBoard, jsonLimit, milestones };
}

export async function listCmd(opts: ListOptions): Promise<string> {
  const projectionFields = opts.fields ?? [];
  // The default text path never renders card bodies, so fetch the body-free
  // display set there. `--json`, `--wide`, and full-field projections expose
  // structured fields, so they intentionally use the full card fetch path.
  const displayOnly =
    !opts.json &&
    !opts.wide &&
    (projectionFields.length === 0 || !fieldProjectionNeedsFullCards(projectionFields));
  const { text, cards, board, jsonLimit, milestones } = await listResult({ ...opts, displayOnly });
  if (projectionFields.length > 0) {
    const out = jsonLimit > 0 ? capPerColumn(board, cards, jsonLimit, opts.column) : cards;
    return renderFieldProjection(out, projectionFields);
  }
  if (!opts.json && opts.wide) {
    const out = capPerColumn(
      board,
      cards,
      jsonLimit > 0 ? jsonLimit : Number.MAX_SAFE_INTEGER,
      opts.column,
    );
    return renderWideTable(out);
  }
  if (!opts.json) return text;
  const broadJson = opts.column === undefined;
  const implicitJsonDefault = !opts.all && !opts.fullBody && opts.limit === undefined;
  const implicitJsonLimit =
    implicitJsonDefault && broadJson ? DEFAULT_COLUMN_LIMIT : 0;
  const effectiveJsonLimit = jsonLimit > 0 ? jsonLimit : implicitJsonLimit;
  const capped = effectiveJsonLimit > 0 ? capPerColumn(board, cards, effectiveJsonLimit, opts.column) : cards;
  // Bodies are never loaded for board-wide list (BoardCards thin projection).
  // --full-body is the explicit opt-in to the expensive surface: it suppresses
  // the implicit page cap (see `implicitJsonDefault`), so it point-gets one body
  // per card it RETURNS — proportional to the requested data, not amplified.
  // Callers bound it with --limit, which caps before hydration.
  const withBodies = opts.fullBody
    ? await hydrateCardBodies(opts.node, opts.cfg, capped)
    : capped;
  const out = broadJson || implicitJsonDefault || opts.fullBody
    ? previewCardBodies(withBodies, opts.fullBody ?? false)
    : withBodies;
  if (opts.groupByMilestone && milestones) {
    return JSON.stringify({ groups: buildMilestoneCardGroups(out, milestones) }, null, 2);
  }
  return JSON.stringify(out, null, 2);
}

export function summarize(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.column] = (out[c.column] ?? 0) + 1;
  return out;
}
