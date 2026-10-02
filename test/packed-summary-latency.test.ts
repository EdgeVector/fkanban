import { describe, expect, test } from "bun:test";
import {
  LATENCY_COMPARE_SUBSET,
  medianMs,
  packEqualFieldMap,
} from "../src/packed-summary.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

describe("packed summary latency helpers", () => {
  test("median of an odd count is the middle value", () => {
    expect(medianMs([9, 1, 5, 3, 7])).toBe(5);
  });

  test("median of an even count is the mean of the two middle values", () => {
    expect(medianMs([1, 2, 3, 4])).toBe(2.5);
  });

  test("the 8-field subset sits inside the wide BoardCards fields", () => {
    const wide = new Set<string>(BOARD_CARDS_FIELDS);
    expect([...LATENCY_COMPARE_SUBSET]).toEqual([
      "slug",
      "title",
      "column",
      "position",
      "milestone",
      "block_status",
      "updated_at",
      "sk",
    ]);
    for (const field of LATENCY_COMPARE_SUBSET) {
      expect(wide.has(field)).toBe(true);
    }
  });

  test("packEqualFieldMap keeps wide field order and values", () => {
    const fields: Record<string, unknown> = {};
    for (const key of BOARD_CARDS_FIELDS) {
      fields[key] = key === "tags" || key === "deps" || key === "surfaces" ? [key] : key;
    }
    const packed = JSON.parse(packEqualFieldMap(fields)) as Record<string, unknown>;
    expect(Object.keys(packed)).toEqual([...BOARD_CARDS_FIELDS]);
    expect(packed.tags).toEqual(["tags"]);
    expect(packed.slug).toBe("slug");
  });
});
