import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardCardsHealScheduledResult,
  DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT,
} from "../src/commands/board_cards_heal_scheduled.ts";
import type {
  BoardCardsHealOptions,
  BoardCardsHealReport,
} from "../src/commands/board_cards_heal.ts";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {},
} as Config;

const node = {} as NodeClient;

function report(partial: Partial<BoardCardsHealReport> = {}): BoardCardsHealReport {
  return {
    scanned_index_rows: 0,
    drifted: 0,
    healed: 0,
    missing_card: 0,
    dryRun: true,
    actions: [],
    ...partial,
  };
}

describe("board-cards scheduled heal", () => {
  test("reports clean drift without applying", async () => {
    const calls: BoardCardsHealOptions[] = [];
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => {
        calls.push(opts);
        return { text: "", report: report({ drifted: 0, healed: 0, dryRun: !opts.apply }) };
      },
    });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.apply).toBe(false);
    expect(calls[0]!.board).toBe("default");
    expect(result.report).toMatchObject({
      drifted: 0,
      applied: false,
      blocked: false,
      reason: "clean",
      max_drift: DEFAULT_BOARD_CARDS_HEAL_MAX_DRIFT,
    });
  });

  test("applies non-zero drift at or below the ceiling", async () => {
    const calls: BoardCardsHealOptions[] = [];
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      maxDrift: 3,
      heal: async (opts) => {
        calls.push(opts);
        return {
          text: "",
          report: report({
            drifted: 3,
            healed: opts.apply ? 3 : 0,
            missing_card: 1,
            dryRun: !opts.apply,
          }),
        };
      },
    });

    expect(calls.map((c) => c.apply)).toEqual([false, true]);
    expect(result.report).toMatchObject({
      drifted: 3,
      applied: true,
      blocked: false,
      reason: "healed",
    });
    expect(result.report.apply_run?.healed).toBe(3);
  });

  test("honors dry-run-only after measuring drift", async () => {
    const calls: BoardCardsHealOptions[] = [];
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      dryRunOnly: true,
      heal: async (opts) => {
        calls.push(opts);
        return { text: "", report: report({ drifted: 2, healed: 0, dryRun: !opts.apply }) };
      },
    });

    expect(calls.map((c) => c.apply)).toEqual([false]);
    expect(result.report).toMatchObject({
      drifted: 2,
      applied: false,
      blocked: false,
      reason: "dry-run-only",
    });
  });

  test("refuses to apply when drift exceeds the ceiling", async () => {
    const calls: BoardCardsHealOptions[] = [];
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      maxDrift: 3,
      heal: async (opts) => {
        calls.push(opts);
        return { text: "", report: report({ drifted: 4, healed: 0, dryRun: !opts.apply }) };
      },
    });

    expect(calls.map((c) => c.apply)).toEqual([false]);
    expect(result.report).toMatchObject({
      drifted: 4,
      applied: false,
      blocked: true,
      reason: "ceiling-exceeded",
    });
  });
});
