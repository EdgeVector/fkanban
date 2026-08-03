#!/usr/bin/env bun
/**
 * READ-ONLY probe: doctor's parity check names a slug and tells the operator to
 * run `groom board-cards-heal --apply`. Does heal actually REACH that row?
 *
 * Doctor and heal both enumerate with `sweepBoardCardsPartition` (the 24-lead
 * union), so on paper they see the same rows. But doctor reported
 * `stale-pr-last-stack-read-before-edit-dearm-runtime` as invisible-to-wide on
 * the live `default` partition, and a heal dry run in the same minute emitted
 * 96 actions without ever naming it.
 *
 * One of those two is wrong about what it can see. This prints the raw
 * evidence: which read finds the slug, under which lead, and what the row
 * actually carries.
 *
 * Reads only. Nothing is written.
 *
 * Run: bun scripts/probe-doctor-parity-vs-heal-reach.ts [board] [slug]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import {
  boardCardsHash,
  listBoardCardsPartition,
  listBoardCardsPartitionSpine,
  sweepBoardCardsPartition,
} from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node: NodeClient = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.argv[2] ?? "default";
const SLUG = process.argv[3] ?? "stale-pr-last-stack-read-before-edit-dearm-runtime";

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.log("board_cards not bound — nothing to probe.");
  process.exit(0);
}

console.log(`board=${BOARD} slug=${SLUG}\n`);

// 1. The three enumerations, side by side.
const sweep = await sweepBoardCardsPartition(node, cfg, BOARD);
const wide = await listBoardCardsPartition(node, cfg, BOARD);
const spine = await listBoardCardsPartitionSpine(node, cfg, BOARD);

const sweepSlugs = new Set((sweep?.rows ?? []).map((r) => r.slug));
const wideSlugs = new Set((wide ?? []).map((c) => c.slug));
const spineSlugs = new Set((spine ?? []).map((r) => r.slug));

console.log("enumeration            rows  distinct slugs  has target");
const row = (name: string, rows: number, slugs: Set<string>) =>
  console.log(
    `${name.padEnd(22)} ${String(rows).padStart(4)}  ${String(slugs.size).padStart(14)}  ${
      slugs.has(SLUG) ? "YES" : "no"
    }`,
  );
row("sweep (24-lead union)", sweep?.rows.length ?? -1, sweepSlugs);
row("wide (24-field proj)", wide?.length ?? -1, wideSlugs);
row("spine (address proj)", spine?.length ?? -1, spineSlugs);
console.log(`failedLeads: ${JSON.stringify(sweep?.failedLeads ?? [])}\n`);

// 2. Which single-field leads can see the row at all?
console.log("per-lead reachability for the target slug:");
const reached: string[] = [];
for (const lead of BOARD_CARDS_FIELDS) {
  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [lead],
      filter: { HashKey: BOARD } as never,
    });
    const hit = res.results.some((r) => {
      const k = (r as { key?: unknown }).key;
      const sk = typeof k === "object" && k !== null ? String((k as { sk?: unknown }).sk ?? "") : "";
      const fields = (r as { fields?: Record<string, unknown> }).fields ?? {};
      return sk.includes(SLUG) || String(fields.slug ?? "") === SLUG;
    });
    if (hit) reached.push(lead);
  } catch (err) {
    console.log(`  ${lead.padEnd(16)} ERROR ${err instanceof Error ? err.message : String(err)}`);
  }
}
console.log(`  reachable under ${reached.length}/${BOARD_CARDS_FIELDS.length} leads: ${
  reached.join(", ") || "(none)"
}\n`);

// 3. The rows the sweep returned for this slug, with their real addresses.
const targetRows = (sweep?.rows ?? []).filter((r) => r.slug === SLUG);
console.log(`sweep rows for target: ${targetRows.length}`);
for (const r of targetRows) {
  console.log(`  sk=${JSON.stringify(r.sk)} board=${JSON.stringify(r.board)} slug=${JSON.stringify(r.slug)}`);
}

// 4. The dropped set doctor computes, in full.
const dropped = [...sweepSlugs].filter((s) => !wideSlugs.has(s));
console.log(`\ndoctor's dropped set (sweep minus wide): ${dropped.length}`);
for (const s of dropped) console.log(`  ${JSON.stringify(s)}`);
