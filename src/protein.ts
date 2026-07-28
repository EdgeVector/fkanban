// Protein multi-key membership — core coherence for BoardCards ↔ MilestoneCards.
//
// design-lastdb-protein-molecule-set: a protein binds differently-keyed member
// molecules so they share one atom set. A write via the board member updates
// that tip + atom immediately; fold repoints the milestone member (and any
// other siblings). App dual-write of independent copies is no longer the
// coherence mechanism on the active path when the node supports proteins.
//
// Falls back to false from `proteinAvailable` when the node returns 404 so
// older Minis keep working via the legacy dual-write path.

import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
import { BOARD_CARDS_FIELDS } from "./schemas.ts";
import { boardCardsHash, boardCardFieldsFromCard } from "./board-cards.ts";
import { milestoneCardsHash, milestoneCardFieldsFromCard } from "./milestone-cards.ts";
import type { Card } from "./record.ts";
import type { CardSummary } from "./card-list-index.ts";

export const PROTEIN_SCHEMA_MARKER = "lastdb.protein.v1";

/** Deterministic molecule UUID — mirrors fold_db `deterministic_molecule_uuid`. */
export function moleculeUuid(schemaName: string, fieldName: string): string {
  return createHash("sha256").update(`${schemaName}:${fieldName}`).digest("hex");
}

/** Shared thin fields present on both BoardCards and MilestoneCards. */
const SHARED_MEMBERSHIP_FIELDS = BOARD_CARDS_FIELDS.filter(
  (f) => f !== "board" && f !== "sk" && f !== "layout",
) as readonly string[];

// Cache: whether this node has protein routes (undefined = unknown).
let proteinAvail: boolean | undefined;
// Cache protein UUID per shared field (process-local).
const fieldProtein = new Map<string, string>();

export function resetProteinCaches(): void {
  proteinAvail = undefined;
  fieldProtein.clear();
}

/**
 * Probe protein routes. Returns false on 404/405 so callers fall back to
 * legacy dual-write. Caches the positive/negative for the process.
 */
export async function proteinAvailable(node: NodeClient): Promise<boolean> {
  if (proteinAvail !== undefined) return proteinAvail;
  try {
    // Fold is a no-op when the queue is empty — probes route presence without
    // creating durable protein records.
    const res = await node.rawCall("POST", "/api/protein/fold", { max_jobs: 0 });
    if (res.status === 404 || res.status === 405) {
      proteinAvail = false;
      return false;
    }
    proteinAvail = res.status === 200 || res.status === 201;
    return proteinAvail;
  } catch {
    proteinAvail = false;
    return false;
  }
}

async function ensureFieldProtein(
  node: NodeClient,
  boardSchema: string,
  milestoneSchema: string,
  field: string,
): Promise<string> {
  const cacheKey = `${boardSchema}|${milestoneSchema}|${field}`;
  const cached = fieldProtein.get(cacheKey);
  if (cached) return cached;

  const molBoard = moleculeUuid(boardSchema, field);
  const molMs = moleculeUuid(milestoneSchema, field);

  const created = await node.rawCall("POST", "/api/protein", {});
  if (created.status !== 200 && created.status !== 201) {
    throw new Error(
      `protein create failed: status=${created.status} body=${JSON.stringify(created.json ?? created.body)}`,
    );
  }
  const body = (created.json && typeof created.json === "object"
    ? created.json
    : {}) as Record<string, unknown>;
  const uuid = typeof body.uuid === "string" ? body.uuid : "";
  if (!uuid) {
    throw new Error(`protein create returned no uuid: ${JSON.stringify(created.json ?? created.body)}`);
  }

  for (const member of [
    { molecule_uuid: molBoard, hash_field: "board", range_field: "sk" },
    { molecule_uuid: molMs, hash_field: "milestone", range_field: "sk" },
  ]) {
    const add = await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: uuid,
      ...member,
    });
    if (add.status !== 200 && add.status !== 201) {
      throw new Error(
        `protein add member failed for ${field}/${member.molecule_uuid}: status=${add.status}`,
      );
    }
  }

  fieldProtein.set(cacheKey, uuid);
  return uuid;
}

