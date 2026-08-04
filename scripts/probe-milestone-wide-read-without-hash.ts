#!/usr/bin/env bun
/**
 * Does dropping the HASH field from the wide read recover the rows it loses?
 *
 * `probe-projection-rule-constructed.ts` settled the node's rule at
 * HASH-ELSE-LEAD (204/0, every other candidate falsified): a row is returned
 * iff the projection's HASH field has an atom when the hash field is projected
 * at all, and otherwise iff the LEADING field does.
 *
 * That explains why `probe-milestone-detail-lead-drop.ts` found re-leading the
 * wide read with `slug` recovered nothing — it kept `milestone` in the field
 * list, so the gate never moved. Under the real rule the only thing that moves
 * the gate off the hash field is REMOVING it, which is exactly what
 * `listMilestoneCardsPartitionSpine` already does and documents.
 *
 * Three reads per live partition:
 *
 *   sweep       every field as lead, unioned   — the completeness baseline
 *   as-shipped  MILESTONE_CARDS_FIELDS         — hash-gated on `milestone`
 *   no-hash     same set minus `milestone`     — lead-gated on `slug`
 *
 * Read-only.
 *
 *   bun scripts/probe-milestone-wide-read-without-hash.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_MILESTONES_FIELDS, MILESTONE_CARDS_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const mcHash = cfg.schemaHashes!.milestone_cards!;
const bmHash = cfg.schemaHashes?.board_milestones;

async function skSet(fields: readonly string[], ms: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await node.queryAll({ schemaHash: mcHash, fields: [...fields], filter: { HashKey: ms } });
    for (const r of res.results ?? []) {
      if (typeof r.key?.range === "string" && r.key.range) out.add(r.key.range);
    }
  } catch { /* partition unreadable at this projection */ }
  return out;
}

const parts: string[] = [];
if (bmHash) {
  for (const board of ["default", "agent-dogfood-scratch"]) {
    try {
      const res = await node.queryAll({
        schemaHash: bmHash,
        fields: [...BOARD_MILESTONES_FIELDS],
        filter: { HashKey: board },
      });
      for (const r of res.results ?? []) {
        const s = String((r.fields ?? {}).slug ?? "");
        if (s && !parts.includes(s)) parts.push(s);
      }
    } catch { /* board absent */ }
  }
}

// `slug` leads so the gate lands on the same field the spine read uses — the
// two reads then agree on the row set by construction, which is what lets
// `milestone detail` classify repairs from the pair without them disagreeing
// about which rows exist.
const noHash = ["slug", ...MILESTONE_CARDS_FIELDS.filter((f) => f !== "slug" && f !== "milestone")];

let tSweep = 0, tShipped = 0, tNoHash = 0, recovered = 0;
for (const ms of parts) {
  const sweep = new Set<string>();
  for (const lead of MILESTONE_CARDS_FIELDS) for (const s of await skSet([lead], ms)) sweep.add(s);
  const shipped = await skSet(MILESTONE_CARDS_FIELDS, ms);
  const fixed = await skSet(noHash, ms);
  tSweep += sweep.size; tShipped += shipped.size; tNoHash += fixed.size;

  const missedNow = [...sweep].filter((s) => !shipped.has(s));
  const missedAfter = [...sweep].filter((s) => !fixed.has(s));
  if (missedNow.length || missedAfter.length) {
    recovered += missedNow.length - missedAfter.length;
    console.log(`${ms}\n  sweep ${sweep.size}  as-shipped ${shipped.size}  no-hash ${fixed.size}` +
      `  invisible now ${missedNow.length} -> after ${missedAfter.length}`);
    for (const s of missedAfter.slice(0, 3)) console.log(`    still invisible: ${s}`);
  }
}

console.log(`\nTOTAL over ${parts.length} partitions  sweep ${tSweep}  as-shipped ${tShipped}  no-hash ${tNoHash}`);
console.log(
  tNoHash > tShipped
    ? `\nGREEN: dropping the hash field recovers ${recovered} row(s) the product read cannot see today.`
    : tNoHash === tShipped
      ? `\nNEUTRAL: no live row is currently gated out — the change is a guard, not a repair.`
      : `\nRED: dropping the hash field LOSES rows. Do not ship.`,
);
