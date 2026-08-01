// `fkanban rank [--board <slug>] [--column <col>]` — order a column so pickup
// drains the **hard todo ranker** order (lowest `position` first):
//
//   p0-now → program (NS / MS frontier) → unlaned → papercut
//
// Within a tier: active|proving milestone children first, then Priority P0→P3,
// then oldest created_at.
//
// This is the step that turns lane + milestone + priority *signals* into the
// `position` field list/claim already honor. The board groomer runs it after
// promoting cards into `todo`.
//
// Defaults to the `todo` column on the default board — the exact column pickup
// reads. Idempotent: only cards whose position actually changes are written.
//
// Escape hatch: `--mode priority` restores legacy P0→P3-only ranking (no lanes).

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  RANK_POSITION_STEP,
  ensureColumn,
  isMetaCardKind,
  listBoardCardsWithBodies,
  listMilestonesOnBoard,
  priorityOf,
  rankCards,
  requireBoard,
  writeCardPatch,
  type PriorityTier,
} from "../record.ts";
import {
  hardLaneTier,
  isFrontierMilestoneState,
  laneOf,
  rankCardsHardTodo,
  type HardTodoRankContext,
} from "../pickup_lanes.ts";
import type { RankResult } from "../format.ts";

export type RankMode = "hard" | "priority";

export type RankOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
  /** hard (default) = lane+frontier+priority; priority = legacy P0→P3 only */
  mode?: RankMode;
};

export type RankedCard = {
  slug: string;
  priority: PriorityTier;
  position: number;
  lane?: string;
  hard_tier?: number;
};

export async function rankCmd(opts: RankOptions): Promise<RankResult & { mode: RankMode }> {
  const boardSlug = opts.board ?? "default";
  const column = opts.column ?? "todo";
  const mode: RankMode = opts.mode === "priority" ? "priority" : "hard";
  // The board must exist (matches add/move) and the column must be real on it,
  // so a typo'd `--column` errors loudly instead of silently ranking nothing.
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  ensureColumn(column, board.columns);

  // Bodies required on both halves of this command: the priority SIGNAL is a
  // `Priority:` body header (the tag is only the fallback), and each reordered
  // card is written back whole — the body-free list silently demoted every
  // header-only card to P2 and blanked the brief it rewrote.
  const all = await listBoardCardsWithBodies(opts.node, opts.cfg);
  const inColumn = all.filter((c) => c.board === boardSlug && c.column === column && !isMetaCardKind(c.kind));

  let ctx: HardTodoRankContext | undefined;
  if (mode === "hard") {
    try {
      const milestones = await listMilestonesOnBoard(opts.node, opts.cfg, boardSlug);
      const frontier = new Set(
        milestones.filter((m) => isFrontierMilestoneState(m.state)).map((m) => m.slug),
      );
      ctx = { frontierMilestones: frontier };
    } catch {
      // Milestone index optional — rank still applies hard lane tiers without frontier boost.
      ctx = {};
    }
  }

  const ranked = mode === "hard" ? rankCardsHardTodo(inColumn, ctx) : rankCards(inColumn);

  const order: RankedCard[] = [];
  let reordered = 0;
  for (let i = 0; i < ranked.length; i++) {
    const card = ranked[i]!;
    const position = (i + 1) * RANK_POSITION_STEP;
    const lane = laneOf(card);
    order.push({
      slug: card.slug,
      priority: priorityOf(card),
      position,
      lane,
      hard_tier: hardLaneTier(lane),
    });
    // Idempotent: skip the write (and the updated_at bump) when the card is
    // already at its ranked position.
    if (card.position === String(position)) continue;
    await writeCardPatch(opts, card, { position: String(position) });
    reordered++;
  }
  return { board: boardSlug, column, total: ranked.length, reordered, order, mode };
}
