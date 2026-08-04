#!/usr/bin/env bun
/**
 * Which leads reach the one live MilestoneCards row no product read can see?
 *
 * `probe-milestone-detail-lead-drop.ts` found exactly one such row across all
 * 40 live partitions, and found that re-leading the wide read with `slug`
 * recovers none of it. So the row lacks BOTH the partition key and `slug`, and
 * the interesting question is what it DOES carry — that is what says whether
 * anything can repair it, and whether the board-membership union behind
 * `milestone detail` already covers it.
 *
 * Read-only.
 *
 *   bun scripts/probe-milestone-charter-row-reach.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_SPINE_FIELDS } from "../src/board-cards.ts";
import { MILESTONE_CARDS_FIELDS } from "../src/schemas.ts";

const MS = "operation-trinity-m0-charter";
const SK = "done#1785302647745#operation-trinity-proof-charter-terminal";
const SLUG = "operation-trinity-proof-charter-terminal";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const mcHash = cfg.schemaHashes?.milestone_cards;
const bcHash = cfg.schemaHashes?.board_cards;
const cardHash = cfg.schemaHashes?.card;

const reached: string[] = [];
for (const lead of MILESTONE_CARDS_FIELDS) {
  try {
    const res = await node.queryAll({
      schemaHash: mcHash!,
      fields: [lead],
      filter: { HashKey: MS },
    });
    for (const r of res.results ?? []) {
      if (r.key?.range === SK) {
        const v = (r.fields ?? {})[lead];
        reached.push(`${lead}=${v === undefined ? "<absent>" : JSON.stringify(v)}`);
      }
    }
  } catch (err) {
    reached.push(`${lead} THREW ${String(err).slice(0, 60)}`);
  }
}
console.log(`leads that return the row (${reached.length}/${MILESTONE_CARDS_FIELDS.length}):`);
for (const r of reached) console.log(`  ${r}`);

// Does the board still carry this card at all? `milestone detail` unions
// MilestoneCards with live board membership, so a card the board knows about
// is displayed even when its index row is unreachable.
if (bcHash) {
  const res = await node.queryAll({
    schemaHash: bcHash,
    fields: [...BOARD_CARDS_SPINE_FIELDS],
    filter: { HashKey: "default" },
  });
  const hit = (res.results ?? []).find((r) => String((r.fields ?? {}).slug ?? "") === SLUG);
  console.log(`\nBoardCards(default) carries the card: ${hit ? "YES" : "NO"}`);
}
if (cardHash) {
  const res = await node.queryAll({
    schemaHash: cardHash,
    fields: ["slug", "milestone", "column"],
    filter: { HashKey: SLUG },
  });
  const f = (res.results ?? [])[0]?.fields;
  console.log(`Card row: ${f ? JSON.stringify(f) : "ABSENT — the card itself is gone"}`);
}
