// Public finite creation: all Card fields must be absent at atomic publication.
import { type NodeClient } from "./client.ts";
import { multiKey } from "./multi-key.ts";
import { ownedCardBatchSupported } from "./owned-card-contract.ts";
import { type Config, schemaHashFor } from "./config.ts";
import { CARD_FIELDS } from "./schemas.ts";
import { boardCardFieldsFromCard, boardCardsWriteHashes } from "./board-cards.ts";
import { cardToFields, claimHoldReason, maintainCardHead, requireListHeadHash, type Card } from "./record.ts";
import {
  captureSnapshot, COMPOUND_CARD_BUILDS, GUARDED_CONTRACT_SHA256, OWNED_GUARDED_CONTRACT_SHA256, guardError,
  rawEqual, serializeSnapshot, sha256, validateRawFields,
} from "./guarded-snapshot.ts";

export const CREATE_ONLY_CONTRACT = Object.freeze({
  version: 1, name: "fkanban-raw23-create-only", operation: "add-create-only",
  cli_flag: "--create-only", mcp_field: "create_only",
  card_fields: Object.freeze([...CARD_FIELDS]),
  compound_builds: Object.freeze([...COMPOUND_CARD_BUILDS]),
  guard: "all23-absent", guard_payload_identity: "native-live-author-clock-before-filter",
  final_payload: "complete-card-cas-protected-in-same-batch",
  column: "backlog", owner: "", force: false,
  existing_board_required: true, exact_card_schema_fields: true, max_board_destinations: 2, max_batch_operations: 26,
  durability: "durable", membership_cleanup: "deferred", retries: 0,
});
export const CREATE_ONLY_CONTRACT_SHA256 = sha256(JSON.stringify(CREATE_ONLY_CONTRACT) + "\n");
export const OWNED_CREATE_ONLY_CONTRACT = Object.freeze({ ...CREATE_ONLY_CONTRACT, version: 2,
  name: "fkanban-owned-raw23-create-only", compound_builds: [], required_capability: "atomic_owned_mutations_v1",
  max_board_destinations: 0, max_batch_operations: 24, membership_cleanup: "native",
});
export const OWNED_CREATE_ONLY_CONTRACT_SHA256 = sha256(JSON.stringify(OWNED_CREATE_ONLY_CONTRACT) + "\n");
export type CreateOnlyReceipt = {
  next_snapshot_json: string; next_snapshot_sha256: string; durability: "durable";
  contract_sha256: string; card_guarded_contract_sha256: string;
  absence_guard: "all23-absent"; membership_cleanup: "deferred" | "native";
};
export function assertCreateOnlyScope(card: Card, force?: boolean): void {
  if (force || card.column !== "backlog" || card.assignee !== "" || claimHoldReason(card) ||
      !["", "none"].includes(card.block_status) || card.block_reason !== "" || card.pr_url !== "" || card.branch !== "") {
    guardError("create_only_scope", "Create-only requires an unowned, unheld backlog Card, without force, PR or branch metadata.");
  }
}
export async function createOnlyCard(opts: { node: NodeClient; cfg: Config }, card: Card): Promise<CreateOnlyReceipt> {
  assertCreateOnlyScope(card);
  const schemaHash = schemaHashFor("card", opts.cfg);
  const fields = validateRawFields(cardToFields(card), card.slug);
  const witness = { version: 1 as const, schema_hash: schemaHash, fields };
  serializeSnapshot(witness);
  const hashes = multiKey(opts.cfg) ? [] : boardCardsWriteHashes(opts.cfg);
  const build = await opts.node.nodeVersion?.();
  const supported = multiKey(opts.cfg) ? await ownedCardBatchSupported(opts.node)
    : build?.handshake && typeof build.build === "string" && COMPOUND_CARD_BUILDS.includes(build.build);
  if (!supported || !opts.node.updateRecords || !opts.node.getSchema ||
      (!multiKey(opts.cfg) && (hashes.length < 1 || hashes.length > CREATE_ONLY_CONTRACT.max_board_destinations))) {
    guardError("create_only_unsupported", "The exact proved node build, atomic batch and BoardCards destinations are required.");
  }
  const boardFields = boardCardFieldsFromCard(card);
  for (const key of Object.keys(boardFields)) if (key in fields) boardFields[key] = fields[key];
  const payloads = [
    { hash: schemaHash, fields, hashField: "slug", rangeField: null },
    ...hashes.map(hash => ({ hash, fields: boardFields, hashField: "board", rangeField: "sk" })),
  ];
  const schemas = await Promise.all(payloads.map(p => opts.node.getSchema!(p.hash)));
  for (const [number, payload] of payloads.entries()) {
    const schema = schemas[number]!;
    const completeCard = number !== 0 || (schema.fields.length === CARD_FIELDS.length &&
      new Set(schema.fields).size === CARD_FIELDS.length && CARD_FIELDS.every(field => schema.fields.includes(field)));
    if (!completeCard || schema.key.hash_field !== payload.hashField || schema.key.range_field !== payload.rangeField ||
        Object.keys(payload.fields).some(field => !schema.fields.includes(field))) {
      guardError("create_only_schema", "The live schemas must declare the exact Card and BoardCards keys and fields.");
    }
  }
  requireListHeadHash(opts.cfg);
  await opts.node.updateRecords([
    ...CARD_FIELDS.map(field => ({ schemaHash, keyHash: card.slug,
      fields: { [field]: fields[field]! },
      expected: { type: "absent" as const, field }, durability: "durable" as const })),
    { schemaHash, keyHash: card.slug, fields, expected: { type: "absent", field: "updated_at" }, durability: "durable" },
    ...hashes.map(hash => ({ schemaHash: hash, keyHash: String(boardFields.board), rangeKey: String(boardFields.sk),
      fields: boardFields, durability: "durable" as const })),
  ]);
  // Never retry a write with an unknown ack. A mismatch keeps the caller's intent held.
  const actual = await captureSnapshot(opts.node, opts.cfg, card.slug);
  if (!rawEqual(actual.fields, fields)) guardError("create_only_readback_conflict", "The durable create completed, but exact canonical readback differs. Keep the filing intent held.");
  // The proved batch stays Card + BoardCards. The column head follows the readback.
  await maintainCardHead(opts, card, null);
  const json = serializeSnapshot(witness);
  return { next_snapshot_json: json, next_snapshot_sha256: sha256(json), durability: "durable",
    contract_sha256: multiKey(opts.cfg) ? OWNED_CREATE_ONLY_CONTRACT_SHA256 : CREATE_ONLY_CONTRACT_SHA256,
    card_guarded_contract_sha256: multiKey(opts.cfg) ? OWNED_GUARDED_CONTRACT_SHA256 : GUARDED_CONTRACT_SHA256,
    absence_guard: "all23-absent", membership_cleanup: multiKey(opts.cfg) ? "native" : "deferred" };
}
