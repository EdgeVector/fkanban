// A parity verdict decided on COUNTS is blind to the case that matters most.
//
// `checkProjectionParity(spineRows, wideRows, …)` subtracts two totals. On a
// live board the sweep and the wide read straddle concurrent writes, so a
// partition that GAINS one row and DROPS another between them nets to zero and
// the check reports green — while naming the dropped slug in the argument it
// was handed and then ignoring it.
//
// This is not a hypothetical shape: it is precisely what a `rank` does (write
// new sk, delete old sk) overlapping a genuinely invisible row, and the live
// board showed exactly that mixture on 2026-08-04 (132 rows / 5 flagged, two
// sks for one slug). The BoardCards call site sidesteps it by recomputing from
// the confirmed drift SET; BoardMilestones and MilestoneCards did not, so the
// one index whose loss is hardest to notice was decided by subtraction.
//
// The unit the board serves is the slug. Count it.
import { expect, test, describe } from "bun:test";
import { checkProjectionParityBySlugs } from "../src/membership_schema_guard.ts";

describe("checkProjectionParityBySlugs", () => {
  test("one row gained and one dropped in the same window is NOT green", () => {
    // spine 12, wide 12 — subtraction says 0. But `delta` is a slug the sweep
    // saw and the wide read cannot serve, and that is the whole finding.
    const res = checkProjectionParityBySlugs(["delta"], 12);
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.dropped).toBe(1);
      // Reported against the stable population: the rows the wide read returned
      // plus the ones it provably should have.
      expect(res.reason).toContain("1 of 13");
      expect(res.reason).toContain("delta");
    }
  });

  test("no dropped slugs is green and reports the wide count", () => {
    expect(checkProjectionParityBySlugs([], 759)).toEqual({ ok: true, rows: 759 });
  });

  test("the remedy is carried through, so a milestone verdict does not send the operator to board-cards-heal", () => {
    const res = checkProjectionParityBySlugs(["ms-alpha"], 4, "run `kanban milestone reconcile <slug>`");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.reason).toContain("milestone reconcile");
      expect(res.reason).not.toContain("board-cards-heal");
    }
  });

  test("only the first three casualties are named, like the count-based verdict", () => {
    const res = checkProjectionParityBySlugs(
      ["card-alpha", "card-bravo", "card-charlie", "card-fourth-not-listed"],
      0,
    );
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.dropped).toBe(4);
      expect(res.reason).toContain("card-alpha, card-bravo, card-charlie");
      expect(res.reason).not.toContain("card-fourth-not-listed");
    }
  });
});
