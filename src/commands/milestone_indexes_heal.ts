// One-shot heal for reverse indexes. BoardMilestones remains explicit repair;
// MilestoneCards defaults to protein-aware BoardCards fold requests.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  listBoardMilestonesPartition,
  removeBoardMilestone,
  upsertBoardMilestone,
  boardMilestonesHash,
} from "../board-milestones.ts";
import { milestoneCardsHash } from "../milestone-cards.ts";
import { milestoneReconcileResult } from "./milestone.ts";
import {
  findMilestone,
  listBoards,
  type Milestone,
} from "../record.ts";

export const DEFAULT_MILESTONE_INDEXES_HEAL_BUDGET = 25;

/**
 * Removal ceiling: the fraction of the rows this run actually LOOKED AT that a
 * plausible repair may delete, and the absolute floor below which the fraction
 * is not allowed to bite.
 *
 * ## Why the brake is on removals, not on total drift
 *
 * The obvious guard — a `--max-drift` ceiling over every classified write, the
 * shape `board-cards-heal-scheduled` uses — is wrong for THIS command, and the
 * bootstrap path is why. On a first heal `BoardMilestones` is empty, so
 * `classifyBoardMilestoneOps` classifies every live milestone as an upsert:
 * a 38-milestone board is a 38-write run with 0 removals, and it is entirely
 * correct. A flat drift ceiling low enough to catch the real incident (33 of 38
 * rows proposed for deletion) would refuse that legitimate first heal.
 *
 * The two classes also differ in what a mistake COSTS. An upsert rewrites an
 * index row from a HashKey point-read of truth; a wrong one is idempotent and
 * the next heal corrects it. A removal destroys a row behind `milestone list`,
 * `milestone portfolio`, and pickup's milestone-linkage gate, and nothing
 * re-derives it until someone notices the milestone vanished. Removals are the
 * unbounded-damage class, so removals are what gets the brake.
 *
 * Note this is NOT what the per-run write budget does. The budget caps how many
 * deletions a bad classification lands per run; it never refuses one. At
 * `DEFAULT_MILESTONE_INDEXES_HEAL_BUDGET` the measured 2026-08-03 incident
 * (33 removals classified, all 33 point-read LIVE) would still have deleted 25
 * live rows and exited 0. A ceiling refuses instead of rationing.
 *
 * ## Why a ratio AND a floor
 *
 * A bare count does not scale: 5 removals is most of a 38-row index and noise
 * in a 500-row one. The signal in the incident was the PROPORTION — 87% of the
 * index proposed for deletion is not a repair, whatever the absolute number.
 * A bare ratio, though, is useless at small N (1 of 2 rows is 50% and is
 * completely ordinary), so the floor keeps small honest cleanups from tripping
 * a percentage.
 */
export const DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_RATIO = 0.25;
export const DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR = 5;

/** The removal ceiling for a run that examined `rowsExamined` index rows. */
export function milestoneIndexesHealRemovalCeiling(rowsExamined: number): number {
  return Math.max(
    DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_FLOOR,
    Math.floor(DEFAULT_MILESTONE_INDEXES_HEAL_REMOVAL_RATIO * rowsExamined),
  );
}

