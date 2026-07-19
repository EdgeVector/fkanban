// `fkanban list` — render a board (default board unless --board) as columns
// of cards. Broad `--json` reads default to bounded body previews.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  CARD_DISPLAY_FIELDS,
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
  requireBoard,
  sortCards,
  type Card,
  type Board,
} from "../record.ts";
import {
  capPerColumn,
  previewCardBodies,
  renderBoard,
  renderWideTable,
  resolveLimits,
  type RenderOptions,
} from "../board.ts";
import { fieldProjectionNeedsFullCards, renderFieldProjection } from "../field_projection.ts";
import { fkanbanInvocation } from "../mcp/register.ts";
import { DEFAULT_COLUMNS, fieldsFor } from "../schemas.ts";
import { type CardDetail } from "./show.ts";

// Cards shown per column before the rest collapse to a "… N more" line.
// Comfortably above a healthy active column; trims an unbounded `done`.
export const DEFAULT_COLUMN_LIMIT = 12;

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
export function otherBoardsFooter(
  cards: Card[],
  viewedBoard: string,
  invocation: string,
): string {
  const counts = new Map<string, number>();
  for (const c of cards) {
    if (c.board === viewedBoard) continue;
    counts.set(c.board, (counts.get(c.board) ?? 0) + 1);
  }
  if (counts.size === 0) return "";

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
  return `ℹ ${n} other ${noun} cards: ${list}${tail}. View with \`${invocation} list --board ${hintSlug}\`.`;
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
): Promise<{ text: string; cards: CardDetail[]; board: Board; jsonLimit: number }> {
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
  // CARD_DISPLAY_FIELDS, never `body`. Hot path is always board-scoped BoardCards
  // (one HashKey / HashRangePrefix query) — never fan out empty stress boards.
  // With --column: BoardCards prefix on this board, then point-read deps only.
  // Without --column: this board's partition; multi-board footer uses a separate
  // thin cross-board sample only when other boards exist.
  const visibleFields = opts.displayOnly ? CARD_DISPLAY_FIELDS : fieldsFor("card");
  const columnCards = opts.column
    ? await listCardsByColumn(opts.node, opts.cfg, opts.column, visibleFields, boardSlug)
    : null;
  // Board-scoped BoardCards (one partition). Avoids querying empty stress boards.
  // Pass visibleFields so legacy (no BoardCards hash) stubs still omit body on text path.
  const boardCards = columnCards
    ? null
    : await listCardsOnBoard(opts.node, opts.cfg, boardSlug, visibleFields);
  const allCards = columnCards
    ? await listDependencyStatusesForCards(opts.node, opts.cfg, columnCards)
    : boardCards!;
  // Terminal column per board (board slug → last column) so a dep counts as
  // done at its OWN board's final column, not only a literal `done`. Resolved
  // against ALL boards because blocked status spans cross-board deps below.
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  const cards = sortCards(
    (columnCards ?? allCards).filter(
      (c) =>
        c.board === boardSlug &&
        (!opts.column || c.column === opts.column) &&
        (!opts.tag || c.tags?.includes(opts.tag)) &&
        (!opts.assignee || c.assignee === opts.assignee),
    ),
  );

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
  // Multi-board discoverability footer (column-text path only). Board-scoped
  // main read no longer includes other boards' cards, so one thin cross-board
  // list when rendering the default text board. Skip for --json / --wide /
  // --column (wide never shows the footer; column is the hot single-query path).
  let footer = "";
  if (!columnCards && !opts.json && !opts.wide) {
    const cross = await listCardsForDisplay(opts.node, opts.cfg);
    footer = otherBoardsFooter(cross, boardSlug, fkanbanInvocation());
  }
  const text = footer
    ? `${renderBoard(resolvedBoard, cards, renderOpts)}\n${footer}\n`
    : renderBoard(resolvedBoard, cards, renderOpts);
  return { text, cards: enriched, board: resolvedBoard, jsonLimit };
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
  const { text, cards, board, jsonLimit } = await listResult({ ...opts, displayOnly });
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
  // --full-body hydrates ONLY the capped page via point-get, not N over the
  // whole board before limit.
  const withBodies = opts.fullBody
    ? await hydrateCardBodies(opts.node, opts.cfg, capped)
    : capped;
  const out = broadJson || implicitJsonDefault || opts.fullBody
    ? previewCardBodies(withBodies, opts.fullBody ?? false)
    : withBodies;
  return JSON.stringify(out, null, 2);
}

export function summarize(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.column] = (out[c.column] ?? 0) + 1;
  return out;
}
