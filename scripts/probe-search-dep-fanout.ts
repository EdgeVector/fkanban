#!/usr/bin/env bun
/**
 * READ-ONLY probe: how many Card point-reads does one `kanban search` spend on
 * dependency status, and how many of them can any answer it prints depend on?
 *
 * `indexedSearchCards` resolves dep status across the WHOLE scoped board
 * (`listDependencyStatusesForCards(node, cfg, scopedDisplay)`), but the only
 * consumer of that result is `blockedSlugSet(matches, allCards, …)` — which
 * calls `depStatus` for the MATCHES alone. Every point read spent on a dep of a
 * non-matching card is fetched, mapped, and dropped.
 *
 * Prints, per query: board-wide off-set deps (what search reads today) vs
 * match-scoped off-set deps (what its output can actually observe).
 *
 * Run: bun scripts/probe-search-dep-fanout.ts [query ...]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  CARD_DISPLAY_FIELDS,
  cardMatchesQuery,
  listCardBodies,
  listCardsByFilter,
  withLoadedBody,
  type Card,
} from "../src/record.ts";

const queries = process.argv.slice(2);
const QUERIES = queries.length > 0 ? queries : ["lastdb", "kanban", "milestone", "ci", "zzz-no-such-term"];

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

// Exactly the two reads `indexedSearchCards` issues before it resolves deps.
const [displayRead, bodies] = await Promise.all([
  listCardsByFilter(node, cfg, {}, CARD_DISPLAY_FIELDS, { allowFullScanFallback: false }),
  listCardBodies(node, cfg).catch(() => null),
]);
const scopedDisplay = displayRead.cards;
const inSet = new Set(scopedDisplay.map((c) => c.slug));

// The board-wide fan-out is query-independent: it is every dep edge on the
// board that points off the read set, which is what search pays on EVERY call.
const boardWide = new Set(
  scopedDisplay.flatMap((c) => c.deps ?? []).filter((s) => s.length > 0 && !inSet.has(s)),
);

console.log(`scoped display cards: ${scopedDisplay.length}`);
console.log(`bodies from scan:     ${bodies?.size ?? "(scan refused)"}`);
console.log(`board-wide off-set dep point-reads (paid on every search): ${boardWide.size}\n`);

const matchesFor = (query: string): Card[] => {
  const out: Card[] = [];
  for (const card of scopedDisplay) {
    const body = bodies?.get(card.slug);
    const whole = body === undefined || body.length === 0 ? card : withLoadedBody(card, body);
    if (cardMatchesQuery(whole, query)) out.push(whole);
  }
  return out;
};

console.log("query                    matches   match-scoped off-set deps   wasted point-reads");
for (const q of QUERIES) {
  const matches = matchesFor(q);
  const scoped = new Set(
    matches.flatMap((c) => c.deps ?? []).filter((s) => s.length > 0 && !inSet.has(s)),
  );
  const wasted = boardWide.size - scoped.size;
  console.log(
    `${q.padEnd(24)} ${String(matches.length).padStart(7)}   ${String(scoped.size).padStart(25)}   ${String(wasted).padStart(18)}`,
  );
}
