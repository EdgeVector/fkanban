// `fkanban list` — render a board (default board unless --board) as columns
// of cards. Broad `--json` reads default to bounded body previews.

import { type NodeClient } from "../client.ts";
import { requireMultiKey } from "../multi-key.ts";
import { namedColumnHeads } from "../named-column-heads.ts";
import { type Config } from "../config.ts";
import {
  BODY_OMITTED,
  blockedSlugSet,
  depStatus,
  ensureColumn,
  findBoard,
  findCardsWithFields,
  hydrateCardBodies,
  listBoards,
  listDependencyStatusesForCards,
  listMilestones,
  requireBoard,
  sortCards,
  type Card,
  type Board,
} from "../record.ts";
import {
  headKeyId,
  type HeadWindow,
  type HeadCard,
} from "../column-window.ts";
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
import { type WarnSink, partialHeadNotice, renderJsonPage, warnIfTruncated } from "../truncation_notice.ts";
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

const COLUMN_HEAD_PARTIAL_LINE =
  "Column list is partial. This view keeps at most 20 cards in a column.";

// Same bound as HASH_RANGE_KEYS_PER_READ. The head shows at most 20 cards
// per column, so one board is one batch. A longer key list still chunks.
const HEAD_DETAIL_KEYS_PER_READ = 256;

const HEAD_DETAIL_FIELDS = [
  "slug",
  "tags",
  "updated_at",
  "repo",
  "db",
  "base",
  "block_status",
  "block_reason",
  "north_star",
  "surfaces",
  "milestone",
  "pr_url",
  "branch",
  "created_by",
];

function mergeHeadDetail(card: Card, truth: Card): Card {
  return {
    ...card,
    updated_at: truth.updated_at,
    done_at: truth.done_at,
    first_doing_at: truth.first_doing_at,
    repo: truth.repo,
    db: truth.db,
    base: truth.base,
    block_status: truth.block_status,
    block_reason: truth.block_reason,
    north_star: truth.north_star,
    surfaces: truth.surfaces,
    milestone: truth.milestone || card.milestone,
    pr_url: truth.pr_url,
    branch: truth.branch,
    created_by: truth.created_by ?? card.created_by,
  };
}

async function hydrateListedHeadCards(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
): Promise<Card[]> {
  if (cards.length === 0) return cards;
  const truths: Array<Card | null> = [];
  for (let i = 0; i < cards.length; i += HEAD_DETAIL_KEYS_PER_READ) {
    const slugs = cards.slice(i, i + HEAD_DETAIL_KEYS_PER_READ).map((card) => card.slug);
    truths.push(...(await findCardsWithFields(node, cfg, slugs, HEAD_DETAIL_FIELDS)));
  }
  const bySlug = new Map<string, Card>();
  for (const truth of truths) {
    if (truth) bySlug.set(truth.slug, truth);
  }
  return cards.map((card) => {
    const truth = bySlug.get(card.slug);
    return truth ? mergeHeadDetail(card, truth) : card;
  });
}

function cardFromHead(board: string, column: string, card: HeadCard): Card {
  const out: Card = {
    slug: card.slug,
    title: card.title,
    body: "",
    board,
    column: card.column || column,
    position: card.position,
    assignee: card.assignee,
    tags: card.tags,
    deps: card.deps,
    surfaces: [],
    created_at: card.created_at,
    updated_at: "",
    done_at: "",
    first_doing_at: "",
    repo: "",
    db: "",
    base: "",
    kind: card.kind,
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: card.milestone || undefined,
    pr_url: "",
    branch: "",
  };
  out[BODY_OMITTED] = true;
  return out;
}