export type MilestoneIndexesHealResult = {
  board_milestones_bound: boolean;
  milestone_cards_bound: boolean;
  applied: boolean;
  budget: number | null;
  /** Index rows this run read and classified — the removal ceiling's denominator. */
  rows_examined: number;
  /** Removals classified this run (board-milestone + milestone-card). */
  removals_classified: number;
  /** Ceiling above which apply refuses outright; null when opted out. */
  removal_ceiling: number | null;
  /** True when the ceiling refused an apply this run — NOTHING was written. */
  blocked: boolean;
  /** Slugs the enumeration returned — mostly husks; NOT a count of live milestones. */
  milestones_enumerated: number;
  /**
   * What the pre-2026-08-05 single widest-projection scan alone would have
   * enumerated. Reported beside `milestones_enumerated` so the recall the
   * multi-lead sweep buys stays visible in the command's own output — this is
   * the gap that hid live milestones from every repair path for four
   * recurrences. See {@link sweepMilestoneSlugs}.
   */
  milestones_enumerated_single_lead: number;
  /**
   * Leads the node refused during enumeration. Non-empty means
   * `milestones_enumerated` is a LOWER BOUND and this run must not be read as
   * having seen every milestone.
   */
  enumeration_failed_leads: Array<{ field: string; error: string }>;
  /**
   * Boards whose BoardMilestones partition read FAILED. Non-empty means this
   * run repaired nothing on those boards and cannot have measured drift there.
   *
   * ## Why this matters more than `enumeration_failed_leads`, which already warns
   *
   * The two reads that feed this command have wildly different recall, and the
   * warning was on the smaller one. Measured on the primary 2026-08-06
   * (`scripts/probe-milestone-heal-partition-read-blind.ts`): of **66** live
   * milestones, the multi-lead enumeration sweep reaches **3**; the other
   * **63** are reachable only because the index partition read offers them as
   * candidates that are then point-read for truth. So the index read is ~95% of
   * this command's reach, and it was the one whose failure produced no field, no
   * warning line, and exit 0.
   *
   * A failed read is not merely lost repair. On that board every swept
   * milestone is reclassified as an upsert (`rows === null` short-circuits the
   * drift check), so the run also WRITES rows it never compared — and reports
   * those writes as `upserts=N`, the same number a genuinely drifted index
   * produces.
   */
  index_read_failed_boards: string[];
  /** Enumerated slugs whose point-read found nothing (deleted husks). */
  milestone_husks_dropped: number;
  /** Enumerated slugs that point-read back to a live milestone. */
  milestones_scanned: number;
  milestone_card_children_scanned: number;
  /**
   * The four counters below name WHICH index and WHICH direction.
   *
   * `milestones_written` and `cards_written` were deprecated aliases of
   * `board_milestone_upserts` / `milestone_card_upserts` (added 2026-08-01,
   * removed 2026-08-06). Do not re-add them "for compatibility": the removal
   * was gated on a consumer sweep, not on a deprecation clock. Nothing read
   * them — not `~/.routines/prompts`, not last-stack scripts, not this repo's
   * own tests/docs/scripts, and `milestone_indexes_heal` is CLI-only (it is not
   * one of the MCP tools, so no declared outputSchema carried them). The only
   * six occurrences in the fleet were their own definition.
   *
   * They were also lossy in the one way that matters here: both aliases carried
   * only the UPSERT half, so a reader reaching for "how much did the heal
   * write" silently missed every removal.
   */
  board_milestone_upserts: number;
  board_milestone_removals: number;
  milestone_card_upserts: number;
  milestone_card_removals: number;
  issued: number;
  deferred: number;
  text: string;
  direct_milestone_card_payload_upsert: boolean;
};

type BoardMilestoneOp =
  | { kind: "upsert"; milestone: Milestone; previous: Milestone | null }
  | { kind: "remove"; milestone: Milestone };

function arraysEqual(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}

function boardMilestoneMatchesTruth(row: Milestone, truth: Milestone): boolean {
  return (
    row.slug === truth.slug &&
    row.title === truth.title &&
    row.body === truth.body &&
    (row.board || "default") === (truth.board || "default") &&
    row.state === truth.state &&
    String(row.position) === String(truth.position) &&
    row.north_star === truth.north_star &&
    row.driver === truth.driver &&
    arraysEqual(row.deps, truth.deps) &&
    row.proof_card === truth.proof_card &&
    row.proof_status === truth.proof_status &&
    row.block_reason === truth.block_reason &&
    row.created_at === truth.created_at &&
    row.updated_at === truth.updated_at
  );
}

