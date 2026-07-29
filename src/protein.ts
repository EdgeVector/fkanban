// Protein multi-key membership — core coherence for BoardCards ↔ MilestoneCards.
//
// design-lastdb-protein-molecule-set: a protein binds differently-keyed member
// molecules so they share one atom set. When both field molecules can join the
// same protein, fold propagates tips. When they cannot (already bound to
// different proteins), we still write BOTH keys explicitly with the same
// content-addressed atom payload so partitions stay coherent.
//
// **Protein-primary (milestone-lastdb-fkanban-protein-primary):**
// writeMembershipViaProtein is the success path. Dual-write is only a fallback
// when Mini has no protein routes, or when FKANBAN_DUAL_WRITE_FALLBACK=1.
// Partial protein success must not skip dual-write when fallback is allowed,
// and must not silently dual-write when protein-primary forbids fallback.
//
// writeMembershipViaProtein returns true ONLY when multi-key views agree after
// the write (or sole board membership when milestone is empty).

import { createHash } from "node:crypto";
import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT, MILESTONE_CARDS_LAYOUT } from "./schemas.ts";
import {
  boardCardsHash,
  boardCardFieldsFromCard,
  listBoardCardsPartition,
} from "./board-cards.ts";
import {
  milestoneCardsHash,
  milestoneCardFieldsFromCard,
  listMilestoneCardsPartition,
} from "./milestone-cards.ts";
import type { Card } from "./record.ts";
import type { CardSummary } from "./card-list-index.ts";

export const PROTEIN_SCHEMA_MARKER = "lastdb.protein.v1";

/** Shared thin fields that both partitions must agree on after a protein write. */
export const SHARED_COHERENCE_FIELDS = [
  "slug",
  "title",
  "column",
  "position",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "kind",
  "board",
  "milestone",
] as const;

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
// Live schema pin → field → molecule uuid (from field_molecule_uuids).
const fieldMolCache = new Map<string, Record<string, string>>();

export function resetProteinCaches(): void {
  proteinAvail = undefined;
  fieldMolCache.clear();
}

/**
 * Parse a boolean-ish env flag. Undefined / empty → null (use default policy).
 */
function envTriState(name: string): boolean | null {
  const raw = process.env[name]?.trim().toLowerCase();
  if (!raw) return null;
  if (raw === "1" || raw === "true" || raw === "yes" || raw === "on") return true;
  if (raw === "0" || raw === "false" || raw === "no" || raw === "off") return false;
  return null;
}

/**
 * Whether app dual-write of BoardCards + MilestoneCards is allowed after a
 * failed/unavailable protein membership write.
 *
 * Default (protein-primary):
 * - Protein routes **available** → dual-write **off** (set FKANBAN_DUAL_WRITE_FALLBACK=1 to restore).
 * - Protein routes **missing** → dual-write **on** so old Mini still works.
 *
 * FKANBAN_REQUIRE_PROTEIN=1: never dual-write; throw if protein cannot serve multi-key.
 */
export function dualWriteFallbackEnabled(proteinRoutesAvailable: boolean): boolean {
  if (envTriState("FKANBAN_REQUIRE_PROTEIN") === true) return false;
  const explicit = envTriState("FKANBAN_DUAL_WRITE_FALLBACK");
  if (explicit !== null) return explicit;
  return !proteinRoutesAvailable;
}

export class ProteinMembershipError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProteinMembershipError";
  }
}

export type MembershipWriteOpts = {
  /** Create path: skip orphan partition scan (no prior sk). */
  skipOrphanPurge?: boolean;
};

/**
 * After writeMembershipViaProtein returns false: dual-write if allowed, else throw.
 */
