// `fkanban rm <slug>` — delete a card with the node's native tombstone mutation.

import { type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { FkanbanError } from "../client.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import { ensureBoardRecord, listCardStatuses, requireCard } from "../record.ts";
import { DEFAULT_BOARD_SLUG, DEFAULT_COLUMNS } from "../schemas.ts";

export async function rmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<{ slug: string; orphanedDependents: string[] }> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Before tombstoning, scan live cards for dependents. A deleted dep becomes
  // unresolvable to normal reads, so refuse the delete instead of creating a
  // missing dependency slug that later board readers have to repair.
  const all = await listCardStatuses(opts.node, opts.cfg);
  const dependents = all
    .filter((c) => c.slug !== opts.slug && c.deps.includes(opts.slug))
    .map((c) => c.slug);
  if (dependents.length > 0) {
    throw new FkanbanError({
      code: "card_has_dependents",
      message: `Card "${opts.slug}" is still a dependency of ${dependents.length} live card${dependents.length === 1 ? "" : "s"}.`,
      hint: `Remove or retarget those dependency edges first: ${dependents.join(", ")}`,
    });
  }

  if (card.column === "done" || card.done_at) {
    const boardColumns =
      card.board === DEFAULT_BOARD_SLUG && card.column === "done"
        ? [...DEFAULT_COLUMNS]
        : (await ensureBoardRecord(opts.node, opts.cfg, card.board)).columns;
    await checkpointCardCompletion({
      cfg: opts.cfg,
      node: opts.node,
      card,
      boardColumns,
      reason: "delete-backstop",
    });
  }

  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: card.slug });
  return { slug: card.slug, orphanedDependents: [] };
}
