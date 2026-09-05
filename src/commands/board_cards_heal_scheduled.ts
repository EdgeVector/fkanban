import type { Config } from "../config.ts";
import type { NodeClient } from "../client.ts";
import {
  boardCardsHealResult,
  type BoardCardsHealOptions,
  type BoardCardsHealReport,
} from "./board_cards_heal.ts";
import { boardCardsReadDiverged } from "../board-cards.ts";

/**
 * Partitions whose two reads disagreed in this run, or an empty array.
 *
 * Read off the DRY run, so the hourly routine never issues the apply at all
 * when the node is serving inconsistent pages. `boardCardsHealResult` refuses
 * the same condition again on its own — the two are not redundant: this wrapper
 * is one caller, and the refusal has to sit at the write.
 */
export function healReadDivergence(report: BoardCardsHealReport): string[] {
  return (report.read_divergence ?? []).filter(boardCardsReadDiverged).map((d) => d.board);
}

export const DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT = 250;

export type BoardCardsHealScheduledReport = {
  board: string;
  max_drift: number;
  drifted: number;
  applied: boolean;
  blocked: boolean;
  /**
   * `clean` is a verdict ABOUT THE BOARD and may only be used by a run that
   * looked at it. `incomplete` is the same `drifted === 0` with the coverage
   * missing — see {@link healWasIncomplete}.
   */
  reason:
    | "clean"
    | "incomplete"
    | "dry-run-only"
    | "healed"
    | "ceiling-exceeded"
    | "read-divergence";
  /**
   * Why this run's coverage was partial, or null. Carried up from the heal
   * report because this wrapper reduces it to one number and one word, and
   * those two are what the hourly routine logs — the nested report is not read
   * by anything.
   */
  incomplete_reason: string | null;
  dry_run: BoardCardsHealReport;
  apply_run?: BoardCardsHealReport;
};

/**
 * Did this heal actually cover the board it is about to pronounce on?
 *
 * Two ways it did not, and `drifted === 0` is the output of BOTH:
 *
 *  - the candidate-discovery scan was refused, so cards with no BoardCards row
 *    were never offered — and those are the ones invisible to `kanban list`;
 *  - `board_cards` is unbound, so no partition was read and no row could be
 *    written.
 *
 * This wrapper is what `last-stack-fkanban-watch` runs hourly, and
 * `renderReport` is what lands in its log. Before this, both states rendered as
 * `drifted=0 ... reason=clean` — the word `clean`, from a run that did not
 * look. The underlying report grew fields for this; nothing up here read them,
 * which is the same defect one level up and at the level that actually runs.
 */
export function healWasIncomplete(report: BoardCardsHealReport): string | null {
  if (report.board_cards_bound === false) {
    return "board_cards schema not bound — no partition was read and no row could be written";
  }
  if (report.discovery_failed) {
    return `candidate-discovery scan failed: ${report.discovery_failed}`;
  }
  return null;
}

export type BoardCardsHealScheduledOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  maxDrift?: number;
  dryRunOnly?: boolean;
  json?: boolean;
  heal?: (opts: BoardCardsHealOptions) => Promise<{ text: string; report: BoardCardsHealReport }>;
};

function renderReport(report: BoardCardsHealScheduledReport): string {
  const parts = [
    `board-cards scheduled-heal: board=${report.board}`,
    `drifted=${report.drifted}`,
    `max_drift=${report.max_drift}`,
    `applied=${report.applied}`,
    `blocked=${report.blocked}`,
    `reason=${report.reason}`,
  ];
  if (report.apply_run) parts.push(`healed=${report.apply_run.healed}`);
  const line = parts.join(" ");
  // On its OWN line and marked, not appended to the summary: this text is
  // grepped out of a routine log, and a caveat living at the end of the line
  // that starts `drifted=0` gets read as part of the good news.
  if (!report.incomplete_reason) return line;
  // Two different caveats, and they must not share a sentence. Incomplete
  // coverage makes `drifted` a LOWER BOUND — the run saw part of the board and
  // everything it saw was true. Divergence makes `drifted` no bound at all:
  // the run saw two boards and cannot say which one exists, so a count that is
  // too HIGH is equally possible.
  if (report.reason === "read-divergence") {
    return (
      `${line}\n  ⚠ READ DIVERGENCE — ${report.incomplete_reason}.\n` +
      `    drifted=${report.drifted} is not a bound in either direction; nothing was written.\n` +
      `    This is a node read degradation. Re-run when the reads agree; restart nothing.`
    );
  }
  return (
    `${line}\n  ⚠ INCOMPLETE COVERAGE — ${report.incomplete_reason}.\n` +
    `    drifted=${report.drifted} is a LOWER BOUND; this run did not see the whole board.`
  );
}

export async function boardCardsHealScheduledResult(
  opts: BoardCardsHealScheduledOptions,
): Promise<{ text: string; report: BoardCardsHealScheduledReport }> {
  const board = opts.board?.trim() || "default";
  const maxDrift = opts.maxDrift ?? DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT;
  const heal = opts.heal ?? boardCardsHealResult;

  const dry = await heal({
    cfg: opts.cfg,
    node: opts.node,
    board,
    apply: false,
    json: false,
  });
  const drifted = dry.report.drifted;
  const incomplete = healWasIncomplete(dry.report);

  let report: BoardCardsHealScheduledReport;
  const divergentBoards = healReadDivergence(dry.report);
  if (divergentBoards.length > 0) {
    // BEFORE the `drifted === 0` branch, because a divergent read makes
    // `drifted` untrustworthy in BOTH directions — `0` from a run that could
    // not see the board reads exactly like a clean one, which is the mistake
    // `healWasIncomplete` exists to stop this wrapper making about coverage.
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: false,
      blocked: true,
      reason: "read-divergence",
      incomplete_reason:
        `node served inconsistent views of partition(s) ${divergentBoards.join(",")} — ` +
        `the whole-partition read and the per-column reads disagree`,
      dry_run: dry.report,
    };
  } else if (drifted === 0) {
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: false,
      blocked: false,
      // The only branch where the distinction changes the WORD, because it is
      // the only one that asserts something about the board rather than about
      // this run's own limits. A partial run that still found drift is
      // reported as `healed` — it did real work — with the caveat on its own
      // line.
      reason: incomplete ? "incomplete" : "clean",
      incomplete_reason: incomplete,
      dry_run: dry.report,
    };
  } else if (drifted > maxDrift) {
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: false,
      blocked: true,
      reason: "ceiling-exceeded",
      incomplete_reason: incomplete,
      dry_run: dry.report,
    };
  } else if (opts.dryRunOnly) {
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: false,
      blocked: false,
      reason: "dry-run-only",
      incomplete_reason: incomplete,
      dry_run: dry.report,
    };
  } else {
    const applied = await heal({
      cfg: opts.cfg,
      node: opts.node,
      board,
      apply: true,
      json: false,
    });
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: true,
      blocked: false,
      reason: "healed",
      // From the APPLY run, not the dry one: the two are separate reads, and a
      // scan that answered for the plan may be refused for the write.
      incomplete_reason: healWasIncomplete(applied.report) ?? incomplete,
      dry_run: dry.report,
      apply_run: applied.report,
    };
  }

  return { text: renderReport(report), report };
}

export async function boardCardsHealScheduledCmd(
  opts: BoardCardsHealScheduledOptions,
): Promise<string> {
  const { text, report } = await boardCardsHealScheduledResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
