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
  /**
   * Sibling hash fields this index legitimately ALSO answers on, because a
   * multi-key catalog expand bound both lookups to one schema.
   *
   * The catalog reports a single `hash_field` for such a schema — whichever key
   * was declared last — so a bare equality check calls the designed state a
   * poisoning. `board_cards` and `milestone_cards` share a schema after the
   * 2026-07-23 expand: on the live node BoardCards' catalog `hash_field` reads
   * `milestone`, and yet `HashKey=default` returns every board row (896 of them,
   * measured 2026-07-30). Per the standing multi-key-expand rule, keeping BOTH
   * indexes is correct and must not be "fixed" by rewriting the key.
   *
   * Key layout is metadata; whether the partition actually answers is
   * behaviour. Doctor asserts the second directly — see the partition probe —
   * so this check exists only to catch a hash field that belongs to NEITHER
   * lookup.
   */
  alsoAccepts?: string[];
};

export const MEMBERSHIP_KEY_EXPECTATIONS: MembershipKeyExpectation[] = [
  {
    configKey: "board_cards",
    label: "BoardCards",
    expected: { schema_type: "HashRange", hash_field: "board", range_field: "sk" },
    alsoAccepts: ["milestone"],
  },
  {
    configKey: "milestone_cards",
    label: "MilestoneCards",
    expected: { schema_type: "HashRange", hash_field: "milestone", range_field: "sk" },
    alsoAccepts: ["board"],
  },
  {
    configKey: "board_milestones",
    label: "BoardMilestones",
    expected: { schema_type: "HashRange", hash_field: "board", range_field: "sk" },
  },
];

type ProjectionParityResult =
  | { ok: true; rows: number }
  | { ok: false; rows: number; dropped: number; reason: string };

/**
 * Compare the NARROWEST spine read against the wide read the board actually
 * serves from.
 *
 * LastDB returns a row only when EVERY projected field has an atom on it. A
 * field absent from the schema errors loudly; a field absent from a ROW drops
 * that row with no error at all. So a wide projection is not a superset read —
 * it is a filter, and everything it filters out is invisible to the caller by
 * construction. This is the only check that can see the difference.
 *
 * Which is why the spine side must stay narrow, and why this check reported
 * `ok` for two days while 19 rows were missing from the live `default`
 * partition: the spine projected `board` and `sk` — copies of the key that a
 * partial write leaves behind — so BOTH sides of the comparison dropped the
 * same rows and the difference this exists to measure was zero. A parity check
 * is only as good as the wider of its two reads.
 */
export function checkProjectionParity(
  spineRows: number,
  wideRows: number,
  sampleDroppedSlugs: string[] = [],
): ProjectionParityResult {
  const dropped = spineRows - wideRows;
  if (dropped <= 0) return { ok: true, rows: wideRows };
  const sample = sampleDroppedSlugs.slice(0, 3);
  return {
    ok: false,
    rows: wideRows,
    dropped,
    reason:
      `${dropped} of ${spineRows} rows are invisible to the wide projection ` +
      `(no atom for the field that LEADS it)` +
      (sample.length > 0 ? ` — e.g. ${sample.join(", ")}` : "") +
      ` — run \`kanban groom board-cards-heal --apply\``,
  };
}

type MembershipKeyCheckResult =
  | { ok: true }
  | { ok: false; reason: string };

/** Compare live schema key layout to the app's hard expectation. */
export function checkMembershipKeyLayout(
  live: MembershipKeyLayout,
  expected: MembershipKeyLayout,
  alsoAccepts: readonly string[] = [],
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
  if (hf !== expected.hash_field && !alsoAccepts.includes(hf)) {
    return {
      ok: false,
      reason: `hash_field=${hf || "(empty)"} (want ${expected.hash_field}${
        alsoAccepts.length > 0 ? ` or ${alsoAccepts.join("/")}` : ""
      }) — catalog expand may have rewritten this membership index`,
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
