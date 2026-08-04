#!/usr/bin/env bun
/**
 * What is the keyless row a MilestoneCards partition read returns?
 *
 * `probe-milestone-parity-baseline-cost.ts` found that on 18 of 19 live
 * MilestoneCards partitions, 9 of the 24 leads return ONE row with
 * `key.range === null`. Those 9 leads are exactly the fields MilestoneCards
 * shares with BoardMilestones — the two indexes Mini multi-key expanded onto
 * one product. The suspicion is therefore that the extra row is the milestone's
 * OWN BoardMilestones record bleeding into the cards partition.
 *
 * Read-only. Dumps the raw row under each lead so the answer is the data, not
 * the inference.
 *
 *   bun scripts/probe-milestone-cards-keyless-row.ts <milestone-slug>
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { MILESTONE_CARDS_FIELDS, BOARD_MILESTONES_FIELDS } from "../src/schemas.ts";

const milestone = process.argv[2] ?? "ms-backup-status-truthful";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const mcHash = cfg.schemaHashes?.milestone_cards;
if (!mcHash) {
  console.log("milestone_cards not bound");
  process.exit(0);
}

const shared = MILESTONE_CARDS_FIELDS.filter((f) =>
  (BOARD_MILESTONES_FIELDS as readonly string[]).includes(f),
);
console.log(`partition: ${milestone}`);
console.log(`fields shared with BoardMilestones (${shared.length}): ${shared.join(", ")}\n`);

const filter = { HashKey: milestone } as QueryFilter;

for (const lead of MILESTONE_CARDS_FIELDS) {
  try {
    const res = await node.queryAll({ schemaHash: mcHash, fields: [lead], filter });
    const keyless = res.results.filter(
      (r) => !(typeof r.key?.range === "string" && r.key.range.length > 0),
    );
    const keyed = res.results.length - keyless.length;
    const isShared = (shared as readonly string[]).includes(lead);
    console.log(
      `lead=${lead.padEnd(14)} shared=${isShared ? "Y" : "n"} keyed=${keyed} keyless=${keyless.length}`,
    );
    for (const r of keyless) {
      console.log(`    key=${JSON.stringify(r.key)}  fields=${JSON.stringify(r.fields)}`);
    }
  } catch (err) {
    console.log(`lead=${lead.padEnd(14)} ERROR ${err instanceof Error ? err.message.slice(0, 90) : err}`);
  }
}

// And what does the milestone's own BoardMilestones row look like?
const bmHash = cfg.schemaHashes?.board_milestones;
if (bmHash) {
  console.log(`\n--- BoardMilestones row for this milestone (partition=default) ---`);
  const res = await node.queryAll({
    schemaHash: bmHash,
    fields: ["slug", "title", "state"],
    filter: { HashKey: "default" } as QueryFilter,
  });
  for (const r of res.results) {
    if ((r.fields as Record<string, unknown>).slug === milestone) {
      console.log(`  key=${JSON.stringify(r.key)}  fields=${JSON.stringify(r.fields)}`);
    }
  }
}
