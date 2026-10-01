import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { boardCardSk } from "../src/board-cards.ts";
import { boardPackedSummarySk, packListSummary, PACKED_SUMMARY_VERSION } from "../src/packed-summary.ts";
import {
  CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS,
  EXTRA_SCHEMAS,
  PACKED_SUMMARY_S_DESCRIPTION,
  SUMMARY_EXPANSION_SCHEMAS,
  boardCardsPackedSummarySchema,
  cardSummarySchema,
  milestoneCardsPackedSummarySchema,
} from "../src/schemas.ts";

const FORBIDDEN_DESCRIPTIVE_TOKENS = ["card", "boardcards", "hashrange"];

function tsFilesUnder(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) {
      out.push(...tsFilesUnder(path));
      continue;
    }
    if (name.endsWith(".ts")) out.push(path);
  }
  return out;
}

describe("packed summary expansion", () => {
  test("field s has one description on every expansion schema", () => {
    const descriptions = [
      boardCardsPackedSummarySchema.schema.field_descriptions.s,
      milestoneCardsPackedSummarySchema.schema.field_descriptions.s,
      cardSummarySchema.schema.field_descriptions.s,
    ];
    expect(new Set(descriptions).size).toBe(1);
    expect(descriptions[0]).toBe(PACKED_SUMMARY_S_DESCRIPTION);
  });

  test("the board packed key matches BoardCards", () => {
    expect(boardPackedSummarySk("todo", 7, "card-a")).toBe(boardCardSk("todo", 7, "card-a"));
    expect(boardCardsPackedSummarySchema.schema.schema_type).toBe("HashRange");
    expect(boardCardsPackedSummarySchema.schema.key).toEqual({
      hash_field: "board",
      range_field: "sk",
    });
  });

  test("the milestone packed key is milestone/sk", () => {
    expect(milestoneCardsPackedSummarySchema.schema.schema_type).toBe("HashRange");
    expect(milestoneCardsPackedSummarySchema.schema.key).toEqual({
      hash_field: "milestone",
      range_field: "sk",
    });
    expect(milestoneCardsPackedSummarySchema.schema.fields).toEqual([
      "milestone",
      "sk",
      "board",
      "s",
    ]);
  });

  test("card summary is a Hash point read by slug", () => {
    expect(cardSummarySchema.schema.schema_type).toBe("Hash");
    expect(cardSummarySchema.schema.key).toEqual({ hash_field: "slug" });
    expect(cardSummarySchema.schema.fields).toEqual(["slug", "s"]);
  });

  test("version lives inside s and body and v are absent", () => {
    for (const req of [
      boardCardsPackedSummarySchema,
      milestoneCardsPackedSummarySchema,
      cardSummarySchema,
    ]) {
      expect(req.schema.fields).not.toContain("v");
      expect(req.schema.fields).not.toContain("body");
    }
    const parsed = JSON.parse(
      packListSummary({ slug: "a", title: "t", column: "todo", position: "1" }),
    ) as Record<string, unknown>;
    expect(parsed.v).toBe(PACKED_SUMMARY_VERSION);
    expect(parsed.body).toBeUndefined();
  });

  test("shared key descriptions match the membership pair", () => {
    for (const field of ["board", "sk", "milestone"] as const) {
      expect(boardCardsPackedSummarySchema.schema.field_descriptions[field]).toBe(
        CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS[field],
      );
      expect(milestoneCardsPackedSummarySchema.schema.field_descriptions[field]).toBe(
        CARD_MEMBERSHIP_SHARED_FIELD_DESCRIPTIONS[field],
      );
    }
  });

  test("init does not register the expansion", () => {
    const extraNames = new Set(EXTRA_SCHEMAS.map((entry) => entry.schema.schema.descriptive_name));
    expect(SUMMARY_EXPANSION_SCHEMAS).toHaveLength(3);
    for (const entry of SUMMARY_EXPANSION_SCHEMAS) {
      const descriptive = entry.schema.schema.descriptive_name.toLowerCase();
      expect(extraNames.has(entry.schema.schema.descriptive_name)).toBe(false);
      for (const token of FORBIDDEN_DESCRIPTIVE_TOKENS) {
        expect(descriptive.includes(token)).toBe(false);
      }
    }
  });

  test("list pickup move and write sources do not name the expansion", () => {
    const roots = [
      join(import.meta.dir, "../src/commands"),
      join(import.meta.dir, "../src/cli.ts"),
      join(import.meta.dir, "../src/record.ts"),
      join(import.meta.dir, "../src/board-cards.ts"),
      join(import.meta.dir, "../src/pickup.ts"),
      join(import.meta.dir, "../src/milestone-cards.ts"),
    ];
    const files = roots.flatMap((path) => (statSync(path).isDirectory() ? tsFilesUnder(path) : [path]));
    const needles = [
      "SUMMARY_EXPANSION_SCHEMAS",
      "boardCardsPackedSummarySchema",
      "milestoneCardsPackedSummarySchema",
      "cardSummarySchema",
      "packListSummary",
    ];
    for (const file of files) {
      const text = readFileSync(file, "utf8");
      for (const needle of needles) {
        expect(text.includes(needle), `${file} names ${needle}`).toBe(false);
      }
    }
  });
});
