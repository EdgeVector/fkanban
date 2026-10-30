import { FkanbanError, type CasExpectation, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { cardToFields, type Card } from "./record.ts";
import { multiKey } from "./multi-key.ts";
import { ownedCardBatchSupported } from "./owned-card-contract.ts";

/** One atomic primary-record update. Body marks remain outside recovery edits. */
export async function guardedCardUpdate(
  opts: { node: NodeClient; cfg: Config }, card: Card, expected: CasExpectation,
): Promise<void> {
  if (!multiKey(opts.cfg) || !opts.node.updateRecords || !opts.cfg.schemaHashes.card ||
      !await ownedCardBatchSupported(opts.node)) {
    throw new FkanbanError({ code: "guarded_batch_unsupported", message: "Guarded updates require owned values and the atomic primary-record batch." });
  }
  const fields = cardToFields(card);
  delete fields.body;
  await opts.node.updateRecords([{ schemaHash: opts.cfg.schemaHashes.card, keyHash: card.slug,
    fields, expected, durability: "durable" }]);
}
