// The parity sweep, and nothing else — a check a routine can actually run.
//
// `kanban doctor`'s three projection-parity checks are the ONLY thing in the
// system that can detect a row silently dropped from every product read.
// Nothing else compares a complete enumeration against the projection the board
// serves: `board-cards heal` reads THROUGH the lossy projection, which is how it
// reported `missing_card: 0` while 58 orphans sat in the partition it had just
// enumerated.
//
// And no routine ran doctor. Checked 2026-08-04 across `~/.routines/prompts/`:
// the only two mentions tell agents NOT to
// (`routine-fleet-health.md` groups it with the retired TCP `:9001` probe;
// `kanban-validate.md` scopes a correct prohibition to the busy-node case). So
// every "not an incident today, and detected if it recurs" verdict in the
// BoardCards papercut set rested on a check that fired only when a
// chief-engineer run typed it by hand. The detection half was not staffed.
//
// The prohibition was right for reasons that outlived its stated rationale:
//
//   1. **Doctor MUTATES.** It write-probes five schemas (`create+delete of an
//      all-fields record round-tripped`). A health check that writes is not a
//      health check. This command reads and never writes — that is its whole
//      point, and why it is a separate entrypoint rather than a doctor flag.
//   2. **Doctor is expensive**, and most of that is not parity. This runs the
//      three sweeps only.
//
// So: read-only, low frequency, and nonzero exit ONLY on confirmed drift, so a
// routine can treat it as a gate without being paged by ordinary board churn.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { listBoards } from "../record.ts";
import { listBoardCardsPartition, sweepBoardCardsPartition } from "../board-cards.ts";
import {
  listBoardMilestonesPartition,
  sweepBoardMilestonesPartition,
} from "../board-milestones.ts";
import {
  listMilestoneCardsPartition,
  sweepMilestoneCardsPartition,
} from "../milestone-cards.ts";
import { parityWithConfirmation } from "../membership_schema_guard.ts";
import { PARTITION_READ_CONCURRENCY, mapWithConcurrency } from "../concurrency.ts";

export type ParityCheckOptions = {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
  /** Limit to one board. Milestone partitions are still derived from its cards. */
  board?: string;
};

export type ParityPartitionResult = {
  index: "BoardCards" | "BoardMilestones" | "MilestoneCards";
  partition: string;
  /** Rows the wide read returned. */
  rows: number;
  /** Slugs stably present in the partition that the wide read cannot serve. */
  drift: string[];
  /** Slugs that entered or left mid-check. Never grounds for a repair. */
  moved: string[];
  /**
   * `false` when the second sweep could not run or came back short a lead. The
   * `drift` list is then a first-pass suspicion, not a finding — which is why
   * it is reported separately from `ok` rather than folded into it.
   */
  confirmed: boolean;
  /** Leads the node refused. A short enumeration is not a clean bill. */
  incomplete: string[];
};

export type ParityCheckReport = {
  ok: boolean;
  partitions_checked: number;
  rows_checked: number;
  /** Partitions with CONFIRMED drift — the only thing that flips `ok`. */
  drift: ParityPartitionResult[];
  /** Partitions that could not be fully enumerated. Also flips `ok`. */
  incomplete: ParityPartitionResult[];
  /** Partitions where rows moved mid-check. Informational; never flips `ok`. */
  churn: ParityPartitionResult[];
  /** Flagged partitions whose re-sweep did not complete. Flips `ok`: unproven, not disproven. */
  unconfirmed: ParityPartitionResult[];
};

const empty = (
  index: ParityPartitionResult["index"],
  partition: string,
): ParityPartitionResult => ({
  index,
  partition,
  rows: 0,
  drift: [],
  moved: [],
  confirmed: true,
  incomplete: [],
});

