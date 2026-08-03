#!/usr/bin/env bun
/**
 * READ-ONLY probe: what fan-out width should `POINT_READ_CONCURRENCY` be?
 *
 * Six governs every point-read fan-out in the product (`mapWithConcurrency`'s
 * default), and it is the one hot constant in this codebase set by assertion
 * rather than measurement. Its own comment retired the number that used to
 * justify it ("~2s per point read" -> re-measured 21-34ms, "two orders of
 * magnitude off") and then kept the width anyway, on a second claim that has
 * never been measured either: that a wider fan-out crosses LastDB Mini's
 * "too many concurrent reads" shed threshold.
 *
 * That claim is testable, and it decides real latency. `pickup status` point-
 * reads ~18 cards; at width 6 per pool that is 3 serial waves, and this repo's
 * own governing finding is that **the unit of cost is the serial wave** (~190ms
 * of per-request latency the client does not control, ~1.9ms of node work).
 *
 * So: sweep the width, measure wall time and shed rate, and let the number come
 * from the node rather than from a comment.
 *
 * Method notes that matter for trusting the answer:
 *  - Widths are run INTERLEAVED across repetitions, not blocked, so a busy
 *    minute on this shared node cannot be mistaken for a slow width.
 *  - The SAME slug set is used at every width, so per-card variance cancels.
 *  - Shed (503 / "too many concurrent reads") is counted explicitly, because a
 *    width that is fast but sheds is not a usable width.
 *  - Reads only. Nothing is written, and the total volume is a few hundred
 *    point reads of ~1.9ms node work each.
 *
 * Run: bun scripts/probe-point-read-concurrency-width.ts [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { listBoardCardsPartitionSpine } from "../src/board-cards.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";
import { CARD_DISPLAY_FIELDS } from "../src/record.ts";

const cfg = readConfig();
const node: NodeClient = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.argv[2] ?? "default";
const WIDTHS = [1, 2, 4, 6, 8, 12, 16, 24];
const SAMPLE = 18; // what `pickup status` actually fans out over
const REPS = 3;

const cardHash = cfg.schemaHashes?.card;
if (!cardHash) {
  console.log("card schema unbound — nothing to measure.");
  process.exit(0);
}

const spine = (await listBoardCardsPartitionSpine(node, cfg, BOARD)) ?? [];
const slugs = spine.map((r) => r.slug).filter((s) => s.length > 0).slice(0, SAMPLE);
if (slugs.length < 2) {
  console.log(`board "${BOARD}" has too few cards to measure (${slugs.length}).`);
  process.exit(0);
}

const isShed = (err: unknown): boolean => {
  const m = err instanceof Error ? err.message : String(err);
  return /too many concurrent|503|service_timeout|busy/i.test(m);
};

async function pointRead(slug: string): Promise<boolean> {
  try {
    await node.queryAll({
      schemaHash: cardHash!,
      fields: [...CARD_DISPLAY_FIELDS],
      filter: { HashKey: slug } as never,
    });
    return true;
  } catch (err) {
    if (isShed(err)) return false;
    throw err;
  }
}

type Sample = { ms: number; shed: number };
const samples = new Map<number, Sample[]>(WIDTHS.map((w) => [w, []]));

for (let rep = 0; rep < REPS; rep++) {
  for (const width of WIDTHS) {
    const t0 = performance.now();
    const ok = await mapWithConcurrency(slugs, (s) => pointRead(s), width);
    const ms = performance.now() - t0;
    samples.get(width)!.push({ ms, shed: ok.filter((v) => v === false).length });
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

console.log(
  `Card point-read fan-out — ${slugs.length} slugs from board "${BOARD}", ` +
    `${REPS} interleaved reps\n`,
);
console.log(`  width   median ms   waves   ms/wave   shed`);
const rows = WIDTHS.map((w) => {
  const s = samples.get(w)!;
  const ms = median(s.map((x) => x.ms));
  const waves = Math.ceil(slugs.length / w);
  const shed = s.reduce((a, x) => a + x.shed, 0);
  return { w, ms, waves, shed };
});
for (const r of rows) {
  console.log(
    `  ${String(r.w).padStart(5)}   ${String(Math.round(r.ms)).padStart(9)}   ` +
      `${String(r.waves).padStart(5)}   ${String(Math.round(r.ms / r.waves)).padStart(7)}   ` +
      `${String(r.shed).padStart(4)}`,
  );
}

const at6 = rows.find((r) => r.w === 6)!;
const best = rows.filter((r) => r.shed === 0).reduce((a, b) => (b.ms < a.ms ? b : a));
console.log(
  `\n  width 6 (current default): ${Math.round(at6.ms)}ms, ${at6.shed} shed\n` +
    `  fastest shed-free width:   ${best.w} -> ${Math.round(best.ms)}ms ` +
    `(${Math.round(at6.ms - best.ms)}ms faster, ${(at6.ms / best.ms).toFixed(2)}x)`,
);
const totalShed = rows.reduce((a, r) => a + r.shed, 0);
console.log(
  totalShed === 0
    ? `\n  The node shed 0 reads at every width up to ${WIDTHS[WIDTHS.length - 1]}.`
    : `\n  Shedding observed — the load-guard claim reproduces at some width.`,
);
console.log("\nRead-only. Nothing was written.");
