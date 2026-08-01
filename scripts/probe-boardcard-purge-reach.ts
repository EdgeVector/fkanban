#!/usr/bin/env bun
/**
 * Can `purgeOtherBoardCardRows` reach the rows it exists to delete?
 *
 * The purge is the only mechanism that stops one slug from occupying two rows
 * in a BoardCards partition (stale column membership). It runs on every
 * ordinary card write that does not opt out, and on every `removeBoardCard`.
 *
 * It reads at {@link BOARD_CARDS_SPINE_FIELDS} and then rebuilds each row's
 * range key from the PAYLOAD COPIES it read back
 * (`boardCardSk(row.column, row.position, row.slug)`). Both halves are
 * measured hazards on this index:
 *
 *   1. the five-field spine projects `board` and `sk`, which are payload
 *      copies of the key — a partial write leaves a row keyed into the
 *      partition carrying neither, and LastDB drops any row missing an atom
 *      for a projected field.
 *   2. the reconstructed sk is a copy of the address, not the address.
 *
 * `listBoardCardsPartitionSpine` already exists and does neither: it projects
 * {@link BOARD_CARDS_ADDRESS_FIELDS} (`["slug"]`) and takes identity from
 * `QueryRow.key.range`. This probe measures the gap between the two reads on
 * the live partitions, and — the part that decides severity — counts the
 * DUPLICATE-slug rows that only the address read can see. Those are precisely
 * the rows the purge is supposed to delete and provably cannot.
 *
 * Read-only. Deletes nothing, writes nothing.
 *
 *   bun scripts/probe-boardcard-purge-reach.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_ADDRESS_FIELDS,
  BOARD_CARDS_SPINE_FIELDS,
  boardCardSk,
  parseBoardCardSk,
} from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const schemaHash = cfg.schemaHashes?.board_cards;
if (!schemaHash) {
  console.error("no board_cards schema hash in config");
  process.exit(1);
}

const boards: string[] = [];
{
  const bh = cfg.schemaHashes?.board_list_index ?? cfg.schemaHashes?.board;
  try {
    if (bh) {
      const res = await node.queryAll({ schemaHash: bh, fields: ["slug"], filter: {} });
      for (const r of res.results ?? []) {
        const s = String(((r.fields ?? {}) as Record<string, unknown>).slug ?? "");
        if (s && !boards.includes(s)) boards.push(s);
      }
    }
  } catch {
    /* fall through */
  }
}
if (boards.length === 0) boards.push("default");

type Row = { sk: string; slug: string };

/** What the purge sees today: spine projection, sk rebuilt from payload copies. */
async function purgeView(board: string): Promise<Row[]> {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: [...BOARD_CARDS_SPINE_FIELDS],
    filter: { HashKey: board } as never,
  });
  const out: Row[] = [];
  for (const r of res.results ?? []) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    const slug = String(f.slug ?? "");
    if (!slug) continue;
    out.push({ slug, sk: boardCardSk(String(f.column ?? ""), String(f.position ?? ""), slug) });
  }
  return out;
}

/** What `listBoardCardsPartitionSpine` sees: address projection, real range key. */
async function addressView(board: string): Promise<Row[]> {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: [...BOARD_CARDS_ADDRESS_FIELDS],
    filter: { HashKey: board } as never,
  });
  const out: Row[] = [];
  for (const r of res.results ?? []) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    const sk = typeof r.key?.range === "string" && r.key.range.length > 0
      ? r.key.range
      : String(f.sk ?? "");
    if (!sk) continue;
    const slug = parseBoardCardSk(sk)?.slug ?? String(f.slug ?? "");
    if (!slug) continue;
    out.push({ slug, sk });
  }
  return out;
}

let totalUnreachable = 0;
let totalDupUnreachable = 0;

for (const board of boards) {
  let purge: Row[];
  let address: Row[];
  try {
    const t0 = performance.now();
    purge = await purgeView(board);
    const t1 = performance.now();
    address = await addressView(board);
    const t2 = performance.now();
    console.log(
      `\n=== board ${board} — spine ${purge.length} rows (${Math.round(t1 - t0)}ms) / ` +
        `address ${address.length} rows (${Math.round(t2 - t1)}ms)`,
    );
  } catch (err) {
    console.log(`\n=== board ${board} — SKIP (${String(err).slice(0, 120)})`);
    continue;
  }

  // A row is unreachable when the purge cannot produce its real range key:
  // either it never saw the row, or it rebuilt an sk that no row carries.
  const reachable = new Set(purge.map((r) => r.sk));
  const unreachable = address.filter((r) => !reachable.has(r.sk));

  // Which unreachable rows MATTER: a slug holding more than one row in the
  // partition. Those are live duplicate membership — the exact defect the
  // purge is the only cure for.
  const bySlug = new Map<string, Row[]>();
  for (const r of address) {
    const xs = bySlug.get(r.slug) ?? [];
    xs.push(r);
    bySlug.set(r.slug, xs);
  }
  const dupUnreachable = unreachable.filter((r) => (bySlug.get(r.slug)?.length ?? 0) > 1);

  totalUnreachable += unreachable.length;
  totalDupUnreachable += dupUnreachable.length;

  console.log(`  rows the purge cannot address: ${unreachable.length}`);
  for (const r of unreachable.slice(0, 12)) {
    const n = bySlug.get(r.slug)?.length ?? 1;
    console.log(`    ${n > 1 ? "DUP " : "    "}${r.sk}`);
  }
  if (unreachable.length > 12) console.log(`    … ${unreachable.length - 12} more`);
  console.log(`  of those, duplicate-slug (undeletable stale membership): ${dupUnreachable.length}`);
  for (const r of dupUnreachable) {
    const all = (bySlug.get(r.slug) ?? []).map((x) => x.sk).join("  |  ");
    console.log(`    ${r.slug}\n      all rows: ${all}`);
  }
}

console.log(
  `\nTOTAL unreachable=${totalUnreachable} duplicate-slug-unreachable=${totalDupUnreachable}`,
);
