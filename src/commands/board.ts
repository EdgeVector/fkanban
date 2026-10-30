// `fkanban board create|list|rm` — manage boards.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { keyRows, requireMultiKey } from "../multi-key.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import {
  boardToFields,
  deleteCardRecordsBatch,
  hydrateCardBodies,
  assertBodyLoaded,
  rowToCard,
  BODY_OMITTED,
  WRITE_PROBE_SLUG,
  isTombstoned,
  findBoard,
  listBoards,
  listCardsForDisplay,
  nowIso,
  validateSlug,
  type Board,
  type Card,
} from "../record.ts";

import {
  CARD_FIELDS,
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
  requireMultiKey(opts.cfg);
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
    return { slug: board.slug, action: "updated" };
  }
  await opts.node.createRecord({ schemaHash: hash, fields: boardToFields(board), keyHash: board.slug });
  return { slug: board.slug, action: "created" };
}

// A board enriched with its live-card count. `cardCount` is the number of
// non-tombstoned cards on the board; it is `null` when the (low-frequency) count
// key read failed — `board list` still
// renders the boards in that case, just without counts. The field is additive,
// so existing `Board[]` `--json` consumers keep working.
export type BoardWithCount = Board & { cardCount: number | null };

// Pluralized "(N cards)" suffix; "(empty)" for a board with no live cards.
function cardCountLabel(count: number): string {
  if (count === 0) return "(empty)";
  return `(${count} card${count === 1 ? "" : "s"})`;
}

// Both the human text and the structured board list, from a single read (plus a
// named-key read for the per-board live-card counts). `boardListCmd`
// (CLI) returns one; the MCP tool returns both.
export async function boardListResult(opts: {
  cfg: Config;
  node: NodeClient;
}): Promise<{ text: string; boards: BoardWithCount[] }> {
  const boardList = await listBoards(opts.node, opts.cfg);
  // Failed count reads leave explicit null counts. Board metadata still comes from its named key.
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

/** Read complete board membership from source records. No legacy membership copies participate. */
async function readBoardOccupancy(node: NodeClient, cfg: Config, board: string): Promise<Card[]> {
  const rows = await keyRows(node, schemaHashFor("card", cfg), "by_board", { HashKey: board },
    CARD_FIELDS.filter(field => field !== "body"));
  return rows.map(row => {
    const card = rowToCard(row);
    if (card.slug !== row.key.hash || card.board !== board || row.matched_key.hash !== board) {
      throw new FkanbanError({ code: "board_membership_mismatch", message: "The named board key returned a record outside that board." });
    }
    card[BODY_OMITTED] = true;
    return card;
  });
}

/** Remove a non-default board. Forced removal deletes its primary Card records first. */
export async function boardRmCmd(opts: {
  cfg: Config; node: NodeClient; slug: string; force?: boolean;
}): Promise<{ slug: string; deletedCards: string[] }> {
  requireMultiKey(opts.cfg);
  if (opts.slug === DEFAULT_BOARD_SLUG) throw new FkanbanError({ code: "board_protected",
    message: "The default board cannot be removed.", hint: "Init and implicit board placement use that board." });
  const board = await findBoard(opts.node, opts.cfg, opts.slug);
  if (!board) throw new FkanbanError({ code: "board_not_found", message: "No board with slug " + JSON.stringify(opts.slug) + "." });
  const occupants = await readBoardOccupancy(opts.node, opts.cfg, opts.slug);
  if (!opts.force && occupants.length) throw new FkanbanError({ code: "board_not_empty",
    message: "The board still contains " + occupants.length + " Card records.",
    hint: "Move or remove those cards first, or use --force." });
  const live = occupants.filter(card => card.slug !== WRITE_PROBE_SLUG && !isTombstoned(card.tags));
  if (occupants.length) {
    const deleting = new Set(live.map(card => card.slug));
    const all = await keyRows(opts.node, schemaHashFor("card", opts.cfg), "all", { HashKey: "all" },
      ["slug", "deps", "tags"]);
    const externalDependents = all.filter(row => !deleting.has(row.key.hash!)
      && row.key.hash !== WRITE_PROBE_SLUG && !isTombstoned(Array.isArray(row.fields.tags) ? row.fields.tags : [])
      && Array.isArray(row.fields.deps) && row.fields.deps.some(dep => typeof dep === "string" && deleting.has(dep)))
      .map(row => row.key.hash!);
    if (externalDependents.length) throw new FkanbanError({ code: "board_cards_have_dependents",
      message: "Cards outside this board still depend on its cards.",
      hint: "Remove or retarget those dependencies first: " + externalDependents.join(", ") });
    const terminal = live.filter(card => card.column === board.columns[board.columns.length - 1]);
    const completed = await hydrateCardBodies(opts.node, opts.cfg, terminal);
    // Preserve the existing completion history before an erase. The Card erases use one bounded batch path.
    for (const card of completed) {
      assertBodyLoaded(card, "completion history before board removal");
      await checkpointCardCompletion({ cfg: opts.cfg, node: opts.node, card,
        boardColumns: board.columns, reason: "delete-backstop" });
    }
    await deleteCardRecordsBatch(opts, occupants);
  }
  // A new member after the first read keeps the board in place.
  if ((await readBoardOccupancy(opts.node, opts.cfg, opts.slug)).length) {
    throw new FkanbanError({ code: "board_changed_during_removal",
      message: "The board still contains Card records. Its Board record remains in place." });
  }
  await opts.node.deleteRecord({ schemaHash: schemaHashFor("board", opts.cfg), keyHash: board.slug });
  return { slug: board.slug, deletedCards: live.map(card => card.slug) };
}
