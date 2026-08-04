// A parity verdict that names the wrong field is worse than one that names
// none: it looks actionable, and sends the operator to repair an atom the read
// does not mind.
//
// Doctor's MilestoneCards RED said the casualties carried "no atom for
// `milestone`, this index's HASH field — it gates the read from any position."
// But `MILESTONE_CARDS_PAYLOAD_FIELDS` deliberately EXCLUDES `milestone` (the
// completeness fix: "Completeness reads must not project it"), and under the
// measured HASH-ELSE-LEAD rule a projection without its hash field is gated on
// the LEAD instead — `slug`. So the message named a field whose absence that
// read tolerates, about rows that went missing for a different reason.
//
// The fix is to derive the gate from the same field list the read passes.
// These tests pin the derivation AND the two live field lists, so the next edit
// that reorders a projection to dodge a gate cannot silently un-true the
// operator-facing message again.
import { expect, test, describe } from "bun:test";
import { projectionGateField } from "../src/membership_schema_guard.ts";
import { MILESTONE_CARDS_PAYLOAD_FIELDS } from "../src/milestone-cards.ts";
import { BOARD_MILESTONES_FIELDS } from "../src/schemas.ts";

describe("projectionGateField", () => {
  test("the hash field gates from any position when it is projected", () => {
    expect(projectionGateField(["slug", "milestone", "title"], "milestone")).toBe("milestone");
    expect(projectionGateField(["milestone", "slug"], "milestone")).toBe("milestone");
  });

  test("a projection without its hash field is gated on the LEAD", () => {
    expect(projectionGateField(["slug", "title", "column"], "milestone")).toBe("slug");
  });

  test("no hash field known falls back to the lead rather than guessing", () => {
    expect(projectionGateField(["board", "sk"], null)).toBe("board");
  });

  test("an empty projection has no gate to name", () => {
    expect(projectionGateField([], "milestone")).toBeUndefined();
  });
});

describe("the gate on the reads doctor actually reports about", () => {
  // The reason the old message was wrong, asserted rather than described.
  test("MilestoneCards' wide read excludes `milestone`, so its gate is `slug`", () => {
    expect([...MILESTONE_CARDS_PAYLOAD_FIELDS]).not.toContain("milestone");
    expect(projectionGateField([...MILESTONE_CARDS_PAYLOAD_FIELDS], "milestone")).toBe("slug");
  });

  // And the reason BoardMilestones' message was right: it DOES project its
  // hash field, so `board` gates it from any position.
  test("BoardMilestones' wide read projects `board`, so its gate is `board`", () => {
    expect([...BOARD_MILESTONES_FIELDS]).toContain("board");
    expect(projectionGateField([...BOARD_MILESTONES_FIELDS], "board")).toBe("board");
  });
});
