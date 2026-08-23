#!/usr/bin/env bun
/**
 * READ-ONLY probe: does `search`'s display enumeration cover every card the
 * Card key list covers?
 *
 * `indexedSearchCards` matches ONLY over `listCardsByFilter(...)` — the
 * BoardCards display index. It reads `listCardBodies` (the Card KEY LIST, the
 * source of truth) purely to attach bodies to cards that read already found.
 * A slug the key list covers and the display index does not is therefore
 * unreachable by `search` at any query, while `show` point-gets it fine.
 *
 * That is the 2026-08-21 dogfood finding: `show` read
 * `kstress-1787297879-3095-s1`, `search kdogtok1787297933` missed it.
 *
 * The native fallback cannot rescue it: it fires only when `bodies === null`
 * OR `scopedDisplay.length === 0` — a wholly degraded read. One missing row in
 * an otherwise healthy read never trips it.
 *
 * Measure three things:
 *   A. GAP     — slugs the key list covers that the display read did not.
 *   B. TRUTH   — of those, how many are real placed board cards (board+column)
 *                that search SHOULD reach, vs off-board Card records that
 *                `--complete` mode owns.
 *   C. COST    — what a recovery pass costs: point reads, bounded by the
 *                number of gap slugs whose slug+body already match the query.
 *
 * NO CATCH AROUND THE READS. A probe that cannot read must stop.
 *
 * Run: bun scripts/probe-search-enumeration-gap.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { CARD_DISPLAY_FIELDS, findCard, listCardBodies, listCardsByFilter } from "../src/record.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const t0 = performance.now();
const [displayRead, bodies] = await Promise.all([
  listCardsByFilter(node, cfg, {}, CARD_DISPLAY_FIELDS, { allowKeyListFallback: false }),
  listCardBodies(node, cfg),
]);
const readMs = Math.round(performance.now() - t0);

const enumerated = new Set(displayRead.cards.map((c) => c.slug));
console.log(`display read (BoardCards): ${displayRead.cards.length} cards`);
console.log(`key list (Card truth)    : ${bodies.size} slugs`);
console.log(`both reads               : ${readMs}ms (concurrent)\n`);

// A. GAP
const gap = [...bodies.keys()].filter((slug) => !enumerated.has(slug));
console.log(`A. key list \\ display    : ${gap.length} slugs`);
if (gap.length === 0) {
  console.log("\nno gap on this board right now — the defect is latent, not absent.");
  process.exit(0);
}

// B. TRUTH — point-read each gap slug. A placed card (board + column) is one
// `search` should have reached.
const t1 = performance.now();
const truth = await mapWithConcurrency(gap, (slug) => findCard(node, cfg, slug));
const keyedMs = Math.round(performance.now() - t1);

const placed: Array<{ slug: string; board: string; column: string; len: number }> = [];
let offBoard = 0;
let missing = 0;
for (let i = 0; i < gap.length; i++) {
  const slug = gap[i]!;
  const card = truth[i];
  if (!card) { missing++; continue; }
  if (card.board && card.column) {
    placed.push({ slug, board: card.board, column: card.column, len: card.body.length });
  } else {
    offBoard++;
  }
}
console.log(`B. placed board cards    : ${placed.length}  <- search cannot reach these`);
console.log(`   off-board Card records: ${offBoard}  (--complete owns these)`);
console.log(`   slug gone under point : ${missing}`);
console.log(`   keyed reads           : ${gap.length} in ${keyedMs}ms\n`);

for (const p of placed.slice(0, 20)) {
  console.log(`   ${p.board}/${p.column}  ${p.slug}  body=${p.len}`);
}
if (placed.length > 20) console.log(`   … ${placed.length - 20} more`);

// C. COST — a recovery pass point-reads only gap slugs whose slug+body already
// match the query, so the realistic bound is far below `gap.length`.
const sampleQueries = ["lastdb", "kanban", "milestone", "zzz-no-such-token"];
console.log("\nC. recovery point reads by query (gap slugs matching on slug+body):");
for (const q of sampleQueries) {
  const terms = q.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  const n = gap.filter((slug) => {
    const hay = `${slug}\n${bodies.get(slug) ?? ""}`.toLowerCase();
    return terms.every((t) => hay.includes(t));
  }).length;
  console.log(`   ${q.padEnd(20)} ${n}`);
}
