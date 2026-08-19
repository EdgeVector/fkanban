#!/usr/bin/env bun
/**
 * READ-ONLY probe: when the Card scan hands `search` an EMPTY body, is the card
 * actually empty?
 *
 * Run (n) established the rule — *a scan may SUPPLY a body, it may never DENY
 * one; only a keyed read may establish that a body is empty* — and applied it to
 * `listBoardCardsWithBodies`, which now keeps `BODY_OMITTED` on an empty scan
 * body and lets `hydrateCardBodies` point-read it.
 *
 * `indexedSearchCards` consumes the SAME scan (`listCardBodies`) to answer the
 * SAME question and does the opposite: `withLoadedBody(card, "")` clears the
 * marker, and the card is then substring-matched against a body of `""`. That is
 * the laundering step run (n) named, still live on the search path.
 *
 * Whether that costs recall depends on a fact neither of us had measured: how
 * often the scan's empty body is a LIE. So measure it, three questions at once:
 *
 *   A. EXPOSURE  — board cards for which the scan supplies `body === ""`.
 *   B. TRUTH     — of those, how many carry a NON-empty body under a keyed read.
 *                  Every one is a card whose brief `search` cannot match.
 *   C. COST      — what honouring the rule would cost: the keyed reads, and how
 *                  many of them are needed only because the card does not
 *                  already match on slug/title/tags.
 *
 * B == 0 means the defect is real in code and latent on this board, and the
 * checkpoint must say so rather than claim damage it did not find.
 *
 * NO CATCH AROUND THE READS. A probe that cannot read must stop, not score the
 * failure as a finding (run (b) reported 156/156 orphans that way).
 *
 * Run: bun scripts/probe-search-empty-body-denial.ts
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

// Exactly what `indexedSearchCards` reads on an unscoped search.
const t0 = performance.now();
const [displayRead, bodies] = await Promise.all([
  listCardsByFilter(node, cfg, {}, CARD_DISPLAY_FIELDS, { allowKeyListFallback: false }),
  listCardBodies(node, cfg),
]);
const readMs = Math.round(performance.now() - t0);

const cards = displayRead.cards;
console.log(`board cards (display read): ${cards.length}`);
console.log(`scan body map            : ${bodies.size} slugs`);
console.log(`both reads               : ${readMs}ms (concurrent)\n`);

// A. EXPOSURE — the scan answered, and its answer was "empty".
const suppliedEmpty = cards.filter((c) => bodies.get(c.slug) === "");
// The neighbouring fact: cards the scan did not cover at all. Search leaves
// these as-is (`body === undefined ? card : ...`), so they keep whatever the
// display read gave them — a different path, worth printing rather than
// conflating with the empty-supply case.
const notCovered = cards.filter((c) => bodies.get(c.slug) === undefined);
console.log(`A. scan supplied body="" : ${suppliedEmpty.length}`);
console.log(`   scan did not cover    : ${notCovered.length}`);

if (suppliedEmpty.length === 0) {
  console.log("\nnothing to check — the scan denies no bodies on this board.");
  process.exit(0);
}

// B. TRUTH — the keyed read is authoritative (see `listCardsWithBodies`).
const t1 = performance.now();
const truth = await mapWithConcurrency(suppliedEmpty, (c) => findCard(node, cfg, c.slug));
const keyedMs = Math.round(performance.now() - t1);

const lying: Array<{ slug: string; len: number; column: string }> = [];
let genuinelyEmpty = 0;
let unresolved = 0;
for (let i = 0; i < suppliedEmpty.length; i++) {
  const card = truth[i];
  if (!card) {
    unresolved++;
    continue;
  }
  const len = card.body.length;
  if (len > 0) lying.push({ slug: suppliedEmpty[i]!.slug, len, column: suppliedEmpty[i]!.column });
  else genuinelyEmpty++;
}

console.log(`\nB. keyed read over those ${suppliedEmpty.length}: ${keyedMs}ms (concurrent)`);
console.log(`   genuinely empty       : ${genuinelyEmpty}`);
console.log(`   keyed read found none : ${unresolved}`);
console.log(`   SCAN WAS LYING        : ${lying.length}  <-- cards whose brief search cannot match`);
for (const l of lying.slice(0, 20)) {
  console.log(`     ${l.slug}  body=${l.len}  column=${l.column}`);
}
if (lying.length > 20) console.log(`     … and ${lying.length - 20} more`);

// C. COST — what the fix would pay on every search. A card that already matches
// on slug/title/tags needs no body, so the honest cost is the rest.
console.log(`\nC. cost of honouring the rule on this board`);
console.log(`   keyed reads if all empties are re-read : ${suppliedEmpty.length} (${keyedMs}ms concurrent, measured above)`);
console.log(`   as a share of the current search reads : ${readMs}ms scan+display -> +${keyedMs}ms`);
