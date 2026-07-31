#!/usr/bin/env bun
/**
 * READ-ONLY: does the body-REWRITING sweep path resolve any card to an empty or
 * short body while a longer one is stored?
 *
 * Standing check on the ghost-row class. A `Card` scan on the live primary can
 * return TWO rows for one slug — the real brief under the node's derived key and
 * an empty row under the bare slug — while `HashKey(slug)` returns only the real
 * one. Presence in a scan is therefore not coverage, and the sweeps that judge
 * and rewrite bodies (`groom stale-blockers`, `rank`, `migrate area-tags`) are
 * the ones that pay for the confusion.
 *
 * Expected output is all zeros. Before the 2026-07-31 fix this reported 47
 * duplicated slugs and 33 board cards resolved to `""` whose real briefs (513–4389
 * chars) were one keyed read away. A non-zero line means the guard has regressed
 * OR the node has started producing a shape the guard does not cover — either way,
 * do not run a `--apply` sweep until it reads zero again.
 *
 * Run: bun scripts/probe-sweep-body-truth.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCardsWithBodies, listCardBodies, listCards, findCard } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: cfg.nodeSocketPath });

const scanned = await listCardsWithBodies(node, cfg);
console.log(`listCardsWithBodies (wide scan) rows: ${scanned.length}`);
const bySlug = new Map<string, number[]>();
for (const c of scanned) {
  const l = bySlug.get(c.slug) ?? [];
  l.push((c.body ?? "").length);
  bySlug.set(c.slug, l);
}
const dupes = [...bySlug.entries()].filter(([, b]) => b.length > 1);
console.log(`distinct slugs: ${bySlug.size}   slugs with >1 row in the WIDE scan: ${dupes.length}`);
for (const [s, b] of dupes.slice(0, 10)) console.log(`   ${s}: [${b.join(", ")}]`);

// The exact Map construction used by listBoardCardsWithBodies (last-write-wins).
const lastWins = new Map(scanned.map((c) => [c.slug, c.body]));
// The defended version used by listCardBodies (keep-longest).
const keepLongest = await listCardBodies(node, cfg);

const board = await listCards(node, cfg);
console.log(`\nboard cards: ${board.length}`);
let emptyFromSweep = 0, shorterThanKeepLongest = 0;
const victims: string[] = [];
for (const c of board) {
  const sweep = lastWins.get(c.slug);
  if (sweep === undefined) continue;
  const best = keepLongest.get(c.slug) ?? "";
  if (sweep.length === 0 && best.length > 0) { emptyFromSweep++; victims.push(c.slug); }
  else if (sweep.length < best.length) { shorterThanKeepLongest++; victims.push(c.slug); }
}
console.log(`\nboard cards the SWEEP path resolves to EMPTY but a real body exists : ${emptyFromSweep}`);
console.log(`board cards the SWEEP path resolves SHORTER than the best row      : ${shorterThanKeepLongest}`);
for (const v of victims.slice(0, 10)) {
  const real = await findCard(node, cfg, v);
  console.log(`   ${v}: sweep=${(lastWins.get(v) ?? "").length}  keepLongest=${(keepLongest.get(v) ?? "").length}  POINT READ (truth)=${(real?.body ?? "").length}`);
}
