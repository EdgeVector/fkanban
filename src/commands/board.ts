// `fkanban board create|list|rm` — manage boards.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import {
  boardToFields,
  deleteCardRecord,
  findBoard,
  findCard,
  listBoards,
  listCards,
  listCardsForDisplay,
  nowIso,
  scanCardSummariesForReconcile,
  validateSlug,
  type Board,
  type Card,
} from "../record.ts";
import {
  BOARD_CARDS_ADDRESS_FIELDS,
  deleteBoardCardRowsBySk,
  listBoardCardsPartition,
  sweepBoardCardsPartition,
} from "../board-cards.ts";
import { patchBoardListIndex } from "../card-list-index.ts";
import {
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
  fixedColumns,
  isFixedColumnList,
} from "../schemas.ts";

export async function boardCreateCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  columns?: string[];
  body?: string;
}): Promise<{ slug: string; action: "created" | "updated" }> {
  validateSlug(opts.slug);
  // Columns are FIXED: backlog → todo → doing → done only (Tom 2026-07-16).
  // Callers may omit --columns or pass the exact fixed list; anything else is
  // rejected before any write. Custom layouts / arbitrary names are not allowed.
  if (opts.columns && opts.columns.length > 0 && !isFixedColumnList(opts.columns)) {
    const got = opts.columns.join(",");
    const want = DEFAULT_COLUMNS.join(",");
    throw new FkanbanError({
      code: "invalid_columns",
      message: `Column list must be exactly ${want} (got ${got}).`,
      hint: "Kanban columns are fixed: backlog → todo → doing → done. Omit --columns or pass that exact list.",
    });
  }
  const columns = fixedColumns();
  const existing = await findBoard(opts.node, opts.cfg, opts.slug);
  const now = nowIso();
  const board: Board = {
    slug: opts.slug,
    title: opts.title ?? existing?.title ?? opts.slug,
    body: opts.body ?? existing?.body ?? "",
    columns,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const hash = schemaHashFor("board", opts.cfg);
  if (existing) {
    await opts.node.updateRecord({ schemaHash: hash, fields: boardToFields(board), keyHash: board.slug });
    await patchBoardListIndex(opts.node, opts.cfg, board, "upsert");
    return { slug: board.slug, action: "updated" };
  }
  await opts.node.createRecord({ schemaHash: hash, fields: boardToFields(board), keyHash: board.slug });
  await patchBoardListIndex(opts.node, opts.cfg, board, "upsert");
  return { slug: board.slug, action: "created" };
}

// A board enriched with its live-card count. `cardCount` is the number of
// non-tombstoned cards on the board; it is `null` when the (low-frequency) count
// scan couldn't run (the node sheds full scans under load) — `board list` still
// renders the boards in that case, just without counts. The field is additive,
// so existing `Board[]` `--json` consumers keep working.
export type BoardWithCount = Board & { cardCount: number | null };

// Pluralized "(N cards)" suffix; "(empty)" for a board with no live cards.
function cardCountLabel(count: number): string {
  if (count === 0) return "(empty)";
  return `(${count} card${count === 1 ? "" : "s"})`;
}

// Both the human text and the structured board list, from a single read (plus a
// single cross-board card scan for the per-board live-card counts). `boardListCmd`
// (CLI) returns one; the MCP tool returns both.
export async function boardListResult(opts: {
  cfg: Config;
  node: NodeClient;
}): Promise<{ text: string; boards: BoardWithCount[] }> {
  const boardList = await listBoards(opts.node, opts.cfg);
  // Per-board live-card count, from a single body-free cross-board scan. The
  // node can shed a full scan when it's loaded, and `board list` never needed
  // one before — so DEGRADE GRACEFULLY: if the scan fails, fall back to a
  // count-less board list (cardCount=null) rather than failing the command.
  let countByBoard: Map<string, number> | null = null;
  try {
    const allCards = await listCardsForDisplay(opts.node, opts.cfg, { boards: boardList });
    countByBoard = new Map<string, number>();
    for (const c of allCards) {
      countByBoard.set(c.board, (countByBoard.get(c.board) ?? 0) + 1);
    }
  } catch {
    // Leave countByBoard null → render/serialize without counts.
    countByBoard = null;
  }

  const boards: BoardWithCount[] = boardList.map((b) => ({
    ...b,
    cardCount: countByBoard ? countByBoard.get(b.slug) ?? 0 : null,
  }));

  const text =
    boards.length === 0
      ? "No boards. Run `kanban init` to seed the default board."
      : boards
          .map((b) => {
            const suffix = b.cardCount === null ? "" : `  ${cardCountLabel(b.cardCount)}`;
            return `${b.slug.padEnd(20)} ${b.title}${suffix}\n  columns: ${b.columns.join(" → ")}`;
          })
          .join("\n");
  return { text, boards };
}

export async function boardListCmd(opts: {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
  /** Legacy bare-array stdout (`--json-array`). Default is the envelope. */
  jsonArray?: boolean;
}): Promise<string> {
  const { text, boards } = await boardListResult(opts);
  if (!opts.json) return text;
  if (opts.jsonArray) return JSON.stringify(boards, null, 2);
  // Uncapped today — total equals kept, truncated is always false.
  return JSON.stringify({ boards, total: boards.length, truncated: false }, null, 2);
}

/**
 * The point-read budget for the unplaced-card check in {@link readBoardOccupancy}.
 *
 * On a converged board the unplaced set is empty or a handful, so this ceiling
 * never binds. It binds when membership is broadly missing — which is exactly
 * when `board rm` must not guess: hundreds of point reads is minutes of latency
 * for an answer that `groom board-cards-heal` produces properly, so the command
 * refuses and says so rather than either stalling or assuming.
 */
const BOARD_RM_UNPLACED_PROBE_BUDGET = 200;

/** What occupies a board, and where those membership rows actually live. */
type BoardOccupancy = {
  /** Distinct card slugs on the board. */
  slugs: string[];
  /** slug → every real BoardCards range key carrying it on this partition. */
  sksBySlug: Map<string, string[]>;
};

/**
 * Every card slug that deleting `board` would strand — the read `board rm`'s
 * guard has to be built on, and the one it was not.
 *
 * ## The defect this replaces
 *
 * The guard used to ask `listCards()` and keep the rows whose `board` matched.
 * `listCards` resolves through the BoardCards projection, and a projected read
 * of that index is a FILTER, not an enumeration: the node returns a row only
 * when the field LEADING the projection has an atom on it (measured on the live
 * primary — see `sweepBoardCardsPartition`). A row the projection dropped was a
 * card the guard could not count, so `board rm` reported a board with live cards
 * as empty and deleted it; `--force` had the same blind spot from the other
 * side, deleting the cards it could see and stranding the ones it could not.
 *
 * ## Two sources, because neither alone can answer it
 *
 *  1. **The membership sweep** — `sweepBoardCardsPartition` leads with each
 *     BoardCards field in turn and unions by range key, so it reaches every row
 *     carrying any atom at all. This finds the rows a projection drops. A lead
 *     the node refuses makes the enumeration a LOWER BOUND, and a lower bound
 *     cannot authorize a delete, so a failed lead refuses the command outright
 *     instead of being logged past.
 *  2. **Card truth for cards with no membership anywhere** — a card written
 *     before the 2026-07-18 dual-write cutover has no BoardCards row at all, so
 *     no membership read of any width can see it. The Card scan is a SLUG
 *     ORACLE (`scanCardSummariesForReconcile`: it establishes which slugs exist
 *     and vouches for nothing else), so the slugs it names that no board's
 *     membership places are the only cards that could secretly live here — and
 *     each of those is settled by a point read of Card, the authority.
 *
 * Membership placement for the OTHER boards is read at the cheap projected
 * width on purpose. Under-reporting placement there can only grow the unplaced
 * set, which costs point reads; it can never hide a card from this check.
 *
 * ## Cost
 *
 * One 24-query partition sweep (~780ms on the 264-row live `default`), one Card
 * scan, one cheap partition read per other board, and a point read per unplaced
 * slug — zero of those on a converged board. That is a rare destructive
 * command's budget, not a list path's.
 */
async function readBoardOccupancy(
  node: NodeClient,
  cfg: Config,
  board: string,
  projectedCards: readonly Card[],
  opts: { needExhaustive: boolean },
): Promise<BoardOccupancy> {
  const sksBySlug = new Map<string, string[]>();
  const slugs = new Set<string>();

  const sweep = await sweepBoardCardsPartition(node, cfg, board);
  if (!sweep) {
    // No BoardCards index bound at all (fresh/legacy config): the projected list
    // IS the only membership read there is, and it resolved through a Card scan
    // rather than the index. Nothing here can improve on it.
    for (const c of projectedCards) if (c.board === board) slugs.add(c.slug);
    return { slugs: [...slugs], sksBySlug };
  }
  if (sweep.failedLeads.length > 0) {
    const leads = sweep.failedLeads.map((f) => f.field).join(", ");
    throw new FkanbanError({
      code: "board_membership_unreadable",
      message:
        `Could not enumerate board "${board}" completely — the node refused ` +
        `${sweep.failedLeads.length} of the completeness leads (${leads}).`,
      hint:
        "A partial enumeration is a lower bound, so removing the board could " +
        "strand the rows it did not return. Run `kanban groom board-cards-heal " +
        `--board ${board}` +
        "` and retry once the partition reads clean.",
    });
  }
  for (const row of sweep.rows) {
    slugs.add(row.slug);
    const sks = sksBySlug.get(row.slug);
    if (sks) sks.push(row.sk);
    else sksBySlug.set(row.slug, [row.sk]);
  }

  // The unplaced-card check below can only ADD occupants, so it is skipped when
  // one occupant is already enough to settle the question. That is the
  // refuse-without-`--force` case: the command is about to decline, and a second
  // reason to decline costs a scan and buys nothing. When the caller is going to
  // DELETE, the set has to be exhaustive and the check always runs.
  if (!opts.needExhaustive && slugs.size > 0) return { slugs: [...slugs], sksBySlug };

  // Cards no membership index places anywhere. Only these can be on this board
  // without the sweep having seen them.
  let scanned: readonly { slug: string }[];
  try {
    scanned = await scanCardSummariesForReconcile(node, cfg);
  } catch (err) {
    // Fail closed. The scan is how this command learns about cards with no
    // membership row; without it the guard is back to trusting an index that
    // has already been measured to under-report, and the failure it produces
    // is a silently deleted board.
    throw new FkanbanError({
      code: "board_card_truth_unavailable",
      message: `Could not read Card truth to check board "${board}" for unindexed cards.`,
      hint: `The node refused the Card scan (${err instanceof Error ? err.message : String(err)}). Retry when it is less loaded.`,
    });
  }
  const placed = new Set<string>(slugs);
  for (const b of await listBoards(node, cfg)) {
    if (b.slug === board) continue;
    const part = await listBoardCardsPartition(node, cfg, b.slug, {
      fields: BOARD_CARDS_ADDRESS_FIELDS,
    });
    for (const c of part ?? []) placed.add(c.slug);
  }
  const unplaced = scanned.map((c) => c.slug).filter((s) => s.length > 0 && !placed.has(s));
  if (unplaced.length > BOARD_RM_UNPLACED_PROBE_BUDGET) {
    throw new FkanbanError({
      code: "board_membership_unreadable",
      message:
        `${unplaced.length} cards have no membership row on any board, which is ` +
        `more than this command can settle by point read (${BOARD_RM_UNPLACED_PROBE_BUDGET}).`,
      hint:
        "Any of them could be on this board. Run `kanban groom board-cards-heal " +
        "--apply` to rebuild membership, then retry.",
    });
  }
  for (const slug of unplaced) {
    const truth = await findCard(node, cfg, slug);
    if (truth && truth.board === board) slugs.add(slug);
  }
  return { slugs: [...slugs], sksBySlug };
}

// `fkanban board rm <slug>` — delete a board (hard erase; no trash / undo).
// Forced removal deletes the live cards on that board first.
export async function boardRmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  force?: boolean;
}): Promise<{ slug: string; deletedCards: string[] }> {
  // The default board is seeded by `init` and assumed by init-less flows;
  // removing it would silently break those, so it is never deletable.
  if (opts.slug === DEFAULT_BOARD_SLUG) {
    throw new FkanbanError({
      code: "board_protected",
      message: `The "${DEFAULT_BOARD_SLUG}" board cannot be removed.`,
      hint: "It is the seeded board that init-less flows fall back to.",
    });
  }
  const board = await findBoard(opts.node, opts.cfg, opts.slug);
  if (!board) {
    throw new FkanbanError({ code: "board_not_found", message: `No board with slug "${opts.slug}".` });
  }
  // Don't silently orphan cards: a board with live cards is only removable with
  // --force. Forced removal deletes those cards first, so short-lived harness
  // boards can be torn down without leaving hidden live records behind.
  //
  // `cards` is the projected board-wide list. It is the right read for the
  // DEPENDENTS check below — that question is about other boards' cards, and a
  // dropped row there costs a warning, not a card — but it is NOT the read that
  // decides occupancy. See {@link boardOccupantSlugs}.
  const cards = await listCards(opts.node, opts.cfg);
  const occupancy = await readBoardOccupancy(opts.node, opts.cfg, opts.slug, cards, {
    needExhaustive: Boolean(opts.force),
  });
  const occupants = occupancy.slugs;
  if (!opts.force && occupants.length > 0) {
    const n = occupants.length;
    throw new FkanbanError({
      code: "board_not_empty",
      message: `Board "${opts.slug}" still has ${n} live card${n === 1 ? "" : "s"}.`,
      hint: "Move or rm those cards first, or pass --force to remove the board and its cards.",
    });
  }
  // Every occupant's Card record, read by key. The occupancy set is derived from
  // membership rows and a Card scan, and neither vouches for field values — so
  // the record that is about to be DELETED is point-read, never taken from a
  // list row. A slug with no Card record is membership residue: it still has to
  // go (its partition is about to lose its Board), but it is not a card and
  // never enters the dependents graph.
  const live: Card[] = [];
  const residueSlugs: string[] = [];
  for (const slug of occupants) {
    const truth = await findCard(opts.node, opts.cfg, slug);
    if (truth) live.push(truth);
    else residueSlugs.push(slug);
  }
  if (live.length > 0) {
    const deletedSlugs = new Set(live.map((c) => c.slug));
    const externalDependents = cards
      .filter((c) => !deletedSlugs.has(c.slug) && c.deps.some((dep) => deletedSlugs.has(dep)))
      .map((c) => c.slug);
    if (externalDependents.length > 0) {
      throw new FkanbanError({
        code: "board_cards_have_dependents",
        message:
          `Board "${opts.slug}" contains card(s) still depended on by ` +
          `${externalDependents.length} live card${externalDependents.length === 1 ? "" : "s"}.`,
        hint: `Remove or retarget those dependency edges first: ${externalDependents.join(", ")}`,
      });
    }
    for (const card of live) {
      await checkpointCardCompletion({
        cfg: opts.cfg,
        node: opts.node,
        card,
        boardColumns: board.columns,
        reason: "delete-backstop",
      });
      await deleteCardRecord(opts, card);
    }
  }
  // Membership rows for slugs with no Card record. `deleteCardRecord` reaped the
  // rows belonging to real cards; these have no record to hang them off, so they
  // are retired by address. Left behind they would be rows keyed into a
  // partition whose Board is gone — invisible to `board list`, and the exact
  // residue `groom board-cards-heal` exists to chase.
  for (const slug of residueSlugs) {
    await deleteBoardCardRowsBySk(opts.node, opts.cfg, opts.slug, occupancy.sksBySlug.get(slug) ?? []);
  }
  const hash = schemaHashFor("board", opts.cfg);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: board.slug });
  // Drop it from `all_boards` too. `listBoards` reads that rollup and only falls
  // back to a Board scan when the row is MISSING — so an entry left behind here
  // is permanent: `board list` keeps showing a board whose record is gone, and
  // every `kanban list` pays one dead BoardCards partition query for it, forever.
  // Record first, index second: if this patch fails we leave a visible ghost
  // (repairable with `groom board-list-heal`), never a live board that silently
  // vanished from list along with all of its cards.
  await patchBoardListIndex(opts.node, opts.cfg, board, "remove");
  return { slug: board.slug, deletedCards: live.map((c) => c.slug) };
}