function cardsFromHeads(board: string, columns: readonly string[], heads: ReadonlyMap<string, HeadWindow>): Card[] {
  const out: Card[] = [];
  for (const column of columns) {
    const head = heads.get(headKeyId(board, column));
    for (const card of head?.cards ?? []) out.push(cardFromHead(board, column, card));
  }
  return out;
}

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
  // Legacy bare-array stdout (`--json-array`). Default is the
  // `{cards, total, truncated}` envelope. When true, re-emit the stderr
  // truncation notice on an implicit cap so that path stays non-silent.
  jsonArray?: boolean;
  // Sink for the capped-page notice on the CLI `--json-array` path (defaults to
  // `console.error`, matching record.ts's `opts.warn ?? console.error`
  // convention). Injected by tests so the notice is asserted, not printed.
  // The default envelope path does not warn on stderr (truncation is structural).
  warn?: WarnSink;
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
): Promise<{ text: string; cards: CardDetail[]; board: Board; jsonLimit: number; partial: boolean; milestones?: Awaited<ReturnType<typeof listMilestones>> }> {
  requireMultiKey(opts.cfg);
  const boardSlug = opts.board ?? "default";















  const boardRead =
    opts.board !== undefined
      ? requireBoard(opts.node, opts.cfg, boardSlug)
      : findBoard(opts.node, opts.cfg, boardSlug);
  // Terminal map needs the board list; the footer needs the other boards' slugs.
  // Re-deriving either would be a second Board read for data already in hand.
  const boardsRead = listBoards(opts.node, opts.cfg);
  // Each column uses its named key. The window is derived from current records.
  const readHeads = (keys: Parameters<typeof namedColumnHeads>[2]) => namedColumnHeads(opts.node, opts.cfg, keys);
  const listedColumns = opts.column ? [opts.column] : [...DEFAULT_COLUMNS];
  const headsRead = readHeads(
    listedColumns.map((column) => ({ board: boardSlug, column })),
  );






  const [boardSettled, boardsSettled, headsSettled] = await Promise.allSettled([
    boardRead,
    boardsRead,
    headsRead,
  ]);
  if (boardSettled.status === "rejected") throw boardSettled.reason;
  if (boardsSettled.status === "rejected") throw boardsSettled.reason;
  const board = boardSettled.value;
  const allBoards = boardsSettled.value;

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

  if (headsSettled.status === "rejected") throw headsSettled.reason;
  const columns = opts.column ? [opts.column] : resolvedBoard.columns;
  let heads = headsSettled.value;
  const extraColumns = columns.filter((column) => !listedColumns.includes(column));
  if (extraColumns.length > 0) {
    const more = await readHeads(
      extraColumns.map((column) => ({ board: boardSlug, column })),
    );
    heads = new Map([...heads, ...more]);
  }
  const columnCards = cardsFromHeads(boardSlug, columns, heads);
  let cards = sortCards(
    columnCards.filter(
      (c) =>
        (!opts.tag || c.tags?.includes(opts.tag)) &&
        (!opts.assignee || c.assignee === opts.assignee),
    ),
  );
  // Plain text uses the head. JSON, wide, field projections, and MCP read the
  // shown cards so block_status, repo, and the done clock are not blank.
  if (opts.displayOnly !== true) {
    cards = await hydrateListedHeadCards(opts.node, opts.cfg, cards);
  }
  // Off-list deps are exact Card keys. The list does not read the whole column.
  const allCards = await listDependencyStatusesForCards(
    opts.node,
    opts.cfg,
    cards,
    columnCards,
  );
  const listPartial = columns.some((column) => heads.get(headKeyId(boardSlug, column))?.partial === true);

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
    blocked: blockedSlugSet(cards, allCards),
    limit: textLimit,
    invocation: fkanbanInvocation(),
  };
  if (opts.column) renderOpts.column = opts.column;
  // Enrich each filtered card with its dependency status (resolved against ALL
  // live cards so cross-board deps count), matching show's CardDetail shape.
  const enriched: CardDetail[] = cards.map((c) => {
    const status = depStatus(c, allCards);
    return { ...c, blocked: status.blocked, blockedBy: status.blockedBy, missingDeps: status.missing };
  });
  // `jsonLimit` only reflects an explicit `--limit`; the CLI broad-JSON default
  // cap is applied in listCmd so MCP structuredContent keeps its own contract.
  // Multi-board discoverability footer (column-text path only). Skip for
  // --json / --wide / --column (wide never shows the footer; column is a
  // focused view).
  //
  // Other boards' current column windows. A failed read
  // does not: the current board still renders, and the footer names the boards
  // that were not read. Each requested column uses its own named key.
  let footer = "";
  if (!opts.column && !opts.json && !opts.wide) {
    const otherBoards = allBoards.filter((board) => board.slug !== boardSlug);
    const pairs = otherBoards.flatMap((board) =>
      board.columns.map((column) => ({ board: board.slug, column })),
    );
    let cross: Card[] = [];
    let unreadable: string[] = [];
    try {
      const otherHeads = await readHeads(pairs);
      cross = otherBoards.flatMap((board) => cardsFromHeads(board.slug, board.columns, otherHeads));
    } catch {
      cross = [];
      unreadable = otherBoards.map((board) => board.slug);
    }
    footer = otherBoardsFooter(cross, boardSlug, fkanbanInvocation(), unreadable);
  }
  const milestones = opts.groupByMilestone ? (await listMilestones(opts.node, opts.cfg, { boards: allBoards })).filter((milestone) => milestone.board === boardSlug) : undefined;
  const rendered = milestones
    ? renderBoardGroupedByMilestone(resolvedBoard, buildMilestoneCardGroups(cards, milestones), renderOpts)
    : renderBoard(resolvedBoard, cards, renderOpts);
  const partialLine = listPartial ? `${COLUMN_HEAD_PARTIAL_LINE}\n` : "";
  const text = `${partialLine}${rendered}${footer ? `\n${footer}\n` : ""}`;
  return { text, cards: enriched, board: resolvedBoard, jsonLimit, partial: listPartial, milestones };
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
  // done_at and first_doing_at are display fields, and the head does not store
  // them. A projection that names either one still reads the shown cards.
  const projectionNeedsHeadDetail = projectionFields.some((field) => {
    const name = field.trim();
    return name === "done_at" || name === "first_doing_at";
  });
  const { text, cards, board, jsonLimit, partial, milestones } = await listResult({
    ...opts,
    displayOnly: displayOnly && !projectionNeedsHeadDetail,
  });
  const partialNote = partial ? `${COLUMN_HEAD_PARTIAL_LINE}\n` : "";
  if (projectionFields.length > 0) {
    const out = jsonLimit > 0 ? capPerColumn(board, cards, jsonLimit, opts.column) : cards;
    return `${partialNote}${renderFieldProjection(out, projectionFields)}`;
  }
  if (!opts.json && opts.wide) {
    const out = capPerColumn(
      board,
      cards,
      jsonLimit > 0 ? jsonLimit : Number.MAX_SAFE_INTEGER,
      opts.column,
    );
    return `${partialNote}${renderWideTable(out)}`;
  }
  if (!opts.json) return text;
  const broadJson = opts.column === undefined;
  const implicitJsonDefault = !opts.all && !opts.fullBody && opts.limit === undefined;
  const implicitJsonLimit =
    implicitJsonDefault && broadJson ? DEFAULT_COLUMN_LIMIT : 0;
  const effectiveJsonLimit = jsonLimit > 0 ? jsonLimit : implicitJsonLimit;
  const capped = effectiveJsonLimit > 0 ? capPerColumn(board, cards, effectiveJsonLimit, opts.column) : cards;
  const total = cards.length;
  // Bare-array escape hatch keeps the stderr notice; the envelope path reports
  // truncation structurally and must not also noise fd 2.
  if (opts.jsonArray && implicitJsonLimit > 0 && jsonLimit === 0) {
    warnIfTruncated("list", capped.length, total, opts.warn ?? console.error);
  }





  const withBodies = opts.fullBody
    ? await hydrateCardBodies(opts.node, opts.cfg, capped)
    : capped;
  const out = broadJson || implicitJsonDefault || opts.fullBody
    ? previewCardBodies(withBodies, opts.fullBody ?? false)
    : withBodies;
  if (opts.groupByMilestone && milestones) {
    const groups = buildMilestoneCardGroups(out, milestones);
    if (opts.jsonArray) return JSON.stringify({ groups, partial }, null, 2);
    return JSON.stringify({ groups, total, truncated: out.length < total || partial, partial }, null, 2);
  }
  // The bare array has no partial field. The grouped object above already does.
  if (opts.jsonArray && partial) {
    (opts.warn ?? console.error)(partialHeadNotice("list"));
  }
  return renderJsonPage("cards", out, total, { jsonArray: opts.jsonArray, partial });
}
