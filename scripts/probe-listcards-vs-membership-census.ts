#!/usr/bin/env bun
/**
 * READ-ONLY probe: `kanban doctor` prints two card totals from two different
 * enumerations and never compares them.
 *
 *   ✓ query round-trip — 107 cards, 2 boards
 *   ✓ BoardCards projection parity (default) — 108 rows, every lead agrees
 *
 * Both are green. They disagree. This probe says which rows account for the
 * gap and whether each one is a duplicate sk for a live slug (a stale
 * membership ghost), a row for a slug with no Card, or a row the product list
 * projection drops.
 *
 * Run: bun scripts/probe-listcards-vs-membership-census.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { cardExists, listBoards, listCards } from "../src/record.ts";
import { listBoardCardsPartition, sweepBoardCardsPartition } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const listed = await listCards(node, cfg, { boards });
const listedSlugs = new Set(listed.map((c) => c.slug));
console.log(`listCards (product list path): ${listed.length} cards, ${listedSlugs.size} distinct slugs`);

let sweepTotal = 0;
let wideTotal = 0;
const skBySlug = new Map<string, string[]>();
const wideSlugCount = new Map<string, number>();

for (const b of boards) {
  const sweep = await sweepBoardCardsPartition(node, cfg, b.slug);
  if (!sweep) continue;
  if (sweep.failedLeads.length > 0) {
    console.log(`  [${b.slug}] failed leads: ${sweep.failedLeads.map((f) => f.field).join(", ")}`);
  }
  sweepTotal += sweep.rows.length;
  for (const r of sweep.rows) {
    const slug = r.slug ?? "(no slug atom)";
    const arr = skBySlug.get(slug) ?? [];
    arr.push(r.sk);
    skBySlug.set(slug, arr);
  }
  const wide = await listBoardCardsPartition(node, cfg, b.slug);
  if (wide) {
    wideTotal += wide.length;
    for (const c of wide) wideSlugCount.set(c.slug, (wideSlugCount.get(c.slug) ?? 0) + 1);
  }
  console.log(`  [${b.slug}] sweep rows=${sweep.rows.length} wide rows=${wide?.length ?? "null"}`);
}

console.log(`\nsweep (union over leads): ${sweepTotal} rows, ${skBySlug.size} distinct slugs`);
console.log(`wide  (BOARD_CARDS_FIELDS): ${wideTotal} rows, ${wideSlugCount.size} distinct slugs`);

const dupes = [...skBySlug.entries()].filter(([, sks]) => sks.length > 1);
console.log(`\nslugs with >1 membership row: ${dupes.length}`);
for (const [slug, sks] of dupes) {
  const exists = await cardExists(node, cfg, slug);
  console.log(`  ${slug} — cardExists=${exists} sks=${sks.join(" | ")}`);
}

const inSweepNotListed = [...skBySlug.keys()].filter((s) => !listedSlugs.has(s));
console.log(`\nslugs in membership but NOT in listCards: ${inSweepNotListed.length}`);
for (const slug of inSweepNotListed) {
  const exists = await cardExists(node, cfg, slug);
  console.log(`  ${slug} — cardExists=${exists} sks=${(skBySlug.get(slug) ?? []).join(" | ")}`);
}

const listedNotInSweep = [...listedSlugs].filter((s) => !skBySlug.has(s));
console.log(`\nslugs in listCards but NOT in membership sweep: ${listedNotInSweep.length}`);
for (const slug of listedNotInSweep) console.log(`  ${slug}`);
