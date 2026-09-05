/**
 * Membership-index key layout guards.
 *
 * BoardCards must partition by `board`; MilestoneCards by `milestone`.
 * After named-layout HashKey (fold #1893), catalog `hash_field` is the
 * HashKey partition. A `board_cards` pin whose catalog field is `milestone`
 * returns 0 rows for HashKey(board) (incident 2026-09-03). Doctor and init
 * refuse that pin. Both indexes stay; each pin names its own identity
 * (`preference-schema-expand-same-product-different-keys`).
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
   * Unused by shipped expectations after 2026-09-03. Kept on the type so
   * `checkMembershipKeyLayout` can still take an explicit list in tests.
   * A sibling `hash_field` is a different identity, not an accepted pin.
   */
  alsoAccepts?: string[];
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

export type ProjectionParityResult =
  | { ok: true; rows: number }
  | { ok: false; rows: number; dropped: number; reason: string };

/**
 * Compare the NARROWEST spine read against the wide read the board actually
 * serves from.
 *
 * A LastDB projection is a FILTER, not a superset read. The measured rule is
 * **HASH-ELSE-LEAD** (`test/fake-node.ts`, probes 2026-08-04+): one gate — the
 * schema hash field when the projection contains it, otherwise the leading
 * projected field. A field absent from the SCHEMA errors loudly; a row missing
 * the gate atom is dropped with no error at all. The superseded `any_missing`
 * model ("EVERY projected field has an atom") is not current node truth.
 *
 * On membership indexes the live catalog hash can be a sparse multi-key field
 * (BoardCards often gates on `milestone`), so a wide projection that includes
 * that gate silently drops rows the spine still sees. That gap is what this
 * check measures.
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

/**
 * The same verdict, decided on the SLUG SET instead of two totals.
 *
 * {@link checkProjectionParity} subtracts `spineRows - wideRows`, so a
 * partition that gains one row and drops another between the two reads nets to
 * zero and reports green — while holding the dropped slug in the argument it
 * was just handed. On a live board that mixture is ordinary: `rank` is
 * write-new-sk + delete-old-sk, and the board showed it directly on 2026-08-04
 * (132 rows / 5 flagged, one slug under two sks).
 *
 * The unit the board serves is the slug, so count slugs. Rows are reported
 * against the STABLE population — what the wide read returned plus what it
 * provably should have — because rows that arrived after the sweep belong to
 * neither side of the subtraction.
 */
export function checkProjectionParityBySlugs(
  droppedSlugs: readonly string[],
  wideRows: number,
  remedy?: string,
): ProjectionParityResult {
  const dropped = [...new Set(droppedSlugs)];
  const spine = wideRows + dropped.length;
  // `undefined` must fall through to the parameter's default remedy rather than
  // be passed as a value, or a BoardCards verdict loses its repair command.
  return remedy === undefined
    ? checkProjectionParity(spine, wideRows, dropped)
    : checkProjectionParity(spine, wideRows, dropped, remedy);
}

/**
 * Which field a projection is gated on, under the rule the node was measured to
 * apply: HASH-ELSE-LEAD — the hash field when the projection contains it, the
 * leading field otherwise (`scripts/probe-projection-rule-constructed.ts`,
 * 2026-08-04).
 *
 * This exists because a parity verdict that names the wrong field is worse than
 * one that names none: it sends the operator to repair an atom that was never
 * the gate. Doctor's MilestoneCards verdict said the casualties lacked
 * `milestone`, "this index's HASH field — it gates the read from any position",
 * while `MILESTONE_CARDS_PAYLOAD_FIELDS` deliberately EXCLUDES `milestone` and
 * leads with `slug`. Under the measured rule that moves the gate to `slug`, so
 * the message named a field whose absence the read does not mind, about rows
 * that went missing for a different reason.
 *
 * Deriving it from the same field list the read passes is the only way this
 * stays true the next time a projection is edited to dodge a gate.
 */
