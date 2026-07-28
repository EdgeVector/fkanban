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
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT, MILESTONE_CARDS_LAYOUT } from "./schemas.ts";
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
// Live schema pin → field → molecule uuid (from field_molecule_uuids).
const fieldMolCache = new Map<string, Record<string, string>>();

export function resetProteinCaches(): void {
  proteinAvail = undefined;
  fieldProtein.clear();
  fieldMolCache.clear();
}

async function liveFieldMolecules(
  node: NodeClient,
  schemaHash: string,
): Promise<Record<string, string>> {
  const cached = fieldMolCache.get(schemaHash);
  if (cached) return cached;
  const res = await node.rawCall("GET", `/api/schema/${encodeURIComponent(schemaHash)}`);
  const schema = (res.json && typeof res.json === "object"
    ? (res.json as Record<string, unknown>).schema ?? res.json
    : {}) as Record<string, unknown>;
  const raw =
    (schema.field_molecule_uuids as Record<string, string> | undefined) ??
    (schema.molecule_uuids as Record<string, string> | undefined) ??
    {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw)) {
    if (typeof v === "string" && v.length > 0) out[k] = v;
  }
  fieldMolCache.set(schemaHash, out);
  return out;
}

function molForField(
  live: Record<string, string>,
  schemaHash: string,
  field: string,
): string {
  return live[field] || moleculeUuid(schemaHash, field);
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

/** Parse "already bound to protein <uuid>" from a 400 body. */
function alreadyBoundProteinUuid(body: unknown): string | null {
  const msg =
    typeof body === "string"
      ? body
      : body && typeof body === "object"
        ? JSON.stringify(body)
        : "";
  const m = msg.match(/already bound to protein ([0-9a-f-]{36})/i);
  return m?.[1] ?? null;
}

async function ensureFieldProtein(
  node: NodeClient,
  _boardSchema: string,
  _milestoneSchema: string,
  field: string,
  molBoard: string,
  molMs: string,
): Promise<string> {
  const cacheKey = `${molBoard}|${molMs}|${field}`;
  const cached = fieldProtein.get(cacheKey);
  if (cached) return cached;

  // Start a new protein; if either molecule is already bound, adopt that protein.
  let uuid = "";
  const created = await node.rawCall("POST", "/api/protein", {});
  if (created.status === 200 || created.status === 201) {
    const body = (created.json && typeof created.json === "object"
      ? created.json
      : {}) as Record<string, unknown>;
    uuid = typeof body.uuid === "string" ? body.uuid : "";
  }
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
    if (add.status === 200 || add.status === 201) continue;
    const adopted = alreadyBoundProteinUuid(add.json ?? add.body);
    if (adopted) {
      // Switch to the protein that already owns this molecule and re-add sibling.
      uuid = adopted;
      const add2 = await node.rawCall("POST", "/api/protein/member", {
        protein_uuid: uuid,
        ...member,
      });
      // Sibling may already be on this protein (ok) or the same layout (ok).
      if (add2.status !== 200 && add2.status !== 201) {
        const again = alreadyBoundProteinUuid(add2.json ?? add2.body);
        if (again && again === uuid) continue;
        // Other member might be the other layout on same protein — try once more
        // for the remaining member with adopted uuid only.
        continue;
      }
      continue;
    }
    throw new Error(
      `protein add member failed for ${field}/${member.molecule_uuid}: status=${add.status} ${JSON.stringify(add.json ?? add.body)}`,
    );
  }

  // Ensure both layouts are members of the adopted protein.
  for (const member of [
    { molecule_uuid: molBoard, hash_field: "board", range_field: "sk" },
    { molecule_uuid: molMs, hash_field: "milestone", range_field: "sk" },
  ]) {
    await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: uuid,
      ...member,
    });
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

  const boardMols = await liveFieldMolecules(node, boardSchema);
  const msMols = await liveFieldMolecules(node, msSchema);

  let any = false;
  for (const field of SHARED_MEMBERSHIP_FIELDS) {
    if (!(field in boardFields)) continue;
    const molBoard = molForField(boardMols, boardSchema, field);
    const molMs = molForField(msMols, msSchema, field);

    if (hasMilestone) {
      try {
        await ensureFieldProtein(node, boardSchema, msSchema, field, molBoard, molMs);
      } catch (err) {
        // If bind fails (e.g. molecule already in another protein), fall back
        // to dual-write for the whole card.
        console.error?.(`[protein] ensureFieldProtein ${field}: ${err}`);
        return false;
      }
    } else {
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

    const content = boardFields[field];
    const write = await node.rawCall("POST", "/api/protein/write", {
      entry_molecule_uuid: molBoard,
      fields: fieldMap,
      content: content === undefined ? null : content,
      sync_fold: true,
    });
    if (write.status === 404 || write.status === 405) {
      proteinAvail = false;
      return false;
    }
    if (write.status !== 200 && write.status !== 201) {
      // Soft-fail to dual-write rather than abort the card mutation.
      return false;
    }
    const wb = (write.json && typeof write.json === "object"
      ? write.json
      : {}) as Record<string, unknown>;
    if (wb.used_protein_path === false) return false;
    any = true;
  }

  // Key fields for list reconstruction under each schema's live molecules.
  // Layout is schema-specific (board vs milestone layout markers filter lists).
  const keyWrites: Array<{
    schema: string;
    live: Record<string, string>;
    field: string;
    hashField: string;
    content: string;
    fields: Record<string, string>;
  }> = [
    {
      schema: boardSchema,
      live: boardMols,
      field: "board",
      hashField: "board",
      content: fieldMap.board ?? "default",
      fields: { ...fieldMap, layout: BOARD_CARDS_LAYOUT },
    },
    {
      schema: boardSchema,
      live: boardMols,
      field: "sk",
      hashField: "board",
      content: fieldMap.sk ?? "",
      fields: { ...fieldMap, layout: BOARD_CARDS_LAYOUT },
    },
    {
      schema: boardSchema,
      live: boardMols,
      field: "layout",
      hashField: "board",
      content: BOARD_CARDS_LAYOUT,
      fields: { ...fieldMap, layout: BOARD_CARDS_LAYOUT },
    },
  ];
  if (hasMilestone) {
    keyWrites.push(
      {
        schema: msSchema,
        live: msMols,
        field: "milestone",
        hashField: "milestone",
        content: fieldMap.milestone ?? "",
        fields: { ...fieldMap, layout: MILESTONE_CARDS_LAYOUT },
      },
      {
        schema: msSchema,
        live: msMols,
        field: "sk",
        hashField: "milestone",
        content: fieldMap.sk ?? "",
        fields: { ...fieldMap, layout: MILESTONE_CARDS_LAYOUT },
      },
      {
        schema: msSchema,
        live: msMols,
        field: "layout",
        hashField: "milestone",
        content: MILESTONE_CARDS_LAYOUT,
        fields: { ...fieldMap, layout: MILESTONE_CARDS_LAYOUT },
      },
    );
  }

  for (const kw of keyWrites) {
    const mol = molForField(kw.live, kw.schema, kw.field);
    const created = await node.rawCall("POST", "/api/protein", {});
    if (created.status !== 200 && created.status !== 201) continue;
    const b = (created.json && typeof created.json === "object"
      ? created.json
      : {}) as Record<string, unknown>;
    const uuid = typeof b.uuid === "string" ? b.uuid : "";
    if (!uuid) continue;
    const add = await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: uuid,
      molecule_uuid: mol,
      hash_field: kw.hashField,
      range_field: "sk",
    });
    if (add.status !== 200 && add.status !== 201) {
      const adopted = alreadyBoundProteinUuid(add.json ?? add.body);
      if (!adopted) continue;
      await node.rawCall("POST", "/api/protein/member", {
        protein_uuid: adopted,
        molecule_uuid: mol,
        hash_field: kw.hashField,
        range_field: "sk",
      });
    }
    const write = await node.rawCall("POST", "/api/protein/write", {
      entry_molecule_uuid: mol,
      fields: kw.fields,
      content: kw.content,
      sync_fold: true,
    });
    if (write.status === 200 || write.status === 201) any = true;
  }

  // Shared payload fields must also fold layout-correct values: rewrite layout
  // on the milestone member alone so listMilestoneCards layout filter matches.
  if (hasMilestone) {
    const molMsLayout = molForField(msMols, msSchema, "layout");
    // already written above
    void molMsLayout;
  }

  return any;
}
