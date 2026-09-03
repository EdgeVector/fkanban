import { describe, expect, test } from "bun:test";
import {
  checkMembershipKeyLayout,
  checkProjectionParity,
  MEMBERSHIP_KEY_EXPECTATIONS,
  membershipPinLayoutFailures,
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

  test("a sibling hash field is a wrong pin, not an accepted layout", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    expect(exp.alsoAccepts).toBeUndefined();
    const bad = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
      exp.expected,
      exp.alsoAccepts,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("hash_field=milestone");
  });

  test("a hash field belonging to NEITHER lookup still fails", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    const bad = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "slug", range_field: "sk" },
      exp.expected,
      exp.alsoAccepts,
    );
    expect(bad.ok).toBe(false);
    if (!bad.ok) expect(bad.reason).toContain("hash_field=slug");
  });

  test("membershipPinLayoutFailures names a milestone-keyed board_cards pin", () => {
    const fails = membershipPinLayoutFailures(
      { board_cards: "39a0424f" },
      [{ name: "39a0424f", key: { hash_field: "milestone", range_field: "sk" } }],
    );
    expect(fails.length).toBe(1);
    expect(fails[0]).toContain("board_cards");
    expect(fails[0]).toContain("hash_field=milestone");
  });

  test("membershipPinLayoutFailures is empty for a board-keyed board_cards pin", () => {
    const fails = membershipPinLayoutFailures(
      { board_cards: "1ef2e7a3" },
      [{ name: "1ef2e7a3", key: { hash_field: "board", range_field: "sk" } }],
    );
    expect(fails).toEqual([]);
  });

  test("an exact layout match carries no note — the caveat is not boilerplate", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_milestones")!;
    const res = checkMembershipKeyLayout(exp.expected, exp.expected, exp.alsoAccepts);
    expect(res.ok).toBe(true);
    if (res.ok) expect(res.note).toBeUndefined();
  });
});

describe("projection parity", () => {
  test("equal counts pass", () => {
    expect(checkProjectionParity(759, 759)).toEqual({ ok: true, rows: 759 });
  });

  // The live 2026-07-30 numbers: the spine read saw 817 distinct rows on
  // `default`, the 24-field read saw 759, and the 58-row difference was
  // invisible to every wide reader — including the orphan reaper.
  test("a wide read that drops rows fails and names the casualties", () => {
    const res = checkProjectionParity(817, 759, [
      "app-registry-install-fkanban-clean-machine-dogfood",
      "discovery-local-image-embedder",
      "fold-hash-group-warm-set",
      "a-fourth-that-should-not-be-listed",
    ]);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.dropped).toBe(58);
      expect(res.reason).toContain("58 of 817");
      expect(res.reason).toContain("discovery-local-image-embedder");
      expect(res.reason).not.toContain("a-fourth-that-should-not-be-listed");
      expect(res.reason).toContain("board-cards-heal");
    }
  });

  // A wide read can never legitimately exceed the spine: the spine is keyed by
  // the partition itself. If it does, something is double-counting, not losing.
  test("a wide read larger than the spine is not reported as loss", () => {
    expect(checkProjectionParity(10, 12).ok).toBe(true);
  });
});
