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
import { type Config } from "../config.ts";
import {
  RANK_POSITION_STEP,
  ensureColumn,
  isMetaCardKind,
  listCards,
  priorityOf,
  rankCards,
  requireBoard,
  writeCardPatch,
  type PriorityTier,
} from "../record.ts";
import type { RankResult } from "../format.ts";

export type RankOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
};

export type RankedCard = { slug: string; priority: PriorityTier; position: number };

export async function rankCmd(opts: RankOptions): Promise<RankResult> {
  const boardSlug = opts.board ?? "default";
  const column = opts.column ?? "todo";
  // The board must exist (matches add/move) and the column must be real on it,
  // so a typo'd `--column` errors loudly instead of silently ranking nothing.
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  ensureColumn(column, board.columns);

  const all = await listCards(opts.node, opts.cfg);
  const inColumn = all.filter((c) => c.board === boardSlug && c.column === column && !isMetaCardKind(c.kind));
  const ranked = rankCards(inColumn);

  const order: RankedCard[] = [];
  let reordered = 0;
  for (let i = 0; i < ranked.length; i++) {
    const card = ranked[i]!;
    const position = (i + 1) * RANK_POSITION_STEP;
    order.push({ slug: card.slug, priority: priorityOf(card), position });
    // Idempotent: skip the write (and the updated_at bump) when the card is
    // already at its ranked position.
    if (card.position === String(position)) continue;
    await writeCardPatch(opts, card, { position: String(position) });
    reordered++;
  }
  return { board: boardSlug, column, total: ranked.length, reordered, order };
}
