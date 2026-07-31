#!/usr/bin/env bun
/**
 * READ-ONLY probe: classify the Card point-reads `pickup status` still pays.
 *
 * `probe-command-reads.ts` shows `kanban pickup status` issuing dozens of
 * `card HashKey(<slug>)` point-reads — by far its dominant cost (measured
 * 2026-07-31: 44 calls / 7583ms, against 994ms for the BoardCards partitions
 * and 321ms for the board list). `listDependencyStatusesForCards` already
 * filters out every dep slug it holds in hand, so each remaining point-read is
 * a dep target that `listCards()` did NOT return.
 *
 * There are two very different reasons for that, and they need opposite fixes:
 *
 *   ABSENT  — the Card row is gone. A true dangling dep: the dependent can
 *             never unblock, and `probe-dangling-deps.ts` is the tool for it.
 *   EXISTS  — the Card row is there, but no BoardCards row put it in a queried
 *             partition. That is INDEX DRIFT, and the point-read is the board
 *             list silently paying to cover for it on every single invocation.
 *
 * Run: bun scripts/probe-pickup-dep-point-reads.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCards, listBoards, CARD_STATUS_FIELDS } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards });
console.log(`boards        : ${boards.map((b) => b.slug).join(", ")}`);
console.log(`listCards()   : ${cards.length} cards`);

// Mirror of pickup's `activeCards`: everything outside its board's terminal
// (last) column. Those are the cards pickup classifies, so those are the dep
// edges it resolves.
const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
const active = cards.filter((c) => c.column !== (terminalByBoard.get(c.board) ?? "done"));
console.log(`active cards  : ${active.length}`);

const inHand = new Set(cards.map((c) => c.slug));
const missing = [...new Set(active.flatMap((c) => c.deps ?? []))].filter((s) => !inHand.has(s));
console.log(`point-reads   : ${missing.length} dep targets not covered by the board list\n`);

const dependentsOf = (slug: string) =>
  active.filter((c) => (c.deps ?? []).includes(slug)).map((c) => `${c.board}/${c.column} ${c.slug}`);

const cardHash = schemaHashFor("card", cfg);
const exists: string[] = [];
const absent: string[] = [];

for (const slug of missing) {
  const res = await node.queryAll({
    schemaHash: cardHash,
    fields: CARD_STATUS_FIELDS,
    filter: { HashKey: slug },
  });
  const row = res.results[0]?.fields as Record<string, unknown> | undefined;
  if (row) {
    exists.push(slug);
    console.log(`  EXISTS  ${slug}`);
    console.log(`          board=${String(row.board ?? "") || "(empty)"} column=${String(row.column ?? "") || "(empty)"}`);
    for (const d of dependentsOf(slug)) console.log(`          <- ${d}`);
  } else {
    absent.push(slug);
    console.log(`  ABSENT  ${slug}`);
    for (const d of dependentsOf(slug)) console.log(`          <- ${d}`);
  }
}

console.log(`\nEXISTS in Card, missing from the board list : ${exists.length}   <- BoardCards drift`);
console.log(`ABSENT entirely (true dangling dep)         : ${absent.length}`);
if (exists.length > 0) {
  console.log(`\nDrifted boards: ${[...new Set(exists)].length} slugs. Heal with \`kanban groom board-cards-heal\`.`);
}
