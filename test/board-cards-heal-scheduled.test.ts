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
    would_heal: 0,
    missing_card: 0,
    board_cards_bound: true,
    discovery_failed: null,
    incomplete_leads: [],
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

// `drifted === 0` is the output of a converged board AND of a run that never
// looked at one. This wrapper turned both into the word `clean`, and this
// wrapper is what `last-stack-fkanban-watch` runs hourly with `--apply` — so
// `reason=clean` in that routine's log was the only thing anyone read.
//
// See `heal-discovery-failure-vacuous-green.test.ts` for the underlying command
// and the measured reason the documented "fallback to the rollup" is not one.
describe("a scheduled heal must not call a board clean from a run that did not look", () => {
  test("a refused discovery scan is `incomplete`, not `clean`", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({
        text: "",
        report: report({
          drifted: 0,
          dryRun: !opts.apply,
          discovery_failed: "too many concurrent reads",
        }),
      }),
    });

    expect(result.report.reason).toBe("incomplete");
    expect(result.report.incomplete_reason).toContain("too many concurrent reads");
    expect(result.text).toContain("⚠ INCOMPLETE COVERAGE");
    expect(result.text).toContain("LOWER BOUND");
  });

  test("an unbound board_cards is `incomplete`, not `clean`", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({
        text: "",
        report: report({ drifted: 0, dryRun: !opts.apply, board_cards_bound: false }),
      }),
    });

    expect(result.report.reason).toBe("incomplete");
    expect(result.report.incomplete_reason).toContain("not bound");
  });

  // POSITIVE TWIN, and deliberately asserting ONLY on behaviour that predates
  // this fix, so it stays green when the fix is reverted. A gate that fires on
  // every run is a gate that gets muted inside a week; this is the assertion
  // that would catch that, and it can only do its job if it is not also
  // testing the new field. (The four tests above it are the same twin set for
  // the other three verdicts, and all four survive the revert.)
  test("a complete run over a converged board still says clean, with no warning", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({ text: "", report: report({ drifted: 0, dryRun: !opts.apply }) }),
    });

    expect(result.report.reason).toBe("clean");
    expect(result.text).not.toContain("⚠");
  });

  test("a complete run carries no incomplete_reason", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({ text: "", report: report({ drifted: 0, dryRun: !opts.apply }) }),
    });

    expect(result.report.incomplete_reason).toBeNull();
  });

  // A partial run that still found drift did real work; it is `healed`, and the
  // caveat rides alongside rather than replacing the verdict.
  test("drift found under a refused scan still heals, and still says so", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({
        text: "",
        report: report({
          drifted: 2,
          healed: opts.apply ? 2 : 0,
          dryRun: !opts.apply,
          discovery_failed: "service_timeout",
        }),
      }),
    });

    expect(result.report.reason).toBe("healed");
    expect(result.report.applied).toBe(true);
    expect(result.report.incomplete_reason).toContain("service_timeout");
    expect(result.text).toContain("⚠ INCOMPLETE COVERAGE");
  });

  // The apply is a SECOND read of the node. A scan that answered for the plan
  // may be refused for the write, and it is the apply run that describes what
  // actually landed.
  test("a scan refused only on the apply run is still surfaced", async () => {
    const result = await boardCardsHealScheduledResult({
      cfg,
      node,
      heal: async (opts) => ({
        text: "",
        report: report({
          drifted: 2,
          healed: opts.apply ? 2 : 0,
          dryRun: !opts.apply,
          discovery_failed: opts.apply ? "too many concurrent reads" : null,
        }),
      }),
    });

    expect(result.report.reason).toBe("healed");
    expect(result.report.incomplete_reason).toContain("too many concurrent reads");
  });
});
