/**
 * Membership-index key layout guards.
 *
 * BoardCards must partition by `board`; MilestoneCards by `milestone`.
 * Catalog expand that rewrites BoardCards.hash_field → milestone empties
 * board lists (incident 2026-07-23). Doctor uses these pure checks so scrapers
 * can refuse to start on a poisoned pin.
 */

export type MembershipKeyLayout = {
  schema_type: string;
  hash_field: string;
  range_field: string | null;
};

export type MembershipKeyExpectation = {
  configKey: "board_cards" | "milestone_cards" | "board_milestones";
  label: string;
  expected: MembershipKeyLayout;
};

export const MEMBERSHIP_KEY_EXPECTATIONS: MembershipKeyExpectation[] = [
  {
    configKey: "board_cards",
    label: "BoardCards",
    expected: { schema_type: "HashRange", hash_field: "board", range_field: "sk" },
  },
  {
    configKey: "milestone_cards",
    label: "MilestoneCards",
    expected: { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
  },
  {
    configKey: "board_milestones",
    label: "BoardMilestones",
    expected: { schema_type: "HashRange", hash_field: "board", range_field: "sk" },
  },
];

export type MembershipKeyCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Compare live schema key layout to the app's hard expectation. */
export function checkMembershipKeyLayout(
  live: MembershipKeyLayout,
  expected: MembershipKeyLayout,
): MembershipKeyCheckResult {
  const st = (live.schema_type || "").trim();
  const hf = (live.hash_field || "").trim();
  const rf = live.range_field == null || live.range_field === "" ? null : String(live.range_field).trim();
  const expRf =
    expected.range_field == null || expected.range_field === ""
      ? null
      : String(expected.range_field).trim();

  if (st && st !== expected.schema_type) {
    return {
      ok: false,
      reason: `schema_type=${st} (want ${expected.schema_type})`,
    };
  }
  if (hf !== expected.hash_field) {
    return {
      ok: false,
      reason: `hash_field=${hf || "(empty)"} (want ${expected.hash_field}) — catalog expand may have rewritten this membership index`,
    };
  }
  if (rf !== expRf) {
    return {
      ok: false,
      reason: `range_field=${rf ?? "(null)"} (want ${expRf ?? "(null)"})`,
    };
  }
  return { ok: true };
}
