#!/usr/bin/env bun
/**
 * Can the orphan-purge paths SEE the orphans they exist to delete?
 *
 * `purgeOther*Rows` is how this app keeps one slug from occupying two rows in
 * a membership partition: read the partition, delete every row for the slug
 * that is not the one being kept. It reads through the module's normal
 * `list*Partition`, which sends the FULL projection.
 *
 * LastDB returns a row only when every PROJECTED field has an atom on it. So a
 * wide read is the most droppable read there is, and a purge that under-reads
 * does not fail — it silently leaves the orphan in place, forever, because no
 * later purge can see it either.
 *
 * `purgeOtherBoardCardRows` already reads at `BOARD_CARDS_SPINE_FIELDS` (5
 * fields). Its two siblings do not. This probe measures whether that matters
 * on the live primary: same partitions, spine width vs full width, count the
 * rows only the spine can see.
 *
 * Read-only. Deletes nothing, writes nothing.
 *
 *   bun scripts/probe-purge-projection-blindness.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_FIELDS,
  BOARD_MILESTONES_FIELDS,
  BOARD_MILESTONES_LAYOUT,
  MILESTONE_CARDS_FIELDS,
  MILESTONE_CARDS_LAYOUT,
} from "../src/schemas.ts";
import { BOARD_CARDS_SPINE_FIELDS, BOARD_CARDS_LAYOUT } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

type Case = {
  label: string;
  schemaHash: string | undefined;
  layout: string;
  wide: readonly string[];
  spine: readonly string[];
  partitions: string[];
};

// The spine of each index: the partition key, the sk, and the three fields
// purgeOther* uses to rebuild an sk. Nothing else can change which rows a
// purge is entitled to delete.
const BOARD_MILESTONES_SPINE = ["board", "sk", "slug", "state", "position"] as const;
const MILESTONE_CARDS_SPINE = ["milestone", "sk", "slug", "column", "position"] as const;

const boards: string[] = [];
{
  const bh = cfg.schemaHashes?.board_list_index ?? cfg.schemaHashes?.board;
  // Board discovery is not the point of this probe; ask the board index the
  // cheap way and fall back to the two boards we know exist.
  try {
    if (bh) {
      const res = await node.queryAll({ schemaHash: bh, fields: ["slug"], filter: {} });
      for (const r of res.results ?? []) {
        const s = String(((r.fields ?? {}) as Record<string, unknown>).slug ?? "");
        if (s) boards.push(s);
      }
    }
  } catch {
    /* fall through */
  }
}
if (boards.length === 0) boards.push("default", "agent-dogfood-scratch");

// Milestone partitions: read them off BoardMilestones at slug-only width so
// discovery cannot itself be blinded by a wide projection.
const milestones: string[] = [];
if (cfg.schemaHashes?.board_milestones) {
  for (const b of boards) {
    try {
      const res = await node.queryAll({
        schemaHash: cfg.schemaHashes.board_milestones,
        fields: ["slug"],
        filter: { HashKey: b },
      });
      for (const r of res.results ?? []) {
        const s = String(((r.fields ?? {}) as Record<string, unknown>).slug ?? "");
        if (s && !milestones.includes(s)) milestones.push(s);
      }
    } catch {
      /* skip */
    }
  }
}

const cases: Case[] = [
  {
    label: "BoardCards (already narrowed — control)",
    schemaHash: cfg.schemaHashes?.board_cards,
    layout: BOARD_CARDS_LAYOUT,
    wide: BOARD_CARDS_FIELDS,
    spine: BOARD_CARDS_SPINE_FIELDS,
    partitions: boards,
  },
  {
    label: "BoardMilestones (purge reads WIDE)",
    schemaHash: cfg.schemaHashes?.board_milestones,
    layout: BOARD_MILESTONES_LAYOUT,
    wide: BOARD_MILESTONES_FIELDS,
    spine: BOARD_MILESTONES_SPINE,
    partitions: boards,
  },
  {
    label: "MilestoneCards (purge reads WIDE)",
    schemaHash: cfg.schemaHashes?.milestone_cards,
    layout: MILESTONE_CARDS_LAYOUT,
    wide: MILESTONE_CARDS_FIELDS,
    spine: MILESTONE_CARDS_SPINE,
    partitions: milestones,
  },
];

