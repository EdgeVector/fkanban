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
import { mapWithConcurrency, POINT_READ_CONCURRENCY } from "../concurrency.ts";
import {
  RANK_POSITION_STEP,
  ensureColumn,
  findMilestone,
  hydrateCardBodies,
  isBodyOmitted,
  isMetaCardKind,
  listCards,
  priorityOf,
  rankCards,
  requireBoard,
  writeCardPatch,
  type Milestone,
  type PriorityTier,
} from "../record.ts";
import {
  hardLaneTier,
  isFrontierMilestoneState,
  laneOf,
  rankCardsHardTodo,
  type HardTodoRankContext,
} from "../pickup_lanes.ts";
import { planRankPositions } from "../rank_positions.ts";
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
  //
  // Scope the read to the single column being ranked — the ranker never
  // reorders any other column. Reading the whole board (or worse, the whole
  // product's Card schema through the body-map short-cut) paid for hundreds
  // of rows it could never touch: a 20-card `todo` column cost ~3,004 node
  // queries before this fix, because the body hydrate fanned out over every
  // card on the board regardless of scope. Point-reading bodies for just this
  // column's candidates (`hydrateCardBodies`) costs one query per candidate.
  // See kanban-rank-hard-3004-queries-168s-blocks-pickup-claim-20260904.
  const scoped = await listCards(opts.node, opts.cfg, {
    boards: [{ slug: boardSlug }],
    column,
  });
  const candidates = scoped.filter(
    (c) => c.board === boardSlug && c.column === column && !isMetaCardKind(c.kind),
  );
  const hydrated = await hydrateCardBodies(opts.node, opts.cfg, candidates);
  // A BoardCards orphan has no Card primary to hydrate. Keep rank fail-open:
  // the row remains visible to the explicit board-cards healer, while every
  // real card can still be ordered. Passing the orphan through would make the
  // first required position rewrite hit the body-loaded write guard and abort
  // the entire pickup factory.
  const skipped = hydrated
    .filter(isBodyOmitted)
    .map((card) => ({ slug: card.slug, reason: "card-primary-missing" }));
  const inColumn = hydrated.filter((card) => !isBodyOmitted(card));

  let ctx: HardTodoRankContext | undefined;
  if (mode === "hard") {
    // Only the milestones this column's own cards actually reference need a
    // frontier verdict — listing and hydrating every milestone on the board
    // (218 queries measured on the primary) paid for milestones no candidate
    // here points at. Point-read just the referenced slugs instead.
    const milestoneSlugs = [
      ...new Set(inColumn.map((c) => (c.milestone ?? "").trim()).filter((s) => s.length > 0)),
    ];
    if (milestoneSlugs.length === 0) {
      ctx = {};
    } else {
      try {
        const milestones = await mapWithConcurrency(
          milestoneSlugs,
          (slug) => findMilestone(opts.node, opts.cfg, slug),
          POINT_READ_CONCURRENCY,
        );
        const frontier = new Set(
          milestones
            .filter((m): m is Milestone => m !== null)
            .filter((m) => isFrontierMilestoneState(m.state))
            .map((m) => m.slug),
        );
        ctx = { frontierMilestones: frontier };
      } catch {
        // Milestone index optional — rank still applies hard lane tiers without frontier boost.
        ctx = {};
      }
    }
  }

  const ranked = mode === "hard" ? rankCardsHardTodo(inColumn, ctx) : rankCards(inColumn);

  // Positions are an ORDERING, not an address. Keep every card whose current
  // position already sits in increasing order along `ranked` and write only the
  // rest — each write is one gate acquisition on the board's single BoardCards
  // partition, and a dense renumber spends ~54 of them to realize an order that
  // needs 1 (see src/rank_positions.ts for the measurement).
  const plan = planRankPositions(ranked.map((c) => c.position), RANK_POSITION_STEP);
  const mustWrite = new Set(plan.writeIndices);

  const order: RankedCard[] = [];
  let reordered = 0;
  for (let i = 0; i < ranked.length; i++) {
    const card = ranked[i]!;
    const position = plan.positions[i]!;
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
    if (!mustWrite.has(i)) continue;
    await writeCardPatch(opts, card, { position: String(position) });
    reordered++;
  }
  return { board: boardSlug, column, total: ranked.length, reordered, order, mode, skipped };
}