async function classifyBoardMilestoneOps(opts: {
  cfg: Config;
  node: NodeClient;
  boards: Array<{ slug: string }>;
  milestones: Milestone[];
}): Promise<{ ops: BoardMilestoneOp[]; indexRows: number; unreadableBoards: string[] }> {
  const bySlug = new Map(opts.milestones.map((milestone) => [milestone.slug, milestone]));
  const rowsByBoard = new Map<string, Milestone[] | null>();
  for (const board of opts.boards) {
    rowsByBoard.set(board.slug, await listBoardMilestonesPartition(opts.node, opts.cfg, board.slug));
  }
  // `listBoardMilestonesPartition` returns null from a bare `catch {}`, so null
  // is indistinguishable from the `service_timeout` / "too many concurrent
  // reads" backpressure CLAUDE.md documents as ordinary on this node. Every
  // branch below degrades safely on it and NONE of them used to say so, which
  // is the whole defect: the failure is invisible in the report.
  const unreadableBoards: string[] = [];
  for (const [board, rows] of rowsByBoard) {
    if (rows === null) unreadableBoards.push(board);
  }
  // The removal ceiling's denominator: index rows actually read. A board whose
  // partition read FAILED (null) contributes nothing — counting its rows as 0
  // is the conservative direction, since a smaller denominator means a tighter
  // ceiling, and a run that could not read the index is exactly the run that
  // should not be trusted to delete much of it.
  //
  // Conservative, but not self-explaining: the refusal text tells the operator
  // the CLASSIFIER is implausible and to consider `--max-removals`, which is
  // the wrong lead when the real cause is a read that never landed. Hence
  // `unreadableBoards` reaching the rendered report.
  let indexRows = 0;
  for (const rows of rowsByBoard.values()) indexRows += rows?.length ?? 0;

  const ops: BoardMilestoneOp[] = [];
  for (const milestone of opts.milestones) {
    const rows = rowsByBoard.get(milestone.board || "default");
    const existing = rows === undefined || rows === null
      ? []
      : rows.filter((row) => row.slug === milestone.slug);
    if (rows === null || existing.length !== 1 || !boardMilestoneMatchesTruth(existing[0]!, milestone)) {
      ops.push({ kind: "upsert", milestone, previous: existing[0] ?? null });
    }
  }

  const recovered = new Set<string>();
  for (const [board, rows] of rowsByBoard) {
    if (rows === null) continue;
    for (const row of rows) {
      // Absence from the full scan is NOT evidence that a milestone is gone —
      // confirm by ADDRESS before deleting the row. See the removal-evidence
      // note on `milestoneIndexesHealResult`.
      const truth = bySlug.get(row.slug) ?? await findMilestone(opts.node, opts.cfg, row.slug);
      if (!truth || (truth.board || "default") !== board) {
        ops.push({ kind: "remove", milestone: row });
        continue;
      }
      // The point-read above just proved this milestone is LIVE and on this
      // board. If the scan never enumerated it, the upsert loop never saw it,
      // and a stale row for it would stay stale forever — the under-repair this
      // command's doc deferred. The truth is already in hand, so closing that
      // gap costs NO extra read: run it through the same drift check.
      //
      // The index supplies a CANDIDATE here, never truth — every candidate is
      // confirmed by point-read before use — so a degraded BoardMilestones
      // cannot shrink its own repair set below what the scan already covers.
      if (!bySlug.has(row.slug) && !recovered.has(row.slug) && !boardMilestoneMatchesTruth(row, truth)) {
        recovered.add(row.slug);
        ops.push({ kind: "upsert", milestone: truth, previous: row });
      }
    }
  }
  return { ops, indexRows, unreadableBoards };
}

function remainingBudget(budget: number | null, issued: number): number | null {
  return budget === null ? null : Math.max(0, budget - issued);
}

function budgetAllowsAnother(budget: number | null, issued: number): boolean {
  return budget === null || issued < budget;
}

