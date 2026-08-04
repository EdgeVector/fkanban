#!/usr/bin/env bun
/**
 * READ-ONLY probe: how many Situation-preflight SUBPROCESSES does one
 * `kanban pickup status` start, and how many run at the same time?
 *
 * `pickup.ts` fences every pickup-ready card through `checkSituationFence`,
 * inside a bare `Promise.all` over the filtered card list. That call is not a
 * node read — it is `Bun.spawn` of the `fsituations` CLI (and, when the first
 * candidate is not on PATH, a second spawn of `bun --cwd <checkout> src/cli.ts`,
 * which starts a whole TypeScript CLI from source).
 *
 * `concurrency.ts` exists to stop exactly this shape one class down ("an
 * unbounded `Promise.all` over N card slugs is a load hazard, not a speedup").
 * This measures whether the process-spawn fan-out obeys any bound at all.
 *
 * Counts on the CLIENT side, by substituting a preflight that records instead of
 * spawning, so nothing here depends on fsituations being installed and the probe
 * cannot itself add load to the primary. Run: bun scripts/probe-pickup-fence-spawn-fanout.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import type { SituationPreflightResponse } from "../src/situations.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

let inFlight = 0;
let maxInFlight = 0;
let total = 0;
const perAction = new Map<string, number>();

/**
 * Stands in for `fsituationsPreflight`. Holds the call open ~12ms — long enough
 * that genuinely concurrent calls overlap and the high-water mark is real,
 * rather than an artifact of instant returns never coexisting.
 */
const recordingPreflight = async (opts: { action: string; repo: string }): Promise<SituationPreflightResponse> => {
  total += 1;
  perAction.set(opts.action, (perAction.get(opts.action) ?? 0) + 1);
  inFlight += 1;
  if (inFlight > maxInFlight) maxInFlight = inFlight;
  try {
    await new Promise((r) => setTimeout(r, 12));
    return { ok: true } as SituationPreflightResponse;
  } finally {
    inFlight -= 1;
  }
};

const t0 = performance.now();
const { report } = await pickupStatusResult({ cfg, node, situationPreflight: recordingPreflight });
const ms = performance.now() - t0;

const ready = report.cards.filter((c) => c.category === "pickup-ready").length;
console.log(`pickup status — ${report.cards.length} cards classified, ${ready} pickup-ready, ${ms.toFixed(0)}ms`);
console.log(`Situation preflight subprocess spawns: total=${total}  MAX CONCURRENT=${maxInFlight}`);
console.log(`(each spawn is a Bun.spawn of the fsituations CLI; on PATH miss it is`);
console.log(` retried as \`bun --cwd <checkout> src/cli.ts\`, i.e. up to 2x this count)`);
for (const [action, n] of [...perAction.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  action=${action.padEnd(28)} ${n}`);
}
