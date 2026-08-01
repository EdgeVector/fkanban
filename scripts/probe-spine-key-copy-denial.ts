#!/usr/bin/env bun
/**
 * Does the BoardCards SPINE — the read whose whole job is to see EVERY row —
 * lose rows by projecting COPIES of its own key?
 *
 * `BOARD_CARDS_SPINE_FIELDS` is `["board","sk","slug","column","position"]` and
 * its doc claimed reconcilers, orphan reaping and parity checks could trust it
 * because "a row that lacks a spine field could not have been keyed into the
 * partition in the first place". That is exactly backwards: `board` and `sk` are
 * payload copies of the key, not the key. A partial write leaves a row keyed
 * into the partition carrying neither.
 *
 * Started as a test of whether projecting the HASH field specifically drops rows
 * (as measured on MilestoneCards, 56 -> 49). It does not — dropping `board` from
 * the projection changes nothing here. The culprit is the same 19 rows missing
 * `board`, `sk`, `milestone` AND `layout` together.
 *
 * This probe:
 *   1. compares widths on a real partition, one field at a time;
 *   2. names the rows the spine loses;
 *   3. checks each against Card truth, because a row invisible to the spine is
 *      invisible to every purge that addresses rows through it — nothing can
 *      report it and nothing can delete it.
 *
 * Two traps it exists to keep measured:
 *   - `fields: []` is NOT the floor. The node reads an empty projection as the
 *     FULL field set: it measures identically to the old five-field spine.
 *   - No projection is drop-free. `["title"]` sees one row `["slug"]` does not.
 *
 * Read-only.
 *
 *   bun scripts/probe-spine-key-copy-denial.ts [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_SPINE_FIELDS } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bcHash = cfg.schemaHashes?.board_cards;
const cardHash = cfg.schemaHashes?.card;
if (!bcHash) {
  console.log("board_cards unbound — nothing to measure.");
  process.exit(0);
}

type Row = { sk: string; fields: Record<string, unknown> };

async function rows(fields: readonly string[], board: string): Promise<Row[] | null> {
  try {
    const res = await node.queryAll({
      schemaHash: bcHash,
      fields: [...fields],
      filter: { HashKey: board },
    });
    return (res.results ?? []).map((r) => ({
      sk: typeof r.key?.range === "string" ? r.key.range : "",
      fields: (r.fields ?? {}) as Record<string, unknown>,
    }));
  } catch (e) {
    console.log(`   ERR ${e instanceof Error ? e.message : String(e)}`);
    return null;
  }
}

const BOARD = process.argv[2] ?? "default";
console.log(`board_cards partition HashKey=${BOARD}\n`);

// 1. One field at a time — which single projected field costs rows?
console.log("== single-field widths ==");
const widths = new Map<string, Row[]>();
for (const f of ["slug", "title", "sk", "column", "position", "board", "milestone", "layout", "created_by"]) {
  const rs = await rows([f], BOARD);
  if (!rs) continue;
  widths.set(f, rs);
  console.log(`  ${f.padEnd(12)} rows=${String(rs.length).padStart(4)}`);
}

// 2. The spine as shipped, vs the spine without the hash field.
const spine = await rows(BOARD_CARDS_SPINE_FIELDS, BOARD);
const spineNoHash = await rows(
  BOARD_CARDS_SPINE_FIELDS.filter((f) => f !== "board"),
  BOARD,
);
console.log("\n== the spine, as shipped vs without the partition key ==");
console.log(`  spine as shipped        ${JSON.stringify(BOARD_CARDS_SPINE_FIELDS)}`);
console.log(`     rows=${spine?.length ?? -1}`);
console.log(`  spine minus "board"     rows=${spineNoHash?.length ?? -1}`);

const widest = widths.get("slug") ?? [];
if (spine && spineNoHash) {
  console.log(`  slug-only               rows=${widest.length}`);
  console.log(
    `\n  => shipped spine loses ${widest.length - spine.length} rows vs slug-only, ` +
      `${spineNoHash.length - spine.length} of them purely to the hash field.`,
  );
}

// 3. Name the rows the spine loses, and ask whether they are real cards.
const spineSks = new Set((spine ?? []).map((r) => r.sk));
const lost = widest.filter((r) => !spineSks.has(r.sk));
console.log(`\n== the ${lost.length} rows the shipped spine cannot see ==`);
for (const r of lost.slice(0, 40)) {
  const slug = typeof r.fields.slug === "string" ? r.fields.slug : "(no slug atom)";
  let cardVerdict = "card schema unbound";
  if (cardHash) {
    try {
      const res = await node.queryAll({
        schemaHash: cardHash,
        fields: ["slug", "column", "updated_at"],
        filter: { HashKey: slug },
      });
      const hit = (res.results ?? [])[0];
      cardVerdict = hit
        ? `REAL CARD (Card.column=${String((hit.fields as Record<string, unknown>)?.column ?? "?")})`
        : "no Card row (orphan)";
    } catch {
      cardVerdict = "card read failed";
    }
  }
  console.log(`  sk=${r.sk.padEnd(58)} ${cardVerdict}`);
}
if (lost.length > 40) console.log(`  ... and ${lost.length - 40} more`);

// 4. Which atom is actually missing on a lost row? Ask field by field.
if (lost.length > 0) {
  const sample = lost.slice(0, 3);
  console.log("\n== per-field atom presence on lost rows ==");
  for (const r of sample) {
    const present: string[] = [];
    const absent: string[] = [];
    for (const f of ["slug", "sk", "column", "position", "board", "milestone", "layout", "created_by", "title"]) {
      const rs = await rows([f], BOARD);
      if (!rs) continue;
      (rs.some((x) => x.sk === r.sk) ? present : absent).push(f);
    }
    console.log(`  sk=${r.sk}`);
    console.log(`     supplies: ${present.join(",") || "(none)"}`);
    console.log(`     denies  : ${absent.join(",") || "(none)"}`);
  }
}
