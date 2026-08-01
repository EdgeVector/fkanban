#!/usr/bin/env bun
/**
 * Which MilestoneCards rows does the CLIENT deny, and are they real cards?
 *
 * Companion to `probe-projection-drop-rule.ts`, which established the premise:
 * the node returns a row even when a projected field has no atom — it simply
 * omits that key from `fields`. `listMilestoneCardsPartition` then runs
 *
 *     if (String(f.layout ?? "") !== MILESTONE_CARDS_LAYOUT) return null;
 *
 * so an ABSENT marker is read as a FOREIGN row. This probe names the rows that
 * lose that argument and checks each against BoardCards truth, because a row
 * that is invisible to this read is also invisible to `milestone detail`,
 * `milestone reconcile`, and `purgeOtherMilestoneCardRows` — nothing can
 * report it and nothing can delete it.
 *
 * Read-only.
 *
 *   bun scripts/probe-layout-marker-denial.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_MILESTONES_FIELDS,
  MILESTONE_CARDS_FIELDS,
  MILESTONE_CARDS_LAYOUT,
} from "../src/schemas.ts";
import { BOARD_CARDS_SPINE_FIELDS } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bmHash = cfg.schemaHashes?.board_milestones;
const mcHash = cfg.schemaHashes?.milestone_cards;
const bcHash = cfg.schemaHashes?.board_cards;
if (!mcHash) {
  console.log("milestone_cards unbound — nothing to measure.");
  process.exit(0);
}

async function rows(schemaHash: string, fields: readonly string[], filter: Record<string, string>) {
  try {
    const res = await node.queryAll({ schemaHash, fields: [...fields], filter });
    return (res.results ?? []).map((r) => (r.fields ?? {}) as Record<string, unknown>);
  } catch {
    return [];
  }
}

// Milestone partitions, discovered at slug width.
const parts: string[] = [];
if (bmHash) {
  for (const board of ["default", "agent-dogfood-scratch"]) {
    for (const r of await rows(bmHash, ["board", "sk", "slug"], { HashKey: board })) {
      const s = String(r.slug ?? "");
      if (s && !parts.includes(s)) parts.push(s);
    }
  }
}

type Denied = { milestone: string; sk: string; slug: string; keys: number };
const denied: Denied[] = [];
let total = 0;
for (const ms of parts) {
  for (const r of await rows(mcHash, MILESTONE_CARDS_FIELDS, { HashKey: ms })) {
    total += 1;
    const hasKey = "layout" in r;
    const value = String(r.layout ?? "");
    if (hasKey && value === MILESTONE_CARDS_LAYOUT) continue;
    denied.push({
      milestone: ms,
      sk: String(r.sk ?? ""),
      slug: String(r.slug ?? ""),
      keys: Object.keys(r).length,
    });
  }
}

console.log(`MilestoneCards rows returned by the node: ${total}`);
console.log(`rows the client's marker check DENIES:     ${denied.length}\n`);

for (const d of denied) {
  // Is it a live card? Ask BoardCards — the index the write path maintains.
  let onBoard = "no";
  if (bcHash) {
    for (const b of ["default", "agent-dogfood-scratch"]) {
      const hit = (await rows(bcHash, BOARD_CARDS_SPINE_FIELDS, { HashKey: b })).find(
        (r) => String(r.slug ?? "") === d.slug,
      );
      if (hit) {
        onBoard = `${b}/${String(hit.sk ?? "")}`;
        break;
      }
    }
  }
  console.log(`  milestone=${d.milestone}`);
  console.log(`    sk=${d.sk}  slug=${d.slug}  fields_returned=${d.keys}/${MILESTONE_CARDS_FIELDS.length}`);
  console.log(`    live on BoardCards: ${onBoard}`);
}

console.log("\nRead-only. Nothing was written.");
