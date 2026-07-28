import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  moleculeUuid,
  PROTEIN_SCHEMA_MARKER,
  resetProteinCaches,
} from "../src/protein.ts";

describe("protein multi-key helpers", () => {
  test("moleculeUuid matches fold_db deterministic_molecule_uuid", () => {
    // Rust: sha256(format!("{schema_name}:{field_name}")) as hex
    const schema = "deadbeef_board_cards_pin";
    const field = "title";
    const expected = createHash("sha256")
      .update(`${schema}:${field}`)
      .digest("hex");
    expect(moleculeUuid(schema, field)).toBe(expected);
    expect(moleculeUuid(schema, "title")).not.toBe(moleculeUuid(schema, "slug"));
  });

  test("PROTEIN_SCHEMA_MARKER is the core contract string", () => {
    expect(PROTEIN_SCHEMA_MARKER).toBe("lastdb.protein.v1");
  });

  test("resetProteinCaches is callable", () => {
    resetProteinCaches();
  });
});
