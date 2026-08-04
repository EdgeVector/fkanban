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
   * This acceptance is correct and must not be "fixed" by rewriting the key.
   * What it is NOT is consequence-free, which this block claimed until
   * 2026-08-04: *"Key layout is metadata; whether the partition actually
   * answers is behaviour."*
   *
   * The catalog `hash_field` IS behaviour — it is the projection gate. LastDB
   * returns a row iff it has an atom for the HASH field when the projection
   * contains it, and for the LEADING field otherwise
   * ([[lastdb-projection-rule-is-hash-else-lead-not-lead]]). So BoardCards
   * reading `milestone` in the catalog means every BoardCards read that
   * PROJECTS `milestone` is gated on `milestone`, from any position in the
   * list — and a row carrying no `milestone` atom is silently absent from it.
   *
   * Measured on this index with constructed rows of known atom sets
   * (`scripts/probe-boardcards-hash-gate-constructed.ts`): a row written with
   * `slug`/`title`/`column`/`position` and no `milestone` is returned by
   * `["slug"]` and dropped by the shipped list projection, while a row missing
   * `board` is returned by both. `board` gates only when it LEADS; `milestone`
   * gates from anywhere. The partition still answers on `HashKey=<board>` —
   * that part of the old comment holds — but which ROWS it answers with is
   * decided by a field the declared layout never mentions.
   *
   * So the acceptance now carries a note rather than passing silently: the
   * state is designed, its consequence is not obvious, and completeness reads
   * ({@link BOARD_CARDS_ADDRESS_FIELDS}) must keep `milestone` out.
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
  // The command that repairs THIS index. Defaults to the BoardCards remedy
  // because that was this check's only caller for its first two months, but a
  // verdict about MilestoneCards that tells the operator to run
  // `board-cards-heal` sends them to a sweep that cannot touch the rows just
  // reported — a wrong remedy is worse than none, because it looks actionable
  // and then reports success.
  remedy = "run `kanban groom board-cards-heal --apply`",
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
      // The gate is the HASH field when the projection contains it and the
      // LEADING field otherwise (HASH-ELSE-LEAD, measured 2026-08-04 —
      // `scripts/probe-projection-rule-constructed.ts`). Naming only the lead
      // sent operators to reorder a projection, which cannot move the gate off
      // the hash field; only removing it can.
      `(no atom for the field the read is gated on — the hash field if it is projected, else the leading one)` +
      (sample.length > 0 ? ` — e.g. ${sample.join(", ")}` : "") +
      ` — ${remedy}`,
  };
}

/** The two ways a row can be in the sweep and not in the wide read. */
export type ParityDropConfirmation = {
  /**
   * Slugs present in BOTH sweeps — stably in the partition for the whole
   * check — that the wide read still could not see. This is the real thing:
   * a row whose gating field carries no atom.
   */
  drift: string[];
  /**
   * Slugs that entered or left the partition while the check ran. Not
   * evidence of anything, and specifically not grounds for a repair.
   */
  moved: string[];
};

/**
 * Decide whether a parity RED is drift or a race, by looking twice.
 *
 * {@link checkProjectionParity} compares an all-leads sweep against a wide read
 * taken after it. Those two reads straddle live traffic: the pickup, groom and
 * papercut routines write continuously, and `rank` is write-new-sk +
 * delete-old-sk. A row deleted in that window is in the sweep and absent from
 * the wide read — byte-for-byte the shape of a row the projection gate denied.
 *
 * The shipped check could not tell them apart, and the remedy it prints is
 * `groom board-cards-heal --apply`: a WRITE repair pointed at a healthy
 * partition. Measured 2026-08-04 with rows that cannot be gated at all — all 24
 * fields written, one deleted mid-check — in
 * `scripts/probe-parity-delete-race-constructed.ts`, and seen twice unprompted
 * on the live board the same morning (129 rows/1 flagged, then 132/5 with two
 * sks for one slug), green four minutes later.
 *
 * So the sweep is taken again AFTER the wide read. A row in both sweeps was
 * stably present across the whole window, so the wide read missing it is drift.
 * A row in only one moved, and proves nothing.
 *
 * Comparison is on SLUG, not sk, because that is the unit the board serves and
 * the unit `checkProjectionParity` reports: a re-ranked card changes sk while
 * never leaving the board, and must show up on neither channel. The flip side —
 * a slug whose sks are partly stable and partly moving — is drift whenever the
 * wide read cannot see the slug at all, so the race on one sk cannot launder a
 * genuinely invisible card into `moved`.
 *
 * Pure by design: this module is import-free, and a verdict this consequential
 * should be testable without a node.
 */
export function confirmParityDrop(
  firstSweep: readonly { sk: string; slug: string }[],
  secondSweep: readonly { sk: string; slug: string }[],
  wideSlugs: ReadonlySet<string>,
): ParityDropConfirmation {
  const secondSks = new Set(secondSweep.map((r) => r.sk));
  const drift = new Set<string>();
  const moved = new Set<string>();
  for (const r of firstSweep) {
    // Only rows the wide read could not account for are in question at all.
    if (wideSlugs.has(r.slug)) continue;
    if (secondSks.has(r.sk)) drift.add(r.slug);
    else moved.add(r.slug);
  }
  // A slug with one stable sk and one that moved is drift: the board still
  // cannot serve it. Whichever way the race went, the card is missing.
  for (const s of drift) moved.delete(s);
  return { drift: [...drift], moved: [...moved] };
}

type MembershipKeyCheckResult =
  // `note` is set ONLY when the layout was admitted through `alsoAccepts` — an
  // accepted state that changes how every read of this index behaves. A plain
  // match carries no note, so the caveat stays information rather than becoming
  // boilerplate an operator learns to skip.
  | { ok: true; note?: string }
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
  // Admitted through `alsoAccepts`: designed, and load-bearing. Carried out to
  // the caller so the operator-facing line states the field that actually gates
  // reads instead of the field we declared — see `alsoAccepts`.
  const siblingHash = hf !== expected.hash_field ? hf : null;
  if (rf !== expRf) {
    return {
      ok: false,
      reason: `range_field=${rf ?? "(null)"} (want ${expRf ?? "(null)"})`,
    };
  }
  if (siblingHash) {
    return {
      ok: true,
      note:
        `multi-key expand — catalog hash_field is \`${siblingHash}\`, not the declared ` +
        `\`${expected.hash_field}\`. The partition still answers on the declared key, but ` +
        `\`${siblingHash}\` is the projection GATE: any read that projects \`${siblingHash}\` ` +
        `drops every row with no \`${siblingHash}\` atom, from any position in the field list. ` +
        `Completeness reads must not project it.`,
    };
  }
  return { ok: true };
}