function stringFieldMap(fields: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === null || v === undefined) continue;
    if (typeof v === "string") out[k] = v;
    else if (typeof v === "number" || typeof v === "boolean") out[k] = String(v);
    else out[k] = JSON.stringify(v);
  }
  return out;
}

/**
 * Write multi-key membership (BoardCards + MilestoneCards) via protein.
 *
 * Uses the board-keyed member as the entry write; fold (sync by default on
 * Mini) repoints the milestone-keyed member to the same shared atoms.
 *
 * Returns true when the protein path was used; false when the node has no
 * protein routes (caller should dual-write).
 */
export async function writeMembershipViaProtein(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
): Promise<boolean> {
  if (!(await proteinAvailable(node))) return false;

  const boardSchema = boardCardsHash(cfg);
  const msSchema = milestoneCardsHash(cfg);
  if (!boardSchema || !msSchema) return false;

  const boardFields = boardCardFieldsFromCard(card);
  const msFields = milestoneCardFieldsFromCard(card);
  // Merge so the field map always has board + sk + milestone (when present).
  const fieldMap = stringFieldMap({
    ...boardFields,
    ...(msFields ?? {}),
  });

  // Without a milestone, only the board member is written (sole member ok).
  const hasMilestone = Boolean((fieldMap.milestone ?? "").trim());

  let any = false;
  for (const field of SHARED_MEMBERSHIP_FIELDS) {
    if (!(field in boardFields)) continue;
    if (hasMilestone) {
      await ensureFieldProtein(node, boardSchema, msSchema, field);
    } else {
      // Sole board member protein still registers for later milestone bind.
      const molBoard = moleculeUuid(boardSchema, field);
      const created = await node.rawCall("POST", "/api/protein", {});
      if (created.status !== 200 && created.status !== 201) continue;
      const b = (created.json && typeof created.json === "object"
        ? created.json
        : {}) as Record<string, unknown>;
      const uuid = typeof b.uuid === "string" ? b.uuid : "";
      if (!uuid) continue;
      await node.rawCall("POST", "/api/protein/member", {
        protein_uuid: uuid,
        molecule_uuid: molBoard,
        hash_field: "board",
        range_field: "sk",
      });
    }

    const entryMol = moleculeUuid(boardSchema, field);
    const content = boardFields[field];
    const write = await node.rawCall("POST", "/api/protein/write", {
      entry_molecule_uuid: entryMol,
      fields: fieldMap,
      content: content === undefined ? null : content,
      sync_fold: true,
    });
    if (write.status === 404 || write.status === 405) {
      proteinAvail = false;
      return false;
    }
    if (write.status !== 200 && write.status !== 201) {
      throw new Error(
        `protein write failed for field=${field}: status=${write.status} body=${JSON.stringify(write.json ?? write.body)}`,
      );
    }
    const wb = (write.json && typeof write.json === "object"
      ? write.json
      : {}) as Record<string, unknown>;
    // Evidence flag for live proof: used_protein_path must be true.
    if (wb.used_protein_path === false) {
      throw new Error(`protein write did not use protein path for field=${field}`);
    }
    any = true;
  }

  // Also write board/sk/milestone key fields so list reconstruction has
  // partition keys under protein tips.
  for (const keyField of ["board", "sk", "milestone"] as const) {
    if (keyField === "milestone" && !hasMilestone) continue;
    const schemaForKey = keyField === "milestone" ? msSchema : boardSchema;
    const mol = moleculeUuid(schemaForKey, keyField);
    const created = await node.rawCall("POST", "/api/protein", {});
    if (created.status !== 200 && created.status !== 201) continue;
    const b = (created.json && typeof created.json === "object"
      ? created.json
      : {}) as Record<string, unknown>;
    const uuid = typeof b.uuid === "string" ? b.uuid : "";
    if (!uuid) continue;
    await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: uuid,
      molecule_uuid: mol,
      hash_field: keyField === "milestone" ? "milestone" : "board",
      range_field: "sk",
    });
    const write = await node.rawCall("POST", "/api/protein/write", {
      entry_molecule_uuid: mol,
      fields: fieldMap,
      content: fieldMap[keyField] ?? "",
      sync_fold: true,
    });
    if (write.status === 200 || write.status === 201) any = true;
  }

  return any;
}
