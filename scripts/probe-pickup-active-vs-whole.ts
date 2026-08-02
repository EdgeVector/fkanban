#!/usr/bin/env bun
/**
 * READ-ONLY probe: does `pickup status` need the `done` archive it reads?
 *
 * `pickup status` reads every board's WHOLE BoardCards partition
 * (`listCards` -> `listAllBoardCards`, HashKey per board) and then classifies
 * only `activeCards` — nothing in a terminal column. The terminal rows survive
 * for exactly one reason: they are handed to `listDependencyStatusesForCards`
 * as `knownCards`, so a dep pointing at a finished card resolves without a
 * point read.
 *
 * That is the SAME trade `list --column` stopped making on 2026-08-02
 * (DEP_SEED_POINT_READ_MAX): an unbounded archive read to dodge k point reads.
 * `probe-partition-cost.ts` says the archive is 77% of a whole-partition read
 * on this board and only grows.
 *
 * This probe answers the two questions that decide whether the same fix ports:
 *   1. COST — whole-partition reads vs (active-column prefixes + k point reads),
 *      interleaved reps so node warmth cannot favour one shape.
 *   2. VERDICT EQUALITY — build the full pickup report BOTH ways and diff every
 *      classification field, not just the category. A cheaper read that changes
 *      one verdict is not cheaper, it is wrong.
 *
 * Run: bun scripts/probe-pickup-active-vs-whole.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoards,
  listCards,
  listCardsByColumn,
  listDependencyStatusesForCards,
  CARD_LIST_FIELDS,
  type Card,
  type Board,
} from "../src/record.ts";
import { buildPickupStatusReportWithSituations } from "../src/pickup.ts";

const reps = Number(process.argv[2] ?? 3);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const ms = async <T>(fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  return [v, Math.round(performance.now() - t0)];
};

const terminalOf = (b: Board) => b.columns[b.columns.length - 1] ?? "done";

/** Candidate read: every NON-terminal column of every board, by prefix. */
async function readActiveCards(boards: Board[]): Promise<Card[]> {
  const bySlug = new Map<string, Card>();
  for (const b of boards) {
    const terminal = terminalOf(b);
    for (const col of b.columns) {
      if (col === terminal) continue;
      const rows = await listCardsByColumn(node, cfg, col, CARD_LIST_FIELDS, b.slug);
      for (const c of rows) bySlug.set(c.slug, c);
    }
  }
  return [...bySlug.values()];
}

const boards = await listBoards(node, cfg);
console.log(`boards: ${boards.map((b) => `${b.slug}(${b.columns.join(">")})`).join(", ")}`);

// ── k: how many dep edges point off the active set? ─────────────────────────
const active0 = await readActiveCards(boards);
const activeSlugs = new Set(active0.map((c) => c.slug));
const offSet = [...new Set(active0.flatMap((c) => c.deps ?? []))].filter(
  (s) => s.length > 0 && !activeSlugs.has(s),
);
console.log(`\nactive cards: ${active0.length}   off-set dep slugs (k): ${offSet.length}`);
if (offSet.length > 0) console.log(`  ${offSet.join(", ")}`);

// ── cost, interleaved ───────────────────────────────────────────────────────
const wholeMs: number[] = [];
const activeMs: number[] = [];
for (let i = 1; i <= reps; i++) {
  const [whole, tWhole] = await ms(() => listCards(node, cfg, { boards }));
  const [act, tAct] = await ms(async () => {
    const a = await readActiveCards(boards);
    return listDependencyStatusesForCards(node, cfg, a);
  });
  wholeMs.push(tWhole);
  activeMs.push(tAct);
  console.log(
    ` rep ${i}  whole=${String(tWhole).padStart(5)}ms (${whole.length} rows)   ` +
      `active+deps=${String(tAct).padStart(5)}ms (${act.length} rows)`,
  );
}
const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\n== cost (median of ${reps}) ==`);
console.log(`  whole partitions (what pickup does)   ${med(wholeMs)}ms`);
console.log(`  active columns + k point reads        ${med(activeMs)}ms`);

// ── verdict equality ────────────────────────────────────────────────────────
const wholeCards = await listCards(node, cfg, { boards });
const activeCardsSet = await readActiveCards(boards);

const reportOld = await buildPickupStatusReportWithSituations(wholeCards, boards, undefined, {
  cfg,
  node,
});
const reportNew = await buildPickupStatusReportWithSituations(activeCardsSet, boards, undefined, {
  cfg,
  node,
});

const key = (c: (typeof reportOld.cards)[number]) =>
  JSON.stringify({
    slug: c.slug,
    category: c.category,
    reason: c.reason,
    details: c.details,
    suggestion: c.suggestion,
  });
const oldBy = new Map(reportOld.cards.map((c) => [c.slug, key(c)]));
const newBy = new Map(reportNew.cards.map((c) => [c.slug, key(c)]));

const diffs: string[] = [];
for (const [slug, k] of oldBy) {
  if (!newBy.has(slug)) diffs.push(`MISSING in candidate: ${slug}`);
  else if (newBy.get(slug) !== k) {
    diffs.push(`DIFFERS ${slug}\n    old ${k}\n    new ${newBy.get(slug)}`);
  }
}
for (const slug of newBy.keys()) if (!oldBy.has(slug)) diffs.push(`EXTRA in candidate: ${slug}`);

console.log(`\n== verdict equality ==`);
console.log(`  scanned old=${reportOld.scanned} new=${reportNew.scanned}`);
console.log(`  ready   old=${reportOld.ready} new=${reportNew.ready}`);
if (diffs.length === 0) {
  console.log(`  GREEN — every classification identical, field for field.`);
} else {
  console.log(`  RED — ${diffs.length} classification difference(s):`);
  for (const d of diffs) console.log(`    ${d}`);
}
