// The Milestone schema owns its values and its named board key.
import { FkanbanError, type NodeClient } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import { keyRows, requireMultiKey } from "./multi-key.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "./concurrency.ts";
import { fieldsFor } from "./schemas.ts";
import { rowToMilestone, type Milestone } from "./record.ts";

export async function listMilestonesByBoardKey(node: NodeClient, cfg: Config, board: string): Promise<Milestone[]> {
  requireMultiKey(cfg);
  const rows = await keyRows(node, schemaHashFor("milestone", cfg), "by_board", { HashKey: board }, fieldsFor("milestone"), 16);
  return rows.map(row => {
    const milestone = rowToMilestone(row);
    if (milestone.slug !== row.key.hash || milestone.board !== board || row.matched_key.hash !== board) {
      throw new FkanbanError({ code: "milestone_key_mismatch", message: "The board key returned a milestone outside that board." });
    }
    return milestone;
  });
}

export async function listMilestonesByBoardKeys(
  node: NodeClient, cfg: Config, boards: Array<{ slug: string }>,
): Promise<Milestone[]> {
  requireMultiKey(cfg);
  const parts = await mapWithConcurrency(boards,
    board => listMilestonesByBoardKey(node, cfg, board.slug), PARTITION_READ_CONCURRENCY);
  const bySlug = new Map<string, Milestone>();
  for (const milestone of parts.flat()) {
    const previous = bySlug.get(milestone.slug);
    if (!previous || milestone.updated_at > previous.updated_at) bySlug.set(milestone.slug, milestone);
  }
  return [...bySlug.values()];
}
