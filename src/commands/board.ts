// `fkanban board create|list|rm` — manage boards.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import {
  boardToFields,
  findBoard,
  listBoards,
  listCards,
  listCardsForDisplay,
  nowIso,
  validateSlug,
  type Board,
} from "../record.ts";
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
    const allCards = await listCardsForDisplay(opts.node, opts.cfg);
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
}): Promise<string> {
  const { text, boards } = await boardListResult(opts);
  return opts.json ? JSON.stringify(boards, null, 2) : text;
}

// `fkanban board rm <slug>` — delete a board with the node's native tombstone
// mutation. Forced removal deletes the live cards on that board first.
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
  // --force. Forced removal tombstones those cards first, so short-lived harness
  // boards can be torn down without leaving hidden live records behind.
  const cards = await listCards(opts.node, opts.cfg);
  const live = cards.filter((c) => c.board === opts.slug);
  if (!opts.force && live.length > 0) {
    const n = live.length;
    throw new FkanbanError({
      code: "board_not_empty",
      message: `Board "${opts.slug}" still has ${n} live card${n === 1 ? "" : "s"}.`,
      hint: "Move or rm those cards first, or pass --force to remove the board and its cards.",
    });
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
    const cardHash = schemaHashFor("card", opts.cfg);
    for (const card of live) {
      await checkpointCardCompletion({
        cfg: opts.cfg,
        node: opts.node,
        card,
        boardColumns: board.columns,
        reason: "delete-backstop",
      });
      await opts.node.deleteRecord({ schemaHash: cardHash, keyHash: card.slug });
    }
  }
  const hash = schemaHashFor("board", opts.cfg);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: board.slug });
  return { slug: board.slug, deletedCards: live.map((c) => c.slug) };
}
