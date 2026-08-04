#!/usr/bin/env bun
/**
 * Does the PRODUCT wide read of a milestone partition drop rows, and how many?
 *
 * `listMilestoneCardsPartitionSpine` documents, and declines, the one thing
 * measured to drop rows on this index: "Projecting the hash field is the one
 * thing that DOES drop rows on this index (56 -> 49 in the probed partition)".
 *
 * `listMilestoneCardsPartition` — the read behind `milestone detail`,
 * `milestone reconcile` and every milestone rollup — projects
 * `MILESTONE_CARDS_FIELDS` verbatim, whose FIRST entry is `milestone`. Under
 * the rule `sweepMilestoneCardsPartition` is built on ("a row is returned iff
 * the field LEADING the projection has an atom on it"), that read is gated on
 * exactly the field the spine read refuses to project.
 *
 * Three reads per live partition, same field SET, only the lead differing:
 *
 *   sweep       every field as lead, unioned    — the completeness baseline
 *   as-shipped  MILESTONE_CARDS_FIELDS          — lead `milestone`
 *   slug-led    same set, `slug` moved to front — the proposed fix
 *
 * Read-only.
 *
 *   bun scripts/probe-milestone-detail-lead-drop.ts
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

const bmHash = cfg.schemaHashes?.board_milestones;
const mcHash = cfg.schemaHashes?.milestone_cards;
if (!mcHash) {
  console.log("milestone_cards unbound — nothing to measure.");
  process.exit(0);
}

/** Range keys returned by one projection of one partition. */
async function skSet(fields: readonly string[], milestone: string): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await node.queryAll({
      schemaHash: mcHash!,
      fields: [...fields],
      filter: { HashKey: milestone },
    });
    for (const r of res.results ?? []) {
      const range = typeof r.key?.range === "string" ? r.key.range : "";
      if (range) out.add(range);
    }
  } catch (err) {
    console.log(`  ! ${milestone} @ [${fields[0]}…] failed: ${String(err).slice(0, 80)}`);
  }
  return out;
}

// Discover live milestone partitions the same way doctor does.
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
    } catch {
      /* board absent */
    }
  }
}
console.log(`partitions: ${parts.length}\n`);

const slugLed = ["slug", ...MILESTONE_CARDS_FIELDS.filter((f) => f !== "slug")];

let totSweep = 0;
let totShipped = 0;
let totSlugLed = 0;
const losers: string[] = [];

for (const ms of parts) {
  // Sweep: union over every lead. The only baseline that is not a projection.
  const sweep = new Set<string>();
  for (const lead of MILESTONE_CARDS_FIELDS) {
    for (const sk of await skSet([lead], ms)) sweep.add(sk);
  }
  const shipped = await skSet(MILESTONE_CARDS_FIELDS, ms);
  const fixed = await skSet(slugLed, ms);

  totSweep += sweep.size;
  totShipped += shipped.size;
  totSlugLed += fixed.size;

  const missed = [...sweep].filter((sk) => !shipped.has(sk));
  if (missed.length > 0) {
    losers.push(ms);
    console.log(
      `${ms}\n  sweep ${sweep.size}  as-shipped ${shipped.size}  slug-led ${fixed.size}` +
        `  MISSED BY PRODUCT READ: ${missed.length}`,
    );
    for (const sk of missed.slice(0, 5)) console.log(`    ${sk}`);
  }
}

console.log(
  `\nTOTAL  sweep ${totSweep}  as-shipped ${totShipped}  slug-led ${totSlugLed}`,
);
console.log(
  `partitions where the product read is short: ${losers.length}/${parts.length}` +
    (losers.length ? ` — ${losers.join(", ")}` : ""),
);
console.log(
  totShipped < totSweep
    ? `\nRED: milestone detail/reconcile cannot see ${totSweep - totShipped} live row(s).`
    : `\nGREEN: the shipped projection reached every row the sweep did.`,
);
