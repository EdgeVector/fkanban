// One-shot backfill: dual-write BoardMilestones + MilestoneCards from fat
// Milestone point-reads and board card lists. Admin/heal path only.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { upsertBoardMilestone, boardMilestonesHash } from "../board-milestones.ts";
import { upsertMilestoneCard, milestoneCardsHash } from "../milestone-cards.ts";
import {
  findMilestone,
  listBoards,
  listCardsOnBoard,
  listMilestones,
  type Milestone,
} from "../record.ts";

export type MilestoneIndexesHealResult = {
  board_milestones_bound: boolean;
  milestone_cards_bound: boolean;
  milestones_written: number;
  cards_written: number;
  text: string;
};

/**
 * Rebuild reverse indexes from current fat records.
 * Uses listMilestones (may still full-scan if index empty) then point-read
 * each slug for truth, then upserts BoardMilestones + MilestoneCards.
 */
export async function milestoneIndexesHealResult(opts: {
  cfg: Config;
  node: NodeClient;
  board?: string;
}): Promise<MilestoneIndexesHealResult> {
  const boardMsBound = Boolean(boardMilestonesHash(opts.cfg));
  const msCardsBound = Boolean(milestoneCardsHash(opts.cfg));
  if (!boardMsBound && !msCardsBound) {
    return {
      board_milestones_bound: false,
      milestone_cards_bound: false,
      milestones_written: 0,
      cards_written: 0,
      text:
        "milestone indexes heal: board_milestones and milestone_cards not bound in config — run `fkanban init` first",
    };
  }

  // Always rebuild from fat Milestone rows (full-scan + HashKey hydrate), never
  // from BoardMilestones (may be empty or polluted during first heal).
  const { schemaHashFor } = await import("../config.ts");
  const { fieldsFor } = await import("../schemas.ts");
  const { rowToMilestone, milestoneQueryFieldsLookSparse } = await import("../record.ts");
  const res = await opts.node.queryAll({
    schemaHash: schemaHashFor("milestone", opts.cfg),
    fields: fieldsFor("milestone"),
    allowFullScan: true,
  });
  const slugs = res.results.map((row) => {
    const mapped = rowToMilestone(row);
    if (!milestoneQueryFieldsLookSparse((row.fields ?? {}) as Record<string, unknown>)) {
      return mapped.slug;
    }
    return mapped.slug || String((row.fields as { slug?: string } | undefined)?.slug ?? "");
  }).filter(Boolean);

  const milestones: Milestone[] = [];
  for (const slug of slugs) {
    const full = await findMilestone(opts.node, opts.cfg, slug);
    if (!full) continue;
    if (opts.board && full.board !== opts.board) continue;
    milestones.push(full);
  }

  let milestonesWritten = 0;
  if (boardMsBound) {
    for (const m of milestones) {
      await upsertBoardMilestone(opts.node, opts.cfg, m, null);
      milestonesWritten += 1;
    }
  }

  let cardsWritten = 0;
  if (msCardsBound) {
    const boards = opts.board
      ? [{ slug: opts.board }]
      : await listBoards(opts.node, opts.cfg);
    for (const b of boards) {
      const cards = await listCardsOnBoard(opts.node, opts.cfg, b.slug);
      for (const c of cards) {
        if (!(c.milestone ?? "").trim()) continue;
        await upsertMilestoneCard(opts.node, opts.cfg, c, null);
        cardsWritten += 1;
      }
    }
  }

  const text = [
    "milestone indexes heal:",
    `  board_milestones bound=${boardMsBound} written=${milestonesWritten}`,
    `  milestone_cards bound=${msCardsBound} written=${cardsWritten}`,
  ].join("\n");

  return {
    board_milestones_bound: boardMsBound,
    milestone_cards_bound: msCardsBound,
    milestones_written: milestonesWritten,
    cards_written: cardsWritten,
    text,
  };
}
