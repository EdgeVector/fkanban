import { describe, expect, test } from "bun:test";
import {
  checkMembershipKeyLayout,
  MEMBERSHIP_KEY_EXPECTATIONS,
} from "../src/membership_schema_guard.ts";

describe("membership key layout guard", () => {
  test("BoardCards expects hash_field=board", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    expect(checkMembershipKeyLayout(exp.expected, exp.expected)).toEqual({ ok: true });
    const bad = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
      exp.expected,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("hash_field=milestone");
  });

  test("MilestoneCards expects hash_field=milestone", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "milestone_cards")!;
    expect(
      checkMembershipKeyLayout(
        { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
        exp.expected,
      ),
    ).toEqual({ ok: true });
    const bad = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "board", range_field: "sk" },
      exp.expected,
    );
    expect(bad.ok).toBe(false);
  });

  test("range_field must match", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    const bad = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "board", range_field: "wrong" },
      exp.expected,
    );
    expect(bad.ok).toBe(false);
  });
});
