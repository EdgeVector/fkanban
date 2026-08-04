import { describe, expect, test } from "bun:test";
import {
  checkMembershipKeyLayout,
  checkProjectionParity,
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

  // The 2026-07-23 multi-key expand bound board_cards and milestone_cards to
  // one schema, so the catalog reports a single hash_field for both lookups.
  // Doctor used to hard-FAIL on that — on the live board it called the
  // designed state "catalog expand may have rewritten this membership index"
  // while `HashKey=default` was happily returning every row.
  test("a sibling hash field from a multi-key expand is accepted, not a poisoning", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    expect(exp.alsoAccepts).toContain("milestone");
    // `ok`, not the whole object: the acceptance now also carries a `note`
    // naming the gate it accepted (see the test below). This assertion is about
    // the verdict — that the designed multi-key state is not reported as a
    // poisoning — and pinning the exact shape here would make it fail for the
    // one reason it does not care about.
    expect(
      checkMembershipKeyLayout(
        { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
        exp.expected,
        exp.alsoAccepts,
      ).ok,
    ).toBe(true);
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

  // The sibling-hash acceptance above is correct and stays. What it must NOT do
  // is pass SILENTLY, which is what it did until 2026-08-04: doctor rendered
  //
  //     ✓ BoardCards key layout (hash_field=board) — HashRange key=milestone/sk
  //
  // a green line whose title and detail state different hash fields, on the
  // strength of a comment claiming "key layout is metadata; whether the
  // partition actually answers is behaviour".
  //
  // That claim is false, and the node settled it: the catalog `hash_field` IS
  // the projection gate (HASH-ELSE-LEAD). Because BoardCards' catalog
  // hash_field reads `milestone`, every BoardCards read that PROJECTS
  // `milestone` is gated on `milestone` — a row with no `milestone` atom is
  // silently absent from it, wherever in the list the field sits. Measured on
  // constructed rows with known atom sets:
  // `scripts/probe-boardcards-hash-gate-constructed.ts`.
  //
  // So the accepted state carries a consequence the operator has to be told,
  // and a pass that cannot say anything is a check that cannot be read.
  test("the multi-key acceptance reports the gate it just accepted", () => {
    const exp = MEMBERSHIP_KEY_EXPECTATIONS.find((e) => e.configKey === "board_cards")!;
    const res = checkMembershipKeyLayout(
      { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
      exp.expected,
      exp.alsoAccepts,
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      // Names the field that actually gates, not the one we declared.
      expect(res.note).toBeDefined();
      expect(res.note).toContain("milestone");
      // And names the CONSEQUENCE, so the line is actionable rather than trivia.
      expect(res.note).toContain("project");
    }
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
