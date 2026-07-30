import type { Config } from "../config.ts";
import type { NodeClient } from "../client.ts";
import {
  boardCardsHealResult,
  type BoardCardsHealOptions,
  type BoardCardsHealReport,
} from "./board_cards_heal.ts";

export const DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT = 250;

export type BoardCardsHealScheduledReport = {
  board: string;
  max_drift: number;
  drifted: number;
  applied: boolean;
  blocked: boolean;
  reason: "clean" | "dry-run-only" | "healed" | "ceiling-exceeded";
  dry_run: BoardCardsHealReport;
  apply_run?: BoardCardsHealReport;
};

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
  return parts.join(" ");
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

  let report: BoardCardsHealScheduledReport;
  if (drifted === 0) {
    report = {
      board,
      max_drift: maxDrift,
      drifted,
      applied: false,
      blocked: false,
      reason: "clean",
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