/**
 * Rebuild reverse indexes from current fat records.
 *
 * Deliberately does NOT use `listMilestones`: this is the command that repairs
 * BoardMilestones, so reading through that index to decide what to repair would
 * let a degraded index shrink its own repair set. It full-scans `Milestone`
 * directly, then point-reads each slug for truth, then upserts BoardMilestones
 * + MilestoneCards.
 *
 * ## Removal evidence: absence from the scan is not deletion
 *
 * That reasoning is right for UPSERTS and was wrong for REMOVALS. The scan it
 * substitutes for the index is itself unreliable on the live primary: it
 * returns husks of DELETED milestones and MISSES live ones (measured
 * 2026-08-01, `scripts/probe-milestone-membership-parity.ts` preamble;
 * `papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows`).
 * Under-enumerating only under-repairs an upsert, but it AUTHORIZED A DELETE:
 * every index row whose slug the scan missed was classified `remove`.
 *
 * Measured on the primary 2026-08-03 (`scripts/probe-milestone-heal-truth-drop.ts`):
 * 17 slugs scanned against 38 BoardMilestones rows -> 33 proposed removals, and
 * a HashKey point-read confirmed **all 33 were live**, 0 genuinely gone. This
 * command applies by default (`apply: !values["dry-run"]`) at a budget of 25, so
 * one bare `groom milestone-indexes-heal` would have deleted 25 live rows from
 * the index behind `milestone list`, `milestone portfolio`, and pickup's
 * milestone-linkage gate.
 *
 * The gap is not projection width — `findMilestone` uses the same
 * `fieldsFor("milestone")` set. It is full-scan ENUMERATION vs. HashKey
 * ADDRESSING. So a removal now requires a point-read confirming the milestone
 * is gone, the same refusal `deleteCardRecord` makes on the card side ("one
 * narrow point-read is the cheapest honest answer available"). It costs at most
 * one read per index row the scan could not account for, on a repair path that
 * is already the slowest command here — and only for rows about to be deleted.
 *
 * ## Recall: the scan is a candidate source, not an enumeration
 *
 * Fixing the delete stopped the damage but left the command repairing almost
 * nothing. Measured on the primary 2026-08-03
 * (`scripts/probe-milestone-heal-hydrate-drop.ts`): the scan enumerated **21**
 * slugs, of which **10** point-read back to a live milestone and **11** were
 * husks of deleted ones — against **38** live milestones in BoardMilestones.
 * So as a truth source the scan ran at ~48% precision and ~26% recall, and the
 * upsert loop only ever saw those 10. A stale row for any of the other 28 could
 * never be repaired, while the command printed `scanned=10 ... removals=0` and
 * exited 0.
 *
 * The removal loop was already point-reading every one of those 28 rows to
 * prove it must not delete them — and discarding the hydrated truth. So the
 * upsert set is now widened from that same read: an index row whose point-read
 * confirms it LIVE and on-board is drift-checked like any scanned milestone.
 * This costs **no additional node reads**.
 *
 * That does not reintroduce the hazard this command was built to avoid. The
 * index supplies a CANDIDATE; truth still comes only from the point-read. A
 * degraded BoardMilestones can therefore only fail to *offer* a candidate — it
 * can never shrink the repair set below what the scan already covers, and it
 * can never authorize a write on its own say-so.
 */
