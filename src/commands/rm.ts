// `fkanban rm <slug>` — soft-delete a card. fold_db is append-only, so this
// overwrites the card's fields and stamps the tombstone tag; every read path
// filters tombstoned cards out.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { cardToFields, findCard, nowIso, TOMBSTONE_TAG, type Card } from "../record.ts";

export async function rmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<{ slug: string }> {
  const card = await findCard(opts.node, opts.cfg, opts.slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${opts.slug}".` });
  }
  const tombstoned: Card = {
    ...card,
    tags: [...new Set([...card.tags, TOMBSTONE_TAG])],
    updated_at: nowIso(),
  };
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(tombstoned), keyHash: card.slug });
  return { slug: card.slug };
}