export async function applyMembershipAfterProtein(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous: Card | CardSummary | null | undefined,
  opts: MembershipWriteOpts = {},
): Promise<"dual-write" | never> {
  const available = await proteinAvailable(node);
  if (!dualWriteFallbackEnabled(available)) {
    if (!available) {
      throw new ProteinMembershipError(
        "Multi-key membership requires Mini protein routes (/api/protein/*) " +
          "but they are unavailable. Upgrade lastdbd, or set FKANBAN_DUAL_WRITE_FALLBACK=1 " +
          "for legacy dual-write (not protein-primary).",
      );
    }
    throw new ProteinMembershipError(
      "Protein membership write failed or partitions disagree after fold. " +
        "Dual-write fallback is disabled (protein-primary). Fix protein/coherence " +
        "or set FKANBAN_DUAL_WRITE_FALLBACK=1 to force legacy dual-write.",
    );
  }
  const { upsertBoardCard } = await import("./board-cards.ts");
  const { upsertMilestoneCard } = await import("./milestone-cards.ts");
  await upsertBoardCard(node, cfg, card, previous ?? null, {
    skipOrphanPurge: opts.skipOrphanPurge,
  });
  await upsertMilestoneCard(node, cfg, card, previous ?? null);
  return "dual-write";
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

/** Parse "already bound to protein <id>" from a 400 body. */
function alreadyBoundProteinUuid(body: unknown): string | null {
  const msg =
    typeof body === "string"
      ? body
      : body && typeof body === "object"
        ? JSON.stringify(body)
        : "";
  // Accept UUID or other non-empty protein ids used by tests / Mini.
  const m = msg.match(/already bound to protein ([^\s"',}]+)/i);
  return m?.[1] ?? null;
}

/**
 * Ensure `molecule` is a protein member under `hashField`/`rangeField`.
 * Returns the protein uuid used, or null on hard failure.
 *
 * Does NOT require two molecules to share one protein — when they are already
 * bound to different proteins we keep each on its own protein and write both
 * keys explicitly (same content → same content-addressed atom).
 */
async function ensureMemberProtein(
  node: NodeClient,
  moleculeUuid: string,
  hashField: string,
  rangeField: string,
): Promise<string | null> {
  const created = await node.rawCall("POST", "/api/protein", {});
  if (created.status !== 200 && created.status !== 201) return null;
  const body = (created.json && typeof created.json === "object"
    ? created.json
    : {}) as Record<string, unknown>;
  let uuid = typeof body.uuid === "string" ? body.uuid : "";
  if (!uuid) return null;

  const add = await node.rawCall("POST", "/api/protein/member", {
    protein_uuid: uuid,
    molecule_uuid: moleculeUuid,
    hash_field: hashField,
    range_field: rangeField,
  });
  if (add.status === 200 || add.status === 201) return uuid;

  const adopted = alreadyBoundProteinUuid(add.json ?? add.body);
  if (!adopted) return null;

  // Molecule already on another protein — ensure this layout is registered there.
  const add2 = await node.rawCall("POST", "/api/protein/member", {
    protein_uuid: adopted,
    molecule_uuid: moleculeUuid,
    hash_field: hashField,
    range_field: rangeField,
  });
  if (add2.status === 200 || add2.status === 201) return adopted;
  // Already has this exact layout on that protein.
  if (alreadyBoundProteinUuid(add2.json ?? add2.body) === adopted) return adopted;
  // Molecule is on that protein; layout may already match — still usable for writes.
  return adopted;
}

/**
 * Write one field tip via protein on `entryMol` under the given key field map.
 * Returns true only when the node reports used_protein_path.
 */
async function proteinWriteField(
  node: NodeClient,
  entryMol: string,
  fields: Record<string, string>,
  content: unknown,
): Promise<boolean> {
  const write = await node.rawCall("POST", "/api/protein/write", {
    entry_molecule_uuid: entryMol,
    fields,
    content: content === undefined ? null : content,
    sync_fold: true,
  });
  if (write.status === 404 || write.status === 405) {
    proteinAvail = false;
    return false;
  }
  if (write.status !== 200 && write.status !== 201) return false;
  const wb = (write.json && typeof write.json === "object"
    ? write.json
    : {}) as Record<string, unknown>;
  return wb.used_protein_path !== false;
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

function normalizeComparable(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/**
 * Compare shared coherence fields between a board-partition card and a
 * milestone-partition card. Returns true when all SHARED_COHERENCE_FIELDS match.
 */
export function membershipPartitionsAgree(
  boardRow: Card | CardSummary | null | undefined,
  msRow: Card | CardSummary | null | undefined,
  opts: { requireMilestone: boolean },
): boolean {
  if (!boardRow || !boardRow.slug) return false;
  if (!opts.requireMilestone) return true;
  if (!msRow || !msRow.slug) return false;
  if (boardRow.slug !== msRow.slug) return false;
  for (const f of SHARED_COHERENCE_FIELDS) {
    if (f === "milestone") {
      // Milestone partition always has the partition key; board row must match.
      const want = normalizeComparable((msRow as Card).milestone ?? "");
      const got = normalizeComparable((boardRow as Card).milestone ?? "");
      if (want && want !== got) return false;
      continue;
    }
    const a = normalizeComparable((boardRow as Record<string, unknown>)[f]);
    const b = normalizeComparable((msRow as Record<string, unknown>)[f]);
    if (a !== b) return false;
  }
  return true;
}

/**
 * After a protein membership write, re-list both partitions and verify shared
 * fields agree. Used as the gate for "used protein path / skip dual-write".
 */
export async function verifyMembershipCoherence(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
): Promise<boolean> {
  const board = card.board || "default";
  const milestone = ((card as Card).milestone ?? "").trim();
  const boardPart = await listBoardCardsPartition(node, cfg, board);
  const boardRow = (boardPart ?? []).find((c) => c.slug === card.slug);
  if (!boardRow) return false;
  if (!milestone) return true;
  const msPart = await listMilestoneCardsPartition(node, cfg, milestone);
  const msRow = (msPart ?? []).find((c) => c.slug === card.slug);
  return membershipPartitionsAgree(boardRow, msRow, { requireMilestone: true });
}

/**
 * Write multi-key membership (BoardCards + MilestoneCards) via protein.
 *
 * For every shared field, writes the board-keyed tip and (when milestone is
 * set) the milestone-keyed tip explicitly with the same content. Fold is used
 * when both molecules share a protein; explicit dual-key protein writes cover
 * the already-bound-to-different-proteins case.
 *
 * Returns true ONLY when:
 * - protein routes are available, AND
 * - every required protein write succeeded with used_protein_path, AND
 * - post-write partition re-list shows multi-key agreement.
 *
 * Partial protein success returns false so the caller dual-writes.
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
  const boardFieldMap = stringFieldMap({
    ...boardFields,
    layout: BOARD_CARDS_LAYOUT,
  });
  const msFieldMap = stringFieldMap({
    ...(msFields ?? boardFields),
    layout: MILESTONE_CARDS_LAYOUT,
  });
  // Unified map for content (includes board + milestone + sk).
  const fieldMap = stringFieldMap({
    ...boardFields,
    ...(msFields ?? {}),
  });

  const hasMilestone = Boolean((fieldMap.milestone ?? "").trim());
  const boardMols = await liveFieldMolecules(node, boardSchema);
  const msMols = await liveFieldMolecules(node, msSchema);

  // ── Shared payload fields: write board tip + (if needed) ms tip ─────────
  for (const field of SHARED_MEMBERSHIP_FIELDS) {
    if (!(field in boardFields)) continue;
    const molBoard = molForField(boardMols, boardSchema, field);
    const content = boardFields[field];

    const boardProtein = await ensureMemberProtein(node, molBoard, "board", "sk");
    if (!boardProtein) return false;
    if (!(await proteinWriteField(node, molBoard, boardFieldMap, content))) {
      return false;
    }

    if (hasMilestone) {
      const molMs = molForField(msMols, msSchema, field);
      // Prefer bind both into board's protein for fold; if that fails, own protein.
      const tryJoin = await node.rawCall("POST", "/api/protein/member", {
        protein_uuid: boardProtein,
        molecule_uuid: molMs,
        hash_field: "milestone",
        range_field: "sk",
      });
      if (tryJoin.status === 200 || tryJoin.status === 201) {
        // Unified: re-write via board entry so fold can repoint ms (sync_fold).
        if (!(await proteinWriteField(node, molBoard, fieldMap, content))) {
          return false;
        }
      } else {
        // Separate proteins: write ms tip explicitly with same content.
        const msProtein = await ensureMemberProtein(node, molMs, "milestone", "sk");
        if (!msProtein) return false;
        if (!(await proteinWriteField(node, molMs, msFieldMap, content))) {
          return false;
        }
      }
    }
  }

  // ── Schema-specific key fields ──────────────────────────────────────────
  const boardKeyFields: Array<{ field: string; content: string }> = [
    { field: "board", content: boardFieldMap.board ?? "default" },
    { field: "sk", content: boardFieldMap.sk ?? "" },
    { field: "layout", content: BOARD_CARDS_LAYOUT },
  ];
  for (const { field, content } of boardKeyFields) {
    const mol = molForField(boardMols, boardSchema, field);
    if (!(await ensureMemberProtein(node, mol, "board", "sk"))) return false;
    if (!(await proteinWriteField(node, mol, boardFieldMap, content))) return false;
  }

  if (hasMilestone) {
    const msKeyFields: Array<{ field: string; content: string }> = [
      { field: "milestone", content: msFieldMap.milestone ?? "" },
      { field: "sk", content: msFieldMap.sk ?? "" },
      { field: "layout", content: MILESTONE_CARDS_LAYOUT },
    ];
    for (const { field, content } of msKeyFields) {
      const mol = molForField(msMols, msSchema, field);
      if (!(await ensureMemberProtein(node, mol, "milestone", "sk"))) return false;
      if (!(await proteinWriteField(node, mol, msFieldMap, content))) return false;
    }
  }

  // ── Coherence gate: never skip dual-write unless partitions agree ───────
  const ok = await verifyMembershipCoherence(node, cfg, card);
  return ok;
}