const read = async (schemaHash: string, fields: readonly string[], hash: string) => {
  const res = await node.queryAll({ schemaHash, fields: [...fields], filter: { HashKey: hash } });
  return (res.results ?? []).map((r) => {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    return { sk: String(f.sk ?? ""), slug: String(f.slug ?? ""), layout: String(f.layout ?? "") };
  });
};

for (const c of cases) {
  console.log(`\n=== ${c.label} ===`);
  if (!c.schemaHash) {
    console.log("  schema not bound in config — skipped");
    continue;
  }
  console.log(`  wide=${c.wide.length} fields  spine=${c.spine.length} fields  partitions=${c.partitions.length}`);
  let totalWide = 0;
  let totalSpine = 0;
  let totalInvisible = 0;
  const invisibleDetail: string[] = [];
  for (const p of c.partitions) {
    let wideRows: Awaited<ReturnType<typeof read>>;
    let spineRows: Awaited<ReturnType<typeof read>>;
    try {
      wideRows = await read(c.schemaHash, c.wide, p);
      spineRows = await read(c.schemaHash, c.spine, p);
    } catch (err) {
      console.log(`  ${p.padEnd(46)} THREW: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    const wideSk = new Set(wideRows.map((r) => r.sk));
    // A spine read omits `layout`, so it cannot filter tombstoned partition
    // markers the way the real list does. Count only rows whose sk is a real
    // sk shape, so a foreign-layout row is not miscounted as an orphan.
    const invisible = spineRows.filter((r) => r.sk && r.slug && !wideSk.has(r.sk));
    totalWide += wideRows.length;
    totalSpine += spineRows.length;
    totalInvisible += invisible.length;
    if (invisible.length > 0) {
      for (const r of invisible) invisibleDetail.push(`${p} :: sk=${r.sk} slug=${r.slug}`);
    }
    if (wideRows.length !== spineRows.length || invisible.length > 0) {
      console.log(
        `  ${p.padEnd(46)} wide=${String(wideRows.length).padStart(4)} spine=${String(spineRows.length).padStart(4)}  invisible-to-purge=${invisible.length}`,
      );
    }
  }
  console.log(`  TOTAL  wide=${totalWide}  spine=${totalSpine}  rows only the spine can see: ${totalInvisible}`);
  for (const d of invisibleDetail.slice(0, 25)) console.log(`    ${d}`);
  if (invisibleDetail.length > 25) console.log(`    … and ${invisibleDetail.length - 25} more`);
}

// Duplicate-slug census at spine width: an orphan the purge missed shows up as
// one slug holding two sks in the same partition.
console.log(`\n=== duplicate slugs per partition, at SPINE width ===`);
for (const c of cases) {
  if (!c.schemaHash) continue;
  let dupes = 0;
  const detail: string[] = [];
  for (const p of c.partitions) {
    try {
      const rows = await read(c.schemaHash, c.spine, p);
      const bySlug = new Map<string, string[]>();
      for (const r of rows) {
        if (!r.slug || !r.sk) continue;
        bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r.sk]);
      }
      for (const [slug, sks] of bySlug) {
        if (sks.length > 1) {
          dupes += 1;
          detail.push(`${p} :: ${slug} -> ${sks.join(" | ")}`);
        }
      }
    } catch {
      /* skip */
    }
  }
  console.log(`  ${c.label.padEnd(44)} duplicated slugs: ${dupes}`);
  for (const d of detail.slice(0, 15)) console.log(`    ${d}`);
  if (detail.length > 15) console.log(`    … and ${detail.length - 15} more`);
}
