#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does search's whole-board dep resolution actually cost,
 * against the match-scoped resolution its OUTPUT could depend on?
 *
 * `indexedSearchCards` calls
 * `listDependencyStatusesForCards(node, cfg, scopedDisplay)` — every dep edge
 * on the board that points off the read set. The single consumer of that result
 * is `blockedSlugSet(matches, allCards, …)`, which calls `depStatus` for the
 * MATCHES only. Deps of non-matching cards are fetched, mapped, and dropped.
 *
 * Interleaved so node load hits both arms equally.
 *
 * Run: bun scripts/probe-search-dep-scope-cost.ts [reps] [query ...]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  CARD_DISPLAY_FIELDS,
  cardMatchesQuery,
  listCardBodies,
  listCardsByFilter,
  listDependencyStatusesForCards,
  withLoadedBody,
  type Card,
} from "../src/record.ts";

const [repsArg, ...queryArgs] = process.argv.slice(2);
const REPS = Number(repsArg ?? "7") || 7;
const QUERIES = queryArgs.length > 0 ? queryArgs : ["lastdb", "milestone", "zzz-no-such-term"];

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const [displayRead, bodies] = await Promise.all([
  listCardsByFilter(node, cfg, {}, CARD_DISPLAY_FIELDS, { allowKeyListFallback: false }),
  listCardBodies(node, cfg).catch(() => null),
]);
const scopedDisplay = displayRead.cards;

const matchesFor = (query: string): Card[] => {
  const out: Card[] = [];
  for (const card of scopedDisplay) {
    const body = bodies?.get(card.slug);
    const whole = body === undefined || body.length === 0 ? card : withLoadedBody(card, body);
    if (cardMatchesQuery(whole, query)) out.push(whole);
  }
  return out;
};

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)]!;
};

console.log(`scoped display cards: ${scopedDisplay.length}, reps: ${REPS}\n`);
console.log("query                    matches   board-wide   match-scoped   delta");

for (const q of QUERIES) {
  const matches = matchesFor(q);
  const wide: number[] = [];
  const scoped: number[] = [];
  for (let r = 0; r < REPS; r++) {
    // Interleaved, alternating which arm goes first so neither arm always
    // benefits from the other having just warmed the same rows.
    const wideFirst = r % 2 === 0;
    const runWide = async () => {
      const t = performance.now();
      await listDependencyStatusesForCards(node, cfg, scopedDisplay);
      wide.push(performance.now() - t);
    };
    const runScoped = async () => {
      const t = performance.now();
      await listDependencyStatusesForCards(node, cfg, matches, scopedDisplay);
      scoped.push(performance.now() - t);
    };
    if (wideFirst) {
      await runWide();
      await runScoped();
    } else {
      await runScoped();
      await runWide();
    }
  }
  const w = median(wide);
  const s = median(scoped);
  console.log(
    `${q.padEnd(24)} ${String(matches.length).padStart(7)}   ${`${w.toFixed(0)}ms`.padStart(10)}   ${`${s.toFixed(0)}ms`.padStart(12)}   ${(s - w).toFixed(0)}ms`,
  );
}

// Equality of the ANSWER, not just the cost: the only consumer is
// blockedSlugSet(matches, allCards), so the two scopes must agree on every
// match's blocked verdict.
const { blockedSlugSet, boardTerminalMap, listBoards } = await import("../src/record.ts");
const boardTerminal = boardTerminalMap(await listBoards(node, cfg));
console.log("\nverdict equality (blockedSlugSet over matches):");
for (const q of QUERIES) {
  const matches = matchesFor(q);
  const wideAll = await listDependencyStatusesForCards(node, cfg, scopedDisplay);
  const scopedAll = await listDependencyStatusesForCards(node, cfg, matches, scopedDisplay);
  const a = [...blockedSlugSet(matches, wideAll, boardTerminal)].sort();
  const b = [...blockedSlugSet(matches, scopedAll, boardTerminal)].sort();
  const same = a.length === b.length && a.every((x, i) => x === b[i]);
  console.log(`  ${q.padEnd(24)} blocked=${a.length}  identical=${same ? "YES" : "*** NO ***"}`);
}
