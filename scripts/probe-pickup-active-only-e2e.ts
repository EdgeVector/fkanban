#!/usr/bin/env bun
/**
 * End-to-end cost AND verdict equality for `pickup status` reading only the
 * non-terminal columns (`listCards({ activeOnly: true })`).
 *
 * The read itself is already measured
 * (`probe-nonterminal-range-vs-whole.ts`: 449ms -> 214ms on the live board).
 * This probe exists because that number is NOT the answer on its own: dropping
 * the terminal column also drops it from `knownCards`, so a dependency edge
 * pointing at a FINISHED card stops resolving locally and becomes an off-set
 * Card point read. That is exactly the trade that made run (d)'s six-prefix
 * attempt lose, so it gets measured here rather than assumed away.
 *
 * Equality is over the rendered report, which is the whole product surface —
 * counts, per-card verdicts, reasons and dep statuses.
 *
 *   bun scripts/probe-pickup-active-only-e2e.ts        # 5 reps
 *   bun scripts/probe-pickup-active-only-e2e.ts 9
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards } from "../src/record.ts";
import { buildPickupStatusReportWithSituations, renderPickupStatus } from "../src/pickup.ts";

const reps = Number(process.argv[2] ?? 5);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

async function run(activeOnly: boolean): Promise<{ ms: number; text: string; cards: number }> {
  const t = performance.now();
  const boards = await listBoards(node, cfg);
  const cards = await listCards(node, cfg, { boards, ...(activeOnly ? { activeOnly: true } : {}) });
  // No situationPreflight: this compares the two READS, and a live preflight
  // would add a shared, variable cost to both sides for no signal.
  const report = await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });
  return { ms: performance.now() - t, text: renderPickupStatus(report), cards: cards.length };
}

const wholeMs: number[] = [];
const activeMs: number[] = [];
let mismatch = 0;
let wholeCards = 0;
let activeCards = 0;

for (let i = 0; i < reps; i += 1) {
  // Alternate order so neither side gets the warm cache all to itself.
  // Named, not positional: `run` takes `activeOnly`, so passing `wholeFirst`
  // straight in silently swaps the two series and every label with them.
  const wholeFirst = i % 2 === 0;
  const w = wholeFirst ? await run(false) : undefined;
  const a = await run(true);
  const wAfter = wholeFirst ? undefined : await run(false);
  const whole = (w ?? wAfter)!;
  const active = a;
  wholeMs.push(whole.ms);
  activeMs.push(active.ms);
  wholeCards = whole.cards;
  activeCards = active.cards;
  if (whole.text !== active.text) {
    mismatch += 1;
    if (mismatch === 1) {
      const wl = whole.text.split("\n");
      const al = active.text.split("\n");
      for (let k = 0; k < Math.max(wl.length, al.length); k += 1) {
        if (wl[k] !== al[k]) {
          console.log(`  FIRST DIFF line ${k + 1}:\n    whole : ${wl[k] ?? "(none)"}\n    active: ${al[k] ?? "(none)"}`);
          break;
        }
      }
    }
  }
}

const med = (xs: number[]) => [...xs].sort((x, y) => x - y)[Math.floor(xs.length / 2)]!;
const wins = wholeMs.filter((w, i) => activeMs[i]! < w).length;
console.log(`cards fed to the report: whole=${wholeCards}  activeOnly=${activeCards}`);
console.log(`whole board  : median ${Math.round(med(wholeMs))}ms  [${wholeMs.map(Math.round).join(", ")}]`);
console.log(`activeOnly   : median ${Math.round(med(activeMs))}ms  [${activeMs.map(Math.round).join(", ")}]`);
console.log(`activeOnly won ${wins}/${reps} reps · rendered-report equality: ${mismatch === 0 ? "GREEN" : `RED (${mismatch}/${reps})`}`);
