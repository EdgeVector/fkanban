// `fkanban rm <slug>` — delete a card with the node's native tombstone mutation.

import { type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { listCardStatuses, requireCard } from "../record.ts";

export async function rmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<{ slug: string; orphanedDependents: string[] }> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Before tombstoning, scan the live board for cards that still list this slug
  // in their deps. Deleting the card leaves those edges dangling — the mirror of
  // the `add --deps <missing>` warning. We surface them but do NOT auto-edit the
  // dependents (fold_db is append-only; a silent cascade edit would surprise).
  const all = await listCardStatuses(opts.node, opts.cfg);
  const orphanedDependents = all
    .filter((c) => c.slug !== opts.slug && c.deps.includes(opts.slug))
    .map((c) => c.slug);

  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.deleteRecord({ schemaHash: hash, keyHash: card.slug });
  return { slug: card.slug, orphanedDependents };
}