export async function parityCheckResult(
  opts: ParityCheckOptions,
): Promise<ParityCheckReport> {
  const { cfg, node } = opts;
  const results: ParityPartitionResult[] = [];
  const allBoards = await listBoards(node, cfg);
  const boards = opts.board ? allBoards.filter((b) => b.slug === opts.board) : allBoards;

  // Milestone partitions worth checking, harvested from the BoardCards wide
  // reads below. A CANDIDATE list, not truth: that read is itself the lossy one
  // under test, so a milestone reachable only through a dropped row will not
  // appear. The report says so rather than implying full coverage.
  const milestoneCandidates = new Set<string>();

  for (const b of boards) {
    const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
    if (sweep === null) continue;
    if (sweep.failedLeads.length > 0) {
      results.push({
        ...empty("BoardCards", b.slug),
        incomplete: sweep.failedLeads.map((f) => f.field),
      });
      continue;
    }
    const wide = await listBoardCardsPartition(node, cfg, b.slug);
    if (wide === null) {
      results.push({ ...empty("BoardCards", b.slug), incomplete: ["<wide read returned nothing>"] });
      continue;
    }
    for (const c of wide) {
      const ms = c.milestone ?? "";
      if (ms.length > 0) milestoneCandidates.add(ms);
    }
    const conf = await parityWithConfirmation({
      firstSweep: sweep.rows,
      wideSlugs: new Set(wide.map((c) => c.slug)),
      wideRows: wide.length,
      resweep: () => sweepBoardCardsPartition(node, cfg, b.slug),
    });
    results.push({
      index: "BoardCards",
      partition: b.slug,
      rows: wide.length,
      drift: conf.drift,
      moved: conf.moved,
      confirmed: conf.confirmed,
      incomplete: [],
    });
  }

  for (const b of boards) {
    const sweep = await sweepBoardMilestonesPartition(node, cfg, b.slug);
    if (sweep === null) continue;
    if (sweep.failedLeads.length > 0) {
      results.push({
        ...empty("BoardMilestones", b.slug),
        incomplete: sweep.failedLeads.map((f) => f.field),
      });
      continue;
    }
    const wide = await listBoardMilestonesPartition(node, cfg, b.slug);
    if (wide === null) {
      results.push({
        ...empty("BoardMilestones", b.slug),
        incomplete: ["<wide read returned nothing>"],
      });
      continue;
    }
    const conf = await parityWithConfirmation({
      firstSweep: sweep.rows,
      wideSlugs: new Set(wide.map((m) => m.slug)),
      wideRows: wide.length,
      resweep: () => sweepBoardMilestonesPartition(node, cfg, b.slug),
    });
    results.push({
      index: "BoardMilestones",
      partition: b.slug,
      rows: wide.length,
      drift: conf.drift,
      moved: conf.moved,
      confirmed: conf.confirmed,
      incomplete: [],
    });
  }

  const mcResults = await mapWithConcurrency(
    [...milestoneCandidates].sort(),
    async (ms): Promise<ParityPartitionResult | null> => {
      const sweep = await sweepMilestoneCardsPartition(node, cfg, ms);
      if (sweep === null) return null;
      if (sweep.failedLeads.length > 0) {
        return { ...empty("MilestoneCards", ms), incomplete: sweep.failedLeads.map((f) => f.field) };
      }
      const wide = await listMilestoneCardsPartition(node, cfg, ms);
      if (wide === null) {
        return { ...empty("MilestoneCards", ms), incomplete: ["<wide read returned nothing>"] };
      }
      const conf = await parityWithConfirmation({
        firstSweep: sweep.rows,
        wideSlugs: new Set(wide.map((c) => c.slug)),
        wideRows: wide.length,
        resweep: () => sweepMilestoneCardsPartition(node, cfg, ms),
      });
      return {
        index: "MilestoneCards",
        partition: ms,
        rows: wide.length,
        drift: conf.drift,
        moved: conf.moved,
        confirmed: conf.confirmed,
        incomplete: [],
      };
    },
    PARTITION_READ_CONCURRENCY,
  );
  for (const r of mcResults) if (r !== null) results.push(r);

  const drift = results.filter((r) => r.confirmed && r.drift.length > 0);
  const unconfirmed = results.filter((r) => !r.confirmed && r.drift.length > 0);
  const incomplete = results.filter((r) => r.incomplete.length > 0);
  const churn = results.filter((r) => r.moved.length > 0);

  return {
    // Churn alone never flips this: a routine that pages on ordinary board
    // traffic gets muted, and then the real detector is gone again.
    ok: drift.length === 0 && unconfirmed.length === 0 && incomplete.length === 0,
    partitions_checked: results.length,
    rows_checked: results.reduce((n, r) => n + r.rows, 0),
    drift,
    incomplete,
    churn,
    unconfirmed,
  };
}

export async function parityCheckCmd(opts: ParityCheckOptions): Promise<{ text: string; ok: boolean }> {
  const report = await parityCheckResult(opts);
  if (opts.json) return { text: JSON.stringify(report, null, 2), ok: report.ok };

  const lines: string[] = [];
  lines.push(
    `parity-check — ${report.partitions_checked} partition(s), ${report.rows_checked} row(s) served by the wide reads`,
  );
  for (const r of report.incomplete) {
    lines.push(
      `✗ ${r.index} ${r.partition} — enumeration incomplete, node refused lead(s) ${r.incomplete.join(", ")}; ` +
        `a short baseline is not a clean bill`,
    );
  }
  for (const r of report.drift) {
    lines.push(
      `✗ ${r.index} ${r.partition} — ${r.drift.length} row(s) present in the partition and invisible to the wide read: ` +
        `${r.drift.slice(0, 3).join(", ")}`,
    );
  }
  for (const r of report.unconfirmed) {
    lines.push(
      `✗ ${r.index} ${r.partition} — ${r.drift.length} row(s) flagged, UNCONFIRMED: the second sweep did not ` +
        `complete, so a row deleted mid-check cannot be ruled out; re-run before repairing`,
    );
  }
  for (const r of report.churn) {
    lines.push(
      `· ${r.index} ${r.partition} — ${r.moved.length} row(s) entered or left while the check ran; ` +
        `excluded from the verdict`,
    );
  }
  if (report.ok) {
    lines.push("✓ every lead agrees on every partition checked");
    lines.push(
      "  note: MilestoneCards partitions are those named by a card the BoardCards wide read returned — " +
        "a milestone reachable only through a dropped row is not covered.",
    );
  } else {
    lines.push("");
    lines.push("Repair: `kanban groom board-cards-heal --apply` for BoardCards;");
    lines.push("        `kanban milestone reconcile <slug>` for the milestone indexes.");
  }
  return { text: lines.join("\n"), ok: report.ok };
}
