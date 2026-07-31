#!/usr/bin/env bun
/**
 * READ-ONLY probe: can anything DISCOVER a card that has lost its BoardCards row?
 *
 * `groom board-cards-heal` is the stated mitigation for membership drift, and
 * its repair authority is Card truth. But its CANDIDATE set is the union of
 * (a) the BoardCards partitions themselves and (b) `indexedBySlug`. A card that
 * lost its membership row is absent from (a) by definition, so (b) is the only
 * thing between "one write failed mid-move" and "the card is off the board
 * until a human notices".
 *
 * (b) has two silent failure modes worth measuring rather than assuming:
 *   - `scanCardSummariesForReconcile` sits behind a bare `catch {}`.
 *   - it projects wide, and LastDB drops a row when ANY projected field has no
 *     atom — so a sparse Card is invisible to the scan, not an error.
 *
 * A slug missing from BoardCards is also ambiguous on its own: `findCard`,
 * `kanban show` and heal's `findCardSummaryForReconcile` all read wide, so
 * "no card" from any of them can mean "sparse" rather than "gone". `cardExists`
 * projects the hash key alone and cannot false-negative — heal already trusts
 * it for exactly this distinction before it deletes membership — so the probe
 * uses it to split the population three ways.
 *
 * Measured on the live primary 2026-07-31: 364 membership slugs, 429
 * reverse-discoverable, 65 discoverable-but-unmembered — and all 65 came back
 * `cardExists=false`, i.e. archived-card ghosts still surfacing in the Card
 * full scan, not live cards stranded off the board. Heal skips them correctly
 * (no rows + no card ⇒ nothing to do). The reverse discovery is healthy; the
 * cost is 65 wasted point-reads per heal run.
 *
 * Run: bun scripts/probe-membership-discovery.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  cardExists,
  findCardSummaryForReconcile,
  listBoards,
  scanCardSummariesForReconcile,
} from "../src/record.ts";
import { listBoardCardsPartition } from "../src/board-cards.ts";
import { readCardListIndex, cardListIndexIsSuperseded } from "../src/card-list-index.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

console.log(`card_list_index superseded: ${cardListIndexIsSuperseded(cfg)}`);

const boards = await listBoards(node, cfg);
const membership = new Set<string>();
for (const b of boards) {
  const part = await listBoardCardsPartition(node, cfg, b.slug);
  for (const c of part ?? []) membership.add(c.slug);
}

let scanned: string[] = [];
let scanError = "";
const t0 = performance.now();
try {
  scanned = (await scanCardSummariesForReconcile(node, cfg)).map((c) => c.slug);
} catch (err) {
  scanError = String(err);
}
const scanMs = Math.round(performance.now() - t0);

const rollup = ((await readCardListIndex(node, cfg)) ?? []).map((c) => c.slug);
const discoverable = new Set([...scanned, ...rollup]);

console.log(`boards:                 ${boards.length}`);
console.log(`BoardCards membership:  ${membership.size} slugs`);
console.log(
  `Card full-scan:         ${scanned.length} rows / ${new Set(scanned).size} slugs ` +
    `(${scanMs}ms)${scanError ? ` ERROR ${scanError}` : ""}`,
);
console.log(`all_cards rollup:       ${rollup.length} slugs`);
console.log(`reverse-discoverable:   ${discoverable.size} slugs`);

const invisible = [...membership].filter((s) => !discoverable.has(s));
const lostMembership = [...discoverable].filter((s) => !membership.has(s));
console.log(`\non board but NOT reverse-discoverable: ${invisible.length}`);
for (const s of invisible.slice(0, 15)) console.log(`  ${s}`);

// Split the unmembered slugs into gone / repairable / silently-skipped.
const verdicts = await mapWithConcurrency(lostMembership, async (slug) => ({
  slug,
  exists: await cardExists(node, cfg, slug),
  reconcilable: Boolean(await findCardSummaryForReconcile(node, cfg, slug)),
}));
const genuinelyGone = verdicts.filter((v) => !v.exists);
const healthyLive = verdicts.filter((v) => v.exists && v.reconcilable);
const sparseLive = verdicts.filter((v) => v.exists && !v.reconcilable);

console.log(`\ndiscoverable but MISSING from BoardCards: ${lostMembership.length}`);
console.log(`  genuinely gone (cardExists=false):      ${genuinelyGone.length}`);
console.log(`  live AND reconcilable (heal would fix): ${healthyLive.length}`);
console.log(`  live but SPARSE (heal silently skips):  ${sparseLive.length}`);
for (const v of sparseLive.slice(0, 20)) console.log(`    ${v.slug}`);