export function projectionGateField(
  projectedFields: readonly string[],
  hashField: string | null,
): string | undefined {
  if (hashField && projectedFields.includes(hashField)) return hashField;
  return projectedFields[0];
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

/** What a sweep of one partition returns, from the parity check's point of view. */
type ParitySweep<T> = { rows: readonly T[]; failedLeads: readonly { field: string }[] };

export type ConfirmedParity = {
  parity: ProjectionParityResult;
  /**
   * The slugs behind the verdict. `parity.reason` formats at most three of
   * these for an operator; a caller that needs the list must get it here rather
   * than parse it back out of prose.
   */
  drift: string[];
  /** Slugs that entered or left mid-check. Reportable as churn; never a repair. */
  moved: string[];
  /**
   * Whether a second sweep actually ran and was complete. `false` means the
   * verdict stands on the first pass alone — a RED here is UNCONFIRMED, not
   * disproven.
   */
  confirmed: boolean;
};

/**
 * The confirm-before-accusing dance, as one thing every parity check calls.
 *
 * {@link confirmParityDrop} shipped index-agnostic and pure, but only the
 * BoardCards call site was wired to it — so the delete-race that made BoardCards
 * cry wolf twice on 2026-08-04 stayed live on BoardMilestones and
 * MilestoneCards, both of which print a WRITE remedy when they fire.
 *
 * The re-sweep is the expensive half (24 partition queries for BoardCards, 19
 * partitions for MilestoneCards, ~1.8s measured across both milestone indexes
 * in `scripts/probe-milestone-parity-baseline-cost.ts`), so it runs ONLY when
 * the first pass flagged something. A healthy board pays nothing.
 *
 * A re-sweep that could not run, or came back short a lead, leaves the verdict
 * RED and `confirmed: false`. Calling a stable row "moved" because the re-read
 * could not see it would launder real drift into a race, which is the one
 * direction this must never fail in.
 *
 * `resweep` is injected rather than taken as a node handle: a verdict that
 * prescribes a write repair to an operator should be testable without live
 * infrastructure, and this module stays import-free.
 */
export async function parityWithConfirmation<T extends { sk: string; slug: string }>(args: {
  firstSweep: readonly T[];
  wideSlugs: ReadonlySet<string>;
  wideRows: number;
  resweep: () => Promise<ParitySweep<T> | null>;
  remedy?: string;
}): Promise<ConfirmedParity> {
  const { firstSweep, wideSlugs, wideRows, resweep, remedy } = args;
  const droppedSlugs = [...new Set(firstSweep.map((r) => r.slug))].filter((s) => !wideSlugs.has(s));
  if (droppedSlugs.length === 0) {
    return { parity: { ok: true, rows: wideRows }, drift: [], moved: [], confirmed: true };
  }

  const second = await resweep();
  if (second === null || second.failedLeads.length > 0) {
    return {
      parity: checkProjectionParityBySlugs(droppedSlugs, wideRows, remedy),
      drift: droppedSlugs,
      moved: [],
      confirmed: false,
    };
  }

  const { drift, moved } = confirmParityDrop(firstSweep, second.rows, wideSlugs);
  return {
    parity: checkProjectionParityBySlugs(drift, wideRows, remedy),
    drift,
    moved,
    confirmed: true,
  };
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
      }) — named-layout HashKey uses catalog hash_field as the partition`,
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

/** Failures for resolved membership pins whose catalog layout is not the declared HashKey. */
export function membershipPinLayoutFailures(
  schemaHashes: Record<string, string>,
  loaded: readonly { name: string; key: { hash_field: string; range_field: string | null } | null }[],
): string[] {
  const byName = new Map(loaded.map((s) => [s.name, s]));
  const failures: string[] = [];
  for (const exp of MEMBERSHIP_KEY_EXPECTATIONS) {
    const hash = schemaHashes[exp.configKey];
    if (!hash) continue;
    const schema = byName.get(hash);
    if (!schema?.key) continue;
    const result = checkMembershipKeyLayout(
      {
        schema_type: "HashRange",
        hash_field: schema.key.hash_field,
        range_field: schema.key.range_field,
      },
      exp.expected,
      exp.alsoAccepts ?? [],
    );
    if (!result.ok) failures.push(`${exp.configKey}: ${result.reason}`);
  }
  return failures;
}
