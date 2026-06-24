// `fkanban rank [--board <slug>] [--column <col>]` — order a column by card
// priority so `fkanban-pickup` (which drains the LOWEST `position` first) works
// the most urgent cards first. Reassigns each card's `position` to a small,
// gap-spaced integer in priority order (P0→P3, tie-broken by created_at). This
// is the step that turns the priority *signal* (a `Priority:` body header or a
// `p0`..`p3` tag) into the `position` ordering pickup/list already honor — the
// board groomer runs it after promoting cards into `todo`.
//
// Defaults to the `todo` column on the default board — the exact column pickup
// reads. Idempotent: only cards whose position actually changes are written, so
// a re-run on an already-ranked column performs zero mutations.

import { type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  RANK_POSITION_STEP,
  cardToFields,
  ensureColumn,
  listCards,
  nowIso,
  priorityOf,
  rankCards,
  requireBoard,
  type Card,
  type PriorityTier,
} from "../record.ts";

export type RankOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
};

export type RankedCard = { slug: string; priority: PriorityTier; position: number };

export type RankResult = {
  board: string;
  column: string;
  // Total live cards in the ranked column.
  total: number;
  // How many cards' positions actually changed (and were written).
  reordered: number;
  // The full resulting order, top (most urgent) first.
  order: RankedCard[];
};

export async function rankCmd(opts: RankOptions): Promise<RankResult> {
  const boardSlug = opts.board ?? "default";
  const column = opts.column ?? "todo";
  // The board must exist (matches add/move) and the column must be real on it,
  // so a typo'd `--column` errors loudly instead of silently ranking nothing.
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  ensureColumn(column, board.columns);

  const all = await listCards(opts.node, opts.cfg);
  const inColumn = all.filter((c) => c.board === boardSlug && c.column === column);
  const ranked = rankCards(inColumn);

  const hash = schemaHashFor("card", opts.cfg);
  const now = nowIso();
  const order: RankedCard[] = [];
  let reordered = 0;
  for (let i = 0; i < ranked.length; i++) {
    const card = ranked[i]!;
    const position = (i + 1) * RANK_POSITION_STEP;
    order.push({ slug: card.slug, priority: priorityOf(card), position });
    // Idempotent: skip the write (and the updated_at bump) when the card is
    // already at its ranked position.
    if (card.position === String(position)) continue;
    const updated: Card = { ...card, position: String(position), updated_at: now };
    await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
    reordered++;
  }
  return { board: boardSlug, column, total: ranked.length, reordered, order };
}
