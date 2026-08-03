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

export type MilestoneIndexesHealResult = {
  board_milestones_bound: boolean;
  milestone_cards_bound: boolean;
  applied: boolean;
  budget: number | null;
  /** Slugs the full scan returned — mostly husks; NOT a count of live milestones. */
  milestones_enumerated: number;
  /** Enumerated slugs whose point-read found nothing (deleted husks). */
  milestone_husks_dropped: number;
  /** Enumerated slugs that point-read back to a live milestone. */
  milestones_scanned: number;
  milestone_card_children_scanned: number;
  board_milestone_upserts: number;
  board_milestone_removals: number;
  milestone_card_upserts: number;
  milestone_card_removals: number;
  issued: number;
  deferred: number;
  /** @deprecated use board_milestone_upserts */
  milestones_written: number;
  /** @deprecated use milestone_card_upserts */
  cards_written: number;
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
}): Promise<BoardMilestoneOp[]> {
  const bySlug = new Map(opts.milestones.map((milestone) => [milestone.slug, milestone]));
  const rowsByBoard = new Map<string, Milestone[] | null>();
  for (const board of opts.boards) {
    rowsByBoard.set(board.slug, await listBoardMilestonesPartition(opts.node, opts.cfg, board.slug));
  }

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
  return ops;
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
      milestone_husks_dropped: 0,
      milestones_scanned: 0,
      milestone_card_children_scanned: 0,
      board_milestone_upserts: 0,
      board_milestone_removals: 0,
      milestone_card_upserts: 0,
      milestone_card_removals: 0,
      issued: 0,
      deferred: 0,
      milestones_written: 0,
      cards_written: 0,
      direct_milestone_card_payload_upsert: directMilestoneCardPayloadUpsert,
      text:
        "milestone indexes heal: board_milestones and milestone_cards not bound in config — run `fkanban init` first",
    };
  }

  // Always rebuild from fat Milestone rows (full-scan + HashKey hydrate), never
  // from BoardMilestones (may be empty or polluted during first heal).
  const { schemaHashFor } = await import("../config.ts");
  const { fieldsFor } = await import("../schemas.ts");
  const { rowToMilestone, milestoneQueryFieldsLookSparse } = await import("../record.ts");
  const res = await opts.node.queryAll({
    schemaHash: schemaHashFor("milestone", opts.cfg),
    fields: fieldsFor("milestone"),
    allowFullScan: true,
  });
  const slugs = res.results.map((row) => {
    const mapped = rowToMilestone(row);
    if (!milestoneQueryFieldsLookSparse((row.fields ?? {}) as Record<string, unknown>)) {
      return mapped.slug;
    }
    return mapped.slug || String((row.fields as { slug?: string } | undefined)?.slug ?? "");
  }).filter(Boolean);

  // The scan ENUMERATES; only a point-read establishes truth. Most of what it
  // returns on the live primary is husks of deleted milestones, so track what
  // the hydrate discards instead of letting `scanned` imply the scan found it.
  // Measured 2026-08-03: 21 enumerated -> 10 live, 11 husks.
  const milestones: Milestone[] = [];
  let husksDropped = 0;
  for (const slug of slugs) {
    const full = await findMilestone(opts.node, opts.cfg, slug);
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
  const boardOps = boardMsBound
    ? await classifyBoardMilestoneOps({ cfg: opts.cfg, node: opts.node, boards, milestones })
    : [];

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

  let issued = 0;
  if (boardMsBound) {
    for (const op of boardOps) {
      if (!apply || !budgetAllowsAnother(budget, issued)) break;
      if (op.kind === "upsert") {
        await upsertBoardMilestone(opts.node, opts.cfg, op.milestone, op.previous);
      } else {
        await removeBoardMilestone(opts.node, opts.cfg, op.milestone);
      }
      issued += 1;
    }
  }

  if (msCardsBound && apply) {
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
  const text = [
    "milestone indexes heal:",
    `  applied=${apply} budget=${budget === null ? "unlimited" : budget}`,
    `  board_milestones bound=${boardMsBound} scanned=${milestones.length} (enumerated=${slugs.length} husks_dropped=${husksDropped}) upserts=${boardMilestoneUpserts} removals=${boardMilestoneRemovals}`,
    `  milestone_cards bound=${msCardsBound} mode=${directMilestoneCardPayloadUpsert ? "direct-payload-upsert" : "protein-fold-request"} children_scanned=${milestoneCardChildrenScanned} upserts=${milestoneCardUpserts} removals=${milestoneCardRemovals}`,
    `  issued=${issued} deferred=${deferred}`,
  ].join("\n");

  return {
    board_milestones_bound: boardMsBound,
    milestone_cards_bound: msCardsBound,
    applied: apply,
    budget,
    milestones_enumerated: slugs.length,
    milestone_husks_dropped: husksDropped,
    milestones_scanned: milestones.length,
    milestone_card_children_scanned: milestoneCardChildrenScanned,
    board_milestone_upserts: boardMilestoneUpserts,
    board_milestone_removals: boardMilestoneRemovals,
    milestone_card_upserts: milestoneCardUpserts,
    milestone_card_removals: milestoneCardRemovals,
    issued,
    deferred,
    milestones_written: boardMilestoneUpserts,
    cards_written: milestoneCardUpserts,
    direct_milestone_card_payload_upsert: directMilestoneCardPayloadUpsert,
    text,
  };
}
