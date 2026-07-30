import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  cardSchema,
  boardSchema,
  milestoneSchema,
  cardListIndexSchema,
  boardCardsSchema,
  boardMilestonesSchema,
  milestoneCardsSchema,
  type AddSchemaRequest,
} from "../src/schemas.ts";

// Reproduce the NODE's schema-identity hash exactly (see fold
// schema_service/crates/schema_types/src/declarative_schemas/identity.rs):
//   sha256( "app:" + owner_app_id + ":" + descriptive_name + ":" + sorted(dedup(fields)).join(",") )
// The identity hash is what Mini's exact-catalog lookup pins to; two fkanban
// schemas that hash the same collapse onto one canonical identity.
function nodeIdentityHash(req: AddSchemaRequest): string {
  const s = req.schema;
  const fields = [...new Set([...s.fields])].sort();
  const readable = s.descriptive_name && s.descriptive_name.length > 0 ? s.descriptive_name : s.name;
  const h = createHash("sha256");
  if (s.owner_app_id && s.owner_app_id.length > 0) {
    h.update("app:");
    h.update(s.owner_app_id);
    h.update(":");
  }
  h.update(readable);
  h.update(":");
  h.update(fields.join(","));
  return h.digest("hex");
}

const ALL: Array<[string, AddSchemaRequest]> = [
  ["card", cardSchema],
  ["board", boardSchema],
  ["milestone", milestoneSchema],
  ["card_list_index", cardListIndexSchema],
  ["board_cards", boardCardsSchema],
  ["board_milestones", boardMilestonesSchema],
  ["milestone_cards", milestoneCardsSchema],
];

describe("fkanban schema identity distinctness", () => {
  test("every schema has a pairwise-distinct node identity hash", () => {
    const byHash = new Map<string, string>();
    for (const [key, req] of ALL) {
      const hash = nodeIdentityHash(req);
      const clash = byHash.get(hash);
      expect(clash, `${key} and ${clash} compute the SAME node identity hash — they will collapse onto one canonical schema`).toBeUndefined();
      byHash.set(hash, key);
    }
    expect(byHash.size).toBe(ALL.length);
  });

  test("every schema has a pairwise-distinct descriptive_name", () => {
    const byName = new Map<string, string>();
    for (const [key, req] of ALL) {
      const name = req.schema.descriptive_name;
      const clash = byName.get(name);
      expect(clash, `${key} and ${clash} share descriptive_name "${name}"`).toBeUndefined();
      byName.set(name, key);
    }
  });

  // Root-cause guard for the 2026-07-23 expand bug: Mini's declare resolver
  // embeds the descriptive_name and expands/reuses the nearest catalog schema.
  // A milestone-index name that carries card/board-index vocabulary embeds next
  // to `BoardCards_hashrange_v1` and collapses onto it (dropping completed_at).
  // `board_milestones` only mints a clean own-schema when its name is card-free.
  test("board_milestones descriptive_name stays card-free (no BoardCards collision)", () => {
    const name = boardMilestonesSchema.schema.descriptive_name.toLowerCase();
    for (const token of ["card", "boardcards", "hashrange"]) {
      expect(name.includes(token), `board_milestones descriptive_name "${boardMilestonesSchema.schema.descriptive_name}" must not contain "${token}" — it re-collapses onto BoardCards`).toBe(false);
    }
    // and it must not equal the board_cards name
    expect(boardMilestonesSchema.schema.descriptive_name).not.toBe(boardCardsSchema.schema.descriptive_name);
  });

  test("board_milestones keeps completed_at in its own field set", () => {
    expect(boardMilestonesSchema.schema.fields).toContain("completed_at");
  });

  test("BoardCards and MilestoneCards share matching field descriptions except key-local layout", () => {
    const boardDescriptions = boardCardsSchema.schema.field_descriptions;
    const milestoneDescriptions = milestoneCardsSchema.schema.field_descriptions;

    for (const field of ["board", "milestone", "sk", "assignee", "created_by"]) {
      expect(
        milestoneDescriptions[field],
        `${field} should fold through the same field identity`,
      ).toBe(boardDescriptions[field]);
    }

    expect(milestoneDescriptions.layout).not.toBe(boardDescriptions.layout);
  });
});
