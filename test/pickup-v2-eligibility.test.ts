import { describe, expect, test } from "bun:test";

import { TODO_FIELDS } from "../src/commands/pickup_claim_v2.ts";
import {
  firstEligible,
  PICKUP_V2_ELIGIBILITY_FIELDS,
  pickupV2HoldReason,
  type PickupV2Card,
} from "../src/pickup_v2.ts";

// 2026-09-07. `pickup claim-v2 --dry-run` answered `result=claimed` for
// `fold-aws-ci-fallback-20260906` while `pickup status` counted that same card
// parked and `pickup explain` reported `eligible_for_claim: NO`. The routine
// ready gate reads the dry-run, so six pickup lanes were sent at a deferred
// hold. Papercut: papercut-pickup-gate-dry-run-accepts-unattached-outcome-20260906.
function card(overrides: Partial<PickupV2Card> = {}): PickupV2Card {
  return {
    slug: "candidate",
    column: "todo",
    position: "1",
    created_at: "2026-01-01T00:00:00.000Z",
    repo: "EdgeVector/fkanban",
    deps: [],
    surfaces: ["src/a.ts"],
    board: "default",
    kind: "pr",
    block_status: "",
    milestone: "ms-live",
    ...overrides,
  };
}

const ENFORCED = { enforceLivePrMilestone: true } as const;

describe("pickup v2 honours a stored hold", () => {
  test("a deferred card is not claimable", () => {
    const held = card({ block_status: "deferred" });
    expect(pickupV2HoldReason(held, ENFORCED)).toBe("deferred hold");
    expect(firstEligible([held], [], {}, ENFORCED)).toBeUndefined();
  });

  for (const blockStatus of ["needs_human", "design_first"] as const) {
    test(`a ${blockStatus} card is not claimable`, () => {
      const held = card({ block_status: blockStatus });
      expect(pickupV2HoldReason(held, ENFORCED)).toBe(`intentional hold: ${blockStatus}`);
      expect(firstEligible([held], [], {}, ENFORCED)).toBeUndefined();
    });
  }

  test("a card on the human board is not claimable", () => {
    const held = card({ board: "human" });
    expect(pickupV2HoldReason(held, ENFORCED)).toBe("card is parked on the human board");
    expect(firstEligible([held], [], {}, ENFORCED)).toBeUndefined();
  });

  test("a non-pr kind is not claimable", () => {
    const held = card({ kind: "capstone" });
    expect(pickupV2HoldReason(held, ENFORCED)).toBe("non-pickup kind: capstone");
    expect(firstEligible([held], [], {}, ENFORCED)).toBeUndefined();
  });

  test("an unattached Kind:pr card is not claimable when the policy is enforced", () => {
    const held = card({ milestone: "" });
    expect(pickupV2HoldReason(held, ENFORCED)).toContain("without a milestone");
    expect(firstEligible([held], [], {}, ENFORCED)).toBeUndefined();
  });

  test("a clean card is still claimable", () => {
    const ready = card();
    expect(pickupV2HoldReason(ready, ENFORCED)).toBeNull();
    expect(firstEligible([ready], [], {}, ENFORCED)?.slug).toBe("candidate");
  });

  // The failure that made this more than one wasted fire: an ineligible card at
  // the top of the range also hid the ready card behind it, so the whole lane
  // stalled rather than skipping one candidate.
  test("a ready card behind a held card is still reached", () => {
    const held = card({ slug: "held", position: "1", block_status: "deferred" });
    const ready = card({ slug: "ready", position: "2" });
    expect(firstEligible([held, ready], [], {}, ENFORCED)?.slug).toBe("ready");
  });
});

describe("pickup v2 eligibility policy matches the rest of the CLI", () => {
  // The unattached-outcome rule is config policy (`cfg.enforceLivePrMilestone`,
  // read as `requireLiveMilestone` by classifyPickupCard). Enforcing it here
  // unconditionally would just invert the status/claim disagreement.
  test("an unattached card stays claimable when the policy is off", () => {
    const unattached = card({ milestone: "" });
    expect(pickupV2HoldReason(unattached)).toBeNull();
    expect(firstEligible([unattached], [], {})?.slug).toBe("candidate");
  });

  test("a hold still applies when the milestone policy is off", () => {
    const held = card({ block_status: "deferred" });
    expect(pickupV2HoldReason(held)).toBe("deferred hold");
  });
});

describe("the eligibility projection cannot drift", () => {
  // The original defect was NOT bad selection logic: the todo projection never
  // fetched block_status, so the hold was invisible and came back "" in the
  // claim envelope. Pin the projection to the field list the predicate reads.
  test("pickup claim-v2 projects every field the predicate reads", () => {
    for (const field of PICKUP_V2_ELIGIBILITY_FIELDS) {
      expect(TODO_FIELDS as readonly string[]).toContain(field);
    }
  });

  test("an unprojected field cannot hold a card", () => {
    const legacy: PickupV2Card = {
      slug: "legacy",
      column: "todo",
      position: "1",
      created_at: "2026-01-01T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      deps: [],
      surfaces: ["src/a.ts"],
    };
    expect(pickupV2HoldReason(legacy, ENFORCED)).toBeNull();
  });
});
