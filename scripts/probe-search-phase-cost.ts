#!/usr/bin/env bun
/**
 * READ-ONLY probe: where do the seconds in one `kanban search` actually go?
 *
 * The handoff carried "`kanban search` is 15s". That number does not reproduce
 * (measured 2.7-9.9s across repeats of the SAME query on an unchanged binary),
 * so this probe exists to replace a single contended wall-clock reading with a
 * per-phase breakdown that says which read is expensive and whether it is
 * expensive every time.
 *
 * `indexedSearchCards` issues exactly two reads, deliberately in parallel:
 *
 *   A. the DISPLAY read  — listCardsByFilter(CARD_DISPLAY_FIELDS)
 *   B. the BODY scan     — listCardBodies (slug+body, admin scan)
 *
 * Parallel means the command's floor is max(A, B), not A + B, so timing them
 * TOGETHER (as any wall-clock measure of the command does) cannot say which one
 * sets the floor. This runs them serially and interleaved across reps.
 *
 * Reports each arm's median rather than its mean: the first rep on a cold
 * client is reliably several times the steady-state cost, and a mean lets that
 * one reading set the published number — which is how "15s" happened.
 *
 * Run: bun scripts/probe-search-phase-cost.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { CARD_DISPLAY_FIELDS, listCardBodies, listCardsByFilter } from "../src/record.ts";

const REPS = Number(process.argv[2] ?? 5);

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const ms = async <T>(fn: () => Promise<T>): Promise<[number, T]> => {
  const t0 = performance.now();
  const v = await fn();
  return [performance.now() - t0, v];
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : ((s[m - 1] as number) + (s[m] as number)) / 2;
};

const display: number[] = [];
const bodyScan: number[] = [];
let displayRows = 0;
let bodyRows = 0;

// Interleaved, so a drift in node load over the run lands on both arms rather
// than on whichever one happened to be measured second.
for (let i = 0; i < REPS; i++) {
  const [dMs, d] = await ms(() =>
    listCardsByFilter(node, cfg, {}, CARD_DISPLAY_FIELDS, { allowFullScanFallback: false }),
  );
  display.push(dMs);
  displayRows = d.cards.length;

  const [bMs, b] = await ms(() => listCardBodies(node, cfg));
  bodyScan.push(bMs);
  bodyRows = b?.size ?? 0;
}

const fmt = (xs: number[]): string =>
  `median ${median(xs).toFixed(0)}ms  first ${(xs[0] as number).toFixed(0)}ms  ` +
  `min ${Math.min(...xs).toFixed(0)}ms  max ${Math.max(...xs).toFixed(0)}ms`;

console.log(`reps=${REPS}  display_rows=${displayRows}  body_rows=${bodyRows}`);
console.log(`A. display read (${CARD_DISPLAY_FIELDS.length} fields)  ${fmt(display)}`);
console.log(`B. body scan    (slug+body)       ${fmt(bodyScan)}`);
console.log(
  `\nparallel floor = max(A,B) median = ${Math.max(median(display), median(bodyScan)).toFixed(0)}ms`,
);
console.log(
  `first-rep floor = ${Math.max(display[0] as number, bodyScan[0] as number).toFixed(0)}ms` +
    `  <- what a one-shot CLI measurement sees`,
);
