import { FkanbanError, type CasExpectation, type NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { cardToFields, type Card } from "./record.ts";
import { boardCardFieldsFromCard, boardCardsWriteHashes } from "./board-cards.ts";

// A git-describe count is not a compatibility promise. Expand only after the
// cross-schema race/durability proof passes for that exact node build.
export const GUARDED_CARD_BATCH_BUILDS = ["0.23.3-2328-g369ad6cd6"] as const;

/** One update-only atomic batch. No secondary publication or erasure follows it. */
export async function guardedCardUpdate(
  opts: { node: NodeClient; cfg: Config },
  card: Card,
  expected: CasExpectation,
): Promise<void> {
  const version = await opts.node.nodeVersion?.();
  if (!version?.handshake || !GUARDED_CARD_BATCH_BUILDS.includes(
    version.build as typeof GUARDED_CARD_BATCH_BUILDS[number],
  )) {
    throw new FkanbanError({
      code: "guarded_batch_unsupported",
      message: `Node build "${version?.build ?? "unknown"}" lacks an independently proved guarded batch contract.`,
    });
  }
  const hashes = boardCardsWriteHashes(opts.cfg);
  const cardHash = opts.cfg.schemaHashes.card;
  if (!opts.node.updateRecords || !cardHash || hashes.length === 0) {
    throw new FkanbanError({
      code: "guarded_batch_unsupported",
      message: "Guarded recovery requires Card, BoardCards, and atomic update batch support.",
    });
  }
  if (!opts.node.getSchema) {
    throw new FkanbanError({
      code: "guarded_schema_unsupported",
      message: "Guarded recovery requires live schema metadata.",
    });
  }
  const fields = boardCardFieldsFromCard(card);
  const cardFields = cardToFields(card);
  // Recovery never edits the execution log. Preserve concurrent body marks.
  delete cardFields.body;
  // Use exactly the same shared values in every prepared schema group.
  for (const key of Object.keys(cardFields)) {
    if (key in fields) cardFields[key] = fields[key];
  }
  const payloads = [
    { hash: cardHash, fields: cardFields, hashField: "slug", rangeField: null },
    ...hashes.map(hash => ({ hash, fields, hashField: "board", rangeField: "sk" })),
  ];
  for (const payload of payloads) {
    const schema = await opts.node.getSchema(payload.hash);
    if (schema.key.hash_field !== payload.hashField || schema.key.range_field !== payload.rangeField ||
      Object.keys(payload.fields).some(field => !schema.fields.includes(field))) {
      throw new FkanbanError({
        code: "guarded_schema_unsupported",
        message: `Schema "${payload.hash}" does not declare the proved guarded payload and key layout. No mutation was sent.`,
      });
    }
  }
  await opts.node.updateRecords([
    { schemaHash: cardHash, keyHash: card.slug, fields: cardFields, expected, durability: "durable" },
    ...hashes.map(schemaHash => ({
      schemaHash,
      keyHash: String(fields.board),
      rangeKey: String(fields.sk),
      fields,
      durability: "durable" as const,
    })),
  ]);
}
