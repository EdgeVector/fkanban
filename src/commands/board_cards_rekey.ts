// Two-phase BoardCards key repair.
//
// `init` stages a distinct board-keyed identity as `board_cards_rekey_target`
// while reads remain pinned to the incumbent. Hot mutations dual-write both
// identities. This command uses Card truth through the existing heal operator
// to regenerate target tips. A second clean apply swaps the read pin only after
// the target reports complete, preserving the old pin for rollback evidence.

import type { NodeClient } from "../client.ts";
import { FkanbanError } from "../client.ts";
import { writeConfig, type Config } from "../config.ts";
import {
  BOARD_CARDS_REKEY_TARGET,
  boardCardsHash,
} from "../board-cards.ts";
import { boardCardsHealResult, type BoardCardsHealReport } from "./board_cards_heal.ts";

export const BOARD_CARDS_REKEY_PREVIOUS = "board_cards_rekey_previous";

export type BoardCardsRekeyOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
  board?: string;
};

export type BoardCardsRekeyReport = {
  state: "not-staged" | "backfill-needed" | "cutover-ready" | "cutover-complete" | "blocked";
  active: string | null;
  target: string | null;
  apply: boolean;
  cutover: boolean;
  heal: BoardCardsHealReport | null;
};

/** Config view that makes the existing heal operator read/write only target. */
export function boardCardsRekeyTargetConfig(cfg: Config): Config | null {
  const target = cfg.schemaHashes[BOARD_CARDS_REKEY_TARGET];
  if (!target) return null;
  const schemaHashes: Record<string, string> = { ...cfg.schemaHashes, board_cards: target };
  delete schemaHashes[BOARD_CARDS_REKEY_TARGET];
  return { ...cfg, schemaHashes };
}

/** Swap target into the product read pin while retaining the old address. */
export function boardCardsRekeyCutoverConfig(cfg: Config): Config {
  const active = boardCardsHash(cfg);
  const target = cfg.schemaHashes[BOARD_CARDS_REKEY_TARGET];
  if (!active || !target) {
    throw new FkanbanError({
      code: "board_cards_rekey_not_staged",
      message: "No complete BoardCards rekey pair is staged in config.",
      hint: "Run `kanban init` on a node whose board-keyed declaration resolves to a new identity first.",
    });
  }
  const schemaHashes: Record<string, string> = {
    ...cfg.schemaHashes,
    board_cards: target,
    [BOARD_CARDS_REKEY_PREVIOUS]: active,
  };
  delete schemaHashes[BOARD_CARDS_REKEY_TARGET];
  return { ...cfg, schemaHashes };
}

function healConverged(report: BoardCardsHealReport): boolean {
  return !report.blocked &&
    report.discovery_failed === null &&
    report.incomplete_leads.length === 0 &&
    report.drifted === 0 &&
    report.would_heal === 0;
}

export async function boardCardsRekeyResult(
  opts: BoardCardsRekeyOptions,
): Promise<{ text: string; report: BoardCardsRekeyReport }> {
  const active = boardCardsHash(opts.cfg);
  const target = opts.cfg.schemaHashes[BOARD_CARDS_REKEY_TARGET] ?? null;
  const targetCfg = boardCardsRekeyTargetConfig(opts.cfg);
  if (!active || !target || !targetCfg) {
    const report: BoardCardsRekeyReport = {
      state: "not-staged",
      active,
      target,
      apply: Boolean(opts.apply),
      cutover: false,
      heal: null,
    };
    return {
      text: "board-cards rekey: NOT STAGED — active reads are unchanged; run `kanban init` to declare/stage the distinct board-keyed identity.",
      report,
    };
  }

  const healed = await boardCardsHealResult({
    cfg: targetCfg,
    node: opts.node,
    apply: opts.apply,
    json: true,
    board: opts.board,
    // A new target should contain no orphans. Never let a rekey bootstrap turn
    // into a deletion sweep; surface contamination and stop instead.
    maxRemovals: 0,
  });
  const converged = healConverged(healed.report);
  let cutover = false;
  let state: BoardCardsRekeyReport["state"];

  if (healed.report.blocked || healed.report.discovery_failed || healed.report.incomplete_leads.length > 0) {
    state = "blocked";
  } else if (!converged) {
    state = "backfill-needed";
  } else if (!opts.apply) {
    state = "cutover-ready";
  } else {
    if (!opts.cfg.configPath) {
      throw new FkanbanError({
        code: "board_cards_rekey_config_path_missing",
        message: "BoardCards target is converged, but the loaded config has no writable configPath.",
        hint: "Run this command through the installed fkanban CLI with KANBAN_CONFIG/FKANBAN_CONFIG set explicitly.",
      });
    }
    const next = boardCardsRekeyCutoverConfig(opts.cfg);
    writeConfig(next, opts.cfg.configPath);
    opts.cfg.schemaHashes = next.schemaHashes;
    cutover = true;
    state = "cutover-complete";
  }

  const report: BoardCardsRekeyReport = {
    state,
    active,
    target,
    apply: Boolean(opts.apply),
    cutover,
    heal: healed.report,
  };
  const text = [
    `board-cards rekey: state=${state} active=${active} target=${target}`,
    `  target scanned=${healed.report.scanned_index_rows} drifted=${healed.report.drifted} ` +
      `healed=${healed.report.healed} would_heal=${healed.report.would_heal}`,
    state === "backfill-needed" && opts.apply
      ? "  Target writes landed; re-run the same apply command. Cutover occurs only on a clean pass."
      : state === "cutover-ready"
        ? "  Target is complete. Re-run with --apply to atomically cut the read pin over."
        : state === "cutover-complete"
          ? "  Read pin cut over; the previous identity remains recorded as board_cards_rekey_previous."
          : "",
  ].filter(Boolean).join("\n");
  return { text, report };
}

export async function boardCardsRekeyCmd(opts: BoardCardsRekeyOptions): Promise<string> {
  const { text, report } = await boardCardsRekeyResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