export async function milestoneIndexesHealResult(opts: {
  cfg: Config;
  node: NodeClient;
  board?: string;
  apply?: boolean;
  maxRepairs?: number | null;
  /**
   * Removal ceiling. `undefined` derives it from the rows examined (see
   * `milestoneIndexesHealRemovalCeiling`); `null` opts out entirely; a number
   * pins it. Exceeding it refuses the whole apply — see the guard below.
   */
  maxRemovals?: number | null;
  directMilestoneCardPayloadUpsert?: boolean;
}): Promise<MilestoneIndexesHealResult> {
  const apply = opts.apply ?? true;
  const budget = opts.maxRepairs === undefined ? DEFAULT_MILESTONE_INDEXES_HEAL_BUDGET : opts.maxRepairs;
  const directMilestoneCardPayloadUpsert = opts.directMilestoneCardPayloadUpsert ?? false;
  const boardMsBound = Boolean(boardMilestonesHash(opts.cfg));
  const msCardsBound = Boolean(milestoneCardsHash(opts.cfg));
  if (!boardMsBound && !msCardsBound) {
    return {
      board_milestones_bound: false,
      milestone_cards_bound: false,
      applied: apply,
      budget,
      milestones_enumerated: 0,
      milestones_enumerated_single_lead: 0,
      enumeration_failed_leads: [],
      index_read_failed_boards: [],
      milestone_husks_dropped: 0,
      milestones_scanned: 0,
      milestone_card_children_scanned: 0,
      board_milestone_upserts: 0,
      board_milestone_removals: 0,
      milestone_card_upserts: 0,
      milestone_card_removals: 0,
      rows_examined: 0,
      removals_classified: 0,
      removal_ceiling: opts.maxRemovals === undefined ? milestoneIndexesHealRemovalCeiling(0) : opts.maxRemovals,
      blocked: false,
      issued: 0,
      deferred: 0,
      direct_milestone_card_payload_upsert: directMilestoneCardPayloadUpsert,
      text:
        "milestone indexes heal: board_milestones and milestone_cards not bound in config — run `fkanban init` first",
    };
  }

  // Always rebuild from fat Milestone rows (full-scan + HashKey hydrate), never
  // from BoardMilestones (may be empty or polluted during first heal).
  const { sweepMilestoneSlugs } = await import("../record.ts");
  const { mapWithConcurrency, PARTITION_READ_CONCURRENCY } = await import("../concurrency.ts");

  // Enumerate under EVERY lead, not under the widest projection. Widening a
  // projection cannot add rows in LastDB's atom model — every projected field
  // gates on its atom — so the old single wide scan was the narrowest
  // enumeration available, tied to whichever field is sparsest. See
  // {@link sweepMilestoneSlugs} for the measured numbers and the five live
  // milestones no repair path could reach because of it.
  const sweep = await sweepMilestoneSlugs(opts.node, opts.cfg);
  const slugs = sweep.slugs;

  // The scan ENUMERATES; only a point-read establishes truth. Most of what it
  // returns on the live primary is husks of deleted milestones, so track what
  // the hydrate discards instead of letting `scanned` imply the scan found it.
  // Measured 2026-08-05: 1478 enumerated -> 110 live, 1368 husks.
  //
  // Hydrated concurrently. The sweep raised the candidate set from 74 to 1478,
  // and these were serial point-reads: at the ~50ms this node answers one in,
  // serial hydration would have turned a 20s recall win into a 70s regression
  // on a command that already runs longest. They are independent keyed reads
  // with no ordering between them, so they wait on each other for no reason.
  const hydrated = await mapWithConcurrency(
    slugs,
    (slug) => findMilestone(opts.node, opts.cfg, slug),
    PARTITION_READ_CONCURRENCY,
  );
  const milestones: Milestone[] = [];
  let husksDropped = 0;
  for (const full of hydrated) {
    if (!full) {
      husksDropped++;
      continue;
    }
    if (opts.board && full.board !== opts.board) continue;
    milestones.push(full);
  }

  const boards = opts.board
    ? [{ slug: opts.board }]
    : await listBoards(opts.node, opts.cfg);
  const classification = boardMsBound
    ? await classifyBoardMilestoneOps({ cfg: opts.cfg, node: opts.node, boards, milestones })
    : { ops: [] as BoardMilestoneOp[], indexRows: 0, unreadableBoards: [] as string[] };
  const boardOps = classification.ops;
  const indexReadFailedBoards = classification.unreadableBoards;

  const cardPlans = [];
  let milestoneCardChildrenScanned = 0;
  let milestoneCardUpserts = 0;
  let milestoneCardRemovals = 0;
  if (msCardsBound) {
    for (const m of milestones) {
      const dry = await milestoneReconcileResult({
        cfg: opts.cfg,
        node: opts.node,
        slug: m.slug,
        apply: false,
        maxRepairs: 0,
        directPayloadUpsert: directMilestoneCardPayloadUpsert,
      });
      milestoneCardChildrenScanned += dry.children.length;
      if (dry.repairs.upserts + dry.repairs.removals === 0) continue;
      milestoneCardUpserts += dry.repairs.upserts;
      milestoneCardRemovals += dry.repairs.removals;
      cardPlans.push({ slug: m.slug, repairs: dry.repairs.upserts + dry.repairs.removals });
    }
  }

  // THE REMOVAL CEILING, and note WHERE it sits: every write above is still
  // only classified — `classifyBoardMilestoneOps` and the `cardPlans` loop both
  // run `apply: false` — and the first mutation is issued below. So the ceiling
  // reads a complete picture of what this run intends to delete and costs no
  // additional node read to do it.
  //
  // Blocking refuses the ENTIRE apply rather than just dropping the removals.
  // An index this far from truth is precisely the case where the classifier's
  // judgement is the thing in doubt, so letting the run proceed with its
  // upserts would be trusting the same classification that just failed a
  // plausibility check. Refusing wholesale also keeps the report unambiguous:
  // `blocked=true` means nothing was written, full stop.
  const rowsExamined = classification.indexRows + milestoneCardChildrenScanned;
  const removalsClassified =
    boardOps.filter((op) => op.kind === "remove").length + milestoneCardRemovals;
  const removalCeiling =
    opts.maxRemovals === undefined
      ? milestoneIndexesHealRemovalCeiling(rowsExamined)
      : opts.maxRemovals;
  const blocked =
    apply && removalCeiling !== null && removalsClassified > removalCeiling;
  const applying = apply && !blocked;

  let issued = 0;
  if (boardMsBound) {
    for (const op of boardOps) {
      if (!applying || !budgetAllowsAnother(budget, issued)) break;
      if (op.kind === "upsert") {
        await upsertBoardMilestone(opts.node, opts.cfg, op.milestone, op.previous);
      } else {
        await removeBoardMilestone(opts.node, opts.cfg, op.milestone);
      }
      issued += 1;
    }
  }

  if (msCardsBound && applying) {
    for (const plan of cardPlans) {
      const remaining = remainingBudget(budget, issued);
      if (remaining !== null && remaining <= 0) break;
      const repaired = await milestoneReconcileResult({
        cfg: opts.cfg,
        node: opts.node,
        slug: plan.slug,
        apply: true,
        maxRepairs: remaining,
        directPayloadUpsert: directMilestoneCardPayloadUpsert,
      });
      issued += repaired.repairs.issued;
    }
  }

  // Keep the old field names as compatibility aliases, but make them honest:
  // they are the writes classified for this run, not necessarily issued.
  const boardMilestoneUpserts = boardOps.filter((op) => op.kind === "upsert").length;
  const boardMilestoneRemovals = boardOps.filter((op) => op.kind === "remove").length;
  const classified =
    boardMilestoneUpserts + boardMilestoneRemovals + milestoneCardUpserts + milestoneCardRemovals;
  const deferred = classified - issued;
  const ceilingLine = blocked
    ? [
        `  REFUSED: ${removalsClassified} removal(s) classified against ${rowsExamined} row(s) examined ` +
          `exceeds the ceiling of ${removalCeiling} — NOTHING was written.`,
        "  This is a plausibility refusal, not a repair failure: a run that wants to delete this much",
        "  of the index is more likely misclassifying than finding real orphans. Re-run with --dry-run",
        "  to read the classification, and only raise --max-removals once the removals are confirmed.",
        // ...unless a read failed, in which case the advice above points away
        // from the cause. `rows_examined` is the ceiling's denominator and an
        // unreadable board contributes 0 to it, so a refused read can tighten
        // the ceiling until an ordinary run trips it. Raising --max-removals
        // there would be overriding a brake with a correct verdict for a reason
        // the operator has not been told.
        ...(indexReadFailedBoards.length > 0
          ? [
              `  READ THIS FIRST: ${indexReadFailedBoards.length} board partition read(s) FAILED this run, so`,
              `  rows_examined=${rowsExamined} is short and the ceiling above is tighter than the index warrants.`,
              "  Retry under lighter load before touching --max-removals — the classifier may be fine.",
            ]
          : []),
      ]
    : [];
  // A refused lead means the enumeration is a lower bound. Say so where the
  // operator reads the result, not only in the JSON: `upserts=0` on a short
  // enumeration is indistinguishable from a clean index, and that ambiguity is
  // what let four undercount recurrences read as "converged".
  const leadLine = sweep.failedLeads.length > 0
    ? [
        `  WARNING: ${sweep.failedLeads.length} enumeration lead(s) were refused — enumerated=${slugs.length} is a LOWER BOUND.`,
        `    ${sweep.failedLeads.map((l) => `${l.field}: ${l.error}`).join("; ")}`,
        "    A milestone missing from this run's candidates may exist and simply not have been reached.",
      ]
    : [];
  // The sibling of `leadLine`, for the read with ~20x the recall. Separate
  // block rather than a clause on the `board_milestones` line: a caveat tacked
  // onto a line that opens `bound=true scanned=N` reads as part of the good
  // news, which is the mistake `board_cards_heal_scheduled` made with `clean`.
  const indexReadLine = indexReadFailedBoards.length > 0
    ? [
        `  ⚠ INDEX READ INCOMPLETE: BoardMilestones partition read FAILED on ${indexReadFailedBoards.length} board(s): ${indexReadFailedBoards.join(", ")}.`,
        "    Nothing on those boards was repaired, and no drift there was measured — the index is the only",
        "    candidate source for milestones the enumeration sweep misses, which on this node is most of them.",
        `    Any upserts counted below for those boards are UNVERIFIED rewrites, not observed drift, and`,
        "    rows_examined excludes their rows. This is load, not corruption: retry when the node is quieter.",
      ]
    : [];
  const text = [
    "milestone indexes heal:",
    ...ceilingLine,
    ...indexReadLine,
    ...leadLine,
    `  applied=${applying} budget=${budget === null ? "unlimited" : budget}`,
    `  rows_examined=${rowsExamined} removals_classified=${removalsClassified} removal_ceiling=${removalCeiling === null ? "unlimited" : removalCeiling} blocked=${blocked}`,
    `  board_milestones bound=${boardMsBound} scanned=${milestones.length} (enumerated=${slugs.length} single_lead=${sweep.wideScanSlugs} husks_dropped=${husksDropped}) upserts=${boardMilestoneUpserts} removals=${boardMilestoneRemovals}`,
    `  milestone_cards bound=${msCardsBound} mode=${directMilestoneCardPayloadUpsert ? "direct-payload-upsert" : "protein-fold-request"} children_scanned=${milestoneCardChildrenScanned} upserts=${milestoneCardUpserts} removals=${milestoneCardRemovals}`,
    `  issued=${issued} deferred=${deferred}`,
  ].join("\n");

  return {
    board_milestones_bound: boardMsBound,
    milestone_cards_bound: msCardsBound,
    applied: applying,
    budget,
    rows_examined: rowsExamined,
    removals_classified: removalsClassified,
    removal_ceiling: removalCeiling,
    blocked,
    milestones_enumerated: slugs.length,
    milestones_enumerated_single_lead: sweep.wideScanSlugs,
    enumeration_failed_leads: sweep.failedLeads,
    index_read_failed_boards: indexReadFailedBoards,
    milestone_husks_dropped: husksDropped,
    milestones_scanned: milestones.length,
    milestone_card_children_scanned: milestoneCardChildrenScanned,
    board_milestone_upserts: boardMilestoneUpserts,
    board_milestone_removals: boardMilestoneRemovals,
    milestone_card_upserts: milestoneCardUpserts,
    milestone_card_removals: milestoneCardRemovals,
    issued,
    deferred,
    direct_milestone_card_payload_upsert: directMilestoneCardPayloadUpsert,
    text,
  };
}
