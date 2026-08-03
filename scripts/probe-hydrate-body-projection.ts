#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does `hydrateCardBodies` pay for the 22 fields it
 * discards, and how many live cards does the wide projection lose entirely?
 *
 * `hydrateCardBodies` calls `findCard`, which projects `fieldsFor("card")` — 23
 * fields — and then reads exactly one of them (`full.body`). Two costs:
 *
 *   1. bytes/time for 22 fields that go straight in the bin;
 *   2. a FALSE ABSENCE, because LastDB returns a row only when EVERY projected
 *      field has an atom on it (see `cardExists`). A card missing one field
 *      hydrates to `null`, keeps BODY_OMITTED, and is then classified from a
 *      body nobody fetched — `malformed-routing` on a card that is fine.
 *
 * Cost arm is interleaved (wide, narrow, wide-control per rep) because a
 * before/after delta around a single read is not a measurement on this node.
 *
 * Run: bun scripts/probe-hydrate-body-projection.ts [slugCount]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards, findCard, cardExists } from "../src/record.ts";
import { fieldsFor } from "../src/schemas.ts";
import { schemaHashFor } from "../src/config.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const N = Number(process.argv[2] ?? "12");
const BODY_ONLY = ["slug", "body"];

// `findCardWithFields` is module-private, so the probe issues the same read it
// would: one HashKey point query at the given projection.
async function findCardWithFields(
  slug: string,
  fields: string[],
): Promise<{ slug: string; body: string } | null> {
  const res = await node.queryAll({
    schemaHash: schemaHashFor("card", cfg),
    fields,
    filter: { HashKey: slug } as never,
  });
  const row = res.results
    .map((r) => (r.fields ?? {}) as Record<string, unknown>)
    .find((f) => String(f.slug ?? "") === slug);
  return row ? { slug, body: String(row.body ?? "") } : null;
}

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards, activeOnly: true });
const slugs = cards.map((c) => c.slug).filter((s) => s.length > 0).slice(0, N);
console.log(`probing ${slugs.length} active card slugs\n`);

// --- Arm 1: does the wide projection lose rows the narrow one returns? ---
console.log("=== false absence: wide 23-field read vs narrow, vs `slug`-only existence ===");
let wideMiss = 0;
let narrowMiss = 0;
let existsButWideMisses = 0;
for (const slug of slugs) {
  const [wide, narrow, exists] = await Promise.all([
    findCard(node, cfg, slug),
    findCardWithFields(slug, BODY_ONLY),
    cardExists(node, cfg, slug),
  ]);
  if (wide === null) wideMiss++;
  if (narrow === null) narrowMiss++;
  if (exists && wide === null) {
    existsButWideMisses++;
    console.log(`  ! ${slug} — exists, but the 23-field read returns NOTHING${narrow !== null ? " (narrow read got it)" : ""}`);
  }
}
console.log(`  wide (${fieldsFor("card").length} fields) misses   ${wideMiss}/${slugs.length}`);
console.log(`  narrow (2 fields) misses    ${narrowMiss}/${slugs.length}`);
console.log(`  exists but wide read missed ${existsButWideMisses}/${slugs.length}`);

// --- Arm 2: cost, interleaved ---
console.log("\n=== cost per point-read, interleaved (wide / narrow / wide-control) ===");
const median = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
const wideMs: number[] = [];
const narrowMs: number[] = [];
const controlMs: number[] = [];

for (const slug of slugs) {
  let t = performance.now();
  await findCard(node, cfg, slug);
  wideMs.push(performance.now() - t);

  t = performance.now();
  await findCardWithFields(slug, BODY_ONLY);
  narrowMs.push(performance.now() - t);

  t = performance.now();
  await findCard(node, cfg, slug);
  controlMs.push(performance.now() - t);
}

const w = median(wideMs);
const n = median(narrowMs);
console.log(`  wide    (${fieldsFor("card").length} fields)  median ${w.toFixed(0)}ms   total ${wideMs.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
console.log(`  control (wide again)  median ${median(controlMs).toFixed(0)}ms`);
console.log(`  narrow  (2 fields)    median ${n.toFixed(0)}ms   total ${narrowMs.reduce((a, b) => a + b, 0).toFixed(0)}ms`);
console.log(`  -> ${(w / n).toFixed(2)}x`);
