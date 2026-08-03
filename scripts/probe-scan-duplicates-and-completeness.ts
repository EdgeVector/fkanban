#!/usr/bin/env bun
/**
 * READ-ONLY probe: is the paged Card scan COMPLETE, and does it DUPLICATE?
 *
 * `scripts/probe-body-scan-page-shortfall.ts` established that the page
 * shortfall is not about the projection — `["slug"]` and `["slug","body"]`
 * yield byte-identical row counts at every limit — so the node's paging itself
 * is what forces 18 round trips. It also turned up the fact that matters more
 * than the latency:
 *
 *     total_count = 1502, but the client's drain returns 1539 rows.
 *
 * A drain returning MORE rows than the scan claims to hold means the advance
 * rule and the node's `offset` do not agree. `queryAllPaged` advances with
 * `offset = rows.length` — the count of rows RETURNED so far. If the node's
 * offset counts something else (positions examined), then every page re-reads
 * a window it already covered (wasteful but safe), or skips one (silent data
 * loss). 1539 > 1502 points at re-reading; that is a guess until measured.
 *
 * The two questions a board's correctness actually rests on:
 *
 *   D. How many of those 1539 rows are DUPLICATES?
 *   C. Is the scan COMPLETE — does it contain every live board card? A body
 *      scan that silently drops cards makes `kanban search` miss them, and a
 *      search that quietly cannot find a card is worse than a slow one.
 *
 * Completeness is checked against an independent read (the BoardCards
 * membership index), not against the scan itself.
 *
 * Run: bun scripts/probe-scan-duplicates-and-completeness.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCardBodies, listCardsByFilter, findCard } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

// --- D: duplicates, counted at the transport so the client's own de-dup
// (listCardBodies builds a Map) cannot hide them. -------------------------
let rawRows = 0;
const realFetch = globalThis.fetch;
const seenPerPage: number[] = [];
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const res = await realFetch(input as Parameters<typeof realFetch>[0], init);
  try {
    const j = (await res.clone().json()) as { results?: unknown[] };
    if (Array.isArray(j.results)) {
      rawRows += j.results.length;
      seenPerPage.push(j.results.length);
    }
  } catch { /* not JSON */ }
  return res;
}) as typeof fetch;

const t0 = performance.now();
const bodies = await listCardBodies(node, cfg);
const scanMs = performance.now() - t0;

console.log("=== D: duplicates in the paged body scan ===");
console.log(`  rows delivered by node across pages : ${rawRows}`);
console.log(`  distinct slugs after client de-dup  : ${bodies.size}`);
console.log(`  duplicate rows                      : ${rawRows - bodies.size}`);
console.log(`  pages                               : ${seenPerPage.length}  (${seenPerPage.join(",")})`);
console.log(`  wall                                : ${scanMs.toFixed(0)}ms`);

// --- C: completeness against an independent membership read ---------------
globalThis.fetch = realFetch;
const live = await listCardsByFilter(node, cfg, {}, ["slug", "board", "column"], {
  allowFullScanFallback: false,
});
const liveSlugs = live.cards.map((c) => c.slug);
const missing = liveSlugs.filter((s) => !bodies.has(s));

console.log("\n=== C: completeness vs the membership index ===");
console.log(`  live cards (membership read) : ${liveSlugs.length}`);
console.log(`  of those, present in scan    : ${liveSlugs.length - missing.length}`);
console.log(`  MISSING from the body scan   : ${missing.length}`);
if (missing.length) {
  console.log(`  missing slugs (first 15):`);
  for (const s of missing.slice(0, 15)) console.log(`    - ${s}`);
}

// A card missing from the body scan is only a search bug if it HAS a body.
if (missing.length) {
  console.log("\n  do the missing cards actually have bodies? (point reads)");

  let withBody = 0;
  for (const s of missing.slice(0, 10)) {
    const c = await findCard(node, cfg, s);
    const len = c?.body?.length ?? 0;
    if (len > 0) withBody++;
    console.log(`    ${s.slice(0, 52).padEnd(52)} body=${len}B`);
  }
  console.log(`  -> ${withBody}/${Math.min(missing.length, 10)} sampled missing cards HAVE a body`);
}
