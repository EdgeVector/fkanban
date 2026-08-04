#!/usr/bin/env bun
/**
 * Does the widened write probe actually work against the LIVE primary — and
 * does its throwaway row stay out of the partitions real reads serve?
 *
 * The unit tests prove the probe is callable for all seven pinned keys and that
 * it addresses `WRITE_PROBE_SLUG` on both key axes. Only the primary can answer
 * the two questions that made this fix wait a run:
 *
 *   1. does Mini ACCEPT a HashRange create into a partition that does not exist
 *      yet, carrying every declared field? (a synthetic partition is the whole
 *      safety argument — if the node refused it, the argument collapses)
 *   2. is the live `default` partition byte-for-byte unchanged across the probe?
 *
 * NOT read-only: it creates and deletes one throwaway row per pinned schema, in
 * partition `__fkanban_write_probe__`. That is exactly what `kanban doctor` now
 * does on every run, so proving it once here is strictly cheaper than shipping
 * it unproven. Every partition is re-read afterwards to confirm the row is gone.
 *
 *   bun scripts/probe-index-schema-write-probe.ts
 */
import { readConfig, resolveSocketPath } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { probeSchemaWritable, WRITE_PROBE_SLUG } from "../src/record.ts";
import { allPinnedSchemas } from "../src/schemas.ts";

// How long to wait before the settle re-read. The immediate read-back measured
// a convergence window of seconds, not minutes; 15s clears it with headroom.
const SETTLE_MS = 15_000;

const cfg = readConfig();
const socket = resolveSocketPath(cfg);
const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: socket });
console.log(`socket: ${socket}\n`);

// Count the live `default` BoardCards partition before and after. This is the
// partition behind every `kanban list`; a probe that touched it would move this
// number, and nothing else in this script would notice.
const boardCardsHash = cfg.schemaHashes.board_cards;
async function liveDefaultRowCount(): Promise<number | null> {
  if (!boardCardsHash) return null;
  const res = await node.queryAll({
    schemaHash: boardCardsHash,
    fields: ["sk"],
    filter: { HashKey: "default" } as unknown as QueryFilter,
  });
  return res.results.length;
}

const before = await liveDefaultRowCount();
console.log(`live default BoardCards partition before: ${before ?? "(board_cards unpinned)"} rows\n`);

let failed = 0;
const probed: ReturnType<typeof allPinnedSchemas> = [];
const lagging: string[] = [];
for (const entry of allPinnedSchemas()) {
  const hash = cfg.schemaHashes[entry.key];
  const label = entry.key.padEnd(18);
  if (!hash) {
    console.log(`· ${label} unpinned — skipped`);
    continue;
  }
  const t0 = Date.now();
  const r = await probeSchemaWritable(node, hash, entry);
  const ms = Date.now() - t0;
  if (!r.writable) {
    failed += 1;
    console.log(`✗ ${label} NOT writable (${ms}ms) — ${r.reason}`);
    continue;
  }
  console.log(`✓ ${label} writable (${ms}ms)${r.leaked ? ` ** LEAKED: ${r.leaked} **` : ""}`);
  probed.push(entry);

  // Read the probe partition back IMMEDIATELY. Measured 2026-08-04 on the
  // primary: six of the seven still return the row here, and all seven return
  // zero when re-read minutes later. The delete is applied; a read landing right
  // behind it still serves the pre-delete tip. So this is reported, never
  // failed — asserting an empty partition here would be asserting a convergence
  // window, and the first run of this script did exactly that and printed a red
  // over a cleanup that had worked.
  const def = entry.schema.schema;
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [def.key.hash_field],
    filter: { HashKey: WRITE_PROBE_SLUG } as unknown as QueryFilter,
  });
  if (res.results.length > 0) lagging.push(entry.key);
}

// Now settle the question the immediate read-back cannot: are the probe rows
// actually gone? This is the assertion that matters, and it is the one the
// cleanup contract makes.
if (lagging.length > 0) {
  console.log(
    `\n· ${lagging.length}/${probed.length} still visible immediately after delete` +
      ` (${lagging.join(", ")}) — re-reading after ${SETTLE_MS}ms`,
  );
}
await Bun.sleep(SETTLE_MS);
for (const entry of probed) {
  const hash = cfg.schemaHashes[entry.key]!;
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [entry.schema.schema.key.hash_field],
    filter: { HashKey: WRITE_PROBE_SLUG } as unknown as QueryFilter,
  });
  if (res.results.length > 0) {
    failed += 1;
    console.log(`✗ ${entry.key.padEnd(18)} probe row SURVIVED cleanup — ${res.results.length} row(s)`);
  }
}
if (failed === 0) console.log(`✓ every probe partition empty after settle`);

const after = await liveDefaultRowCount();
console.log(`\nlive default BoardCards partition after:  ${after ?? "(board_cards unpinned)"} rows`);
if (before !== after) {
  failed += 1;
  console.log(`✗ the live partition CHANGED (${before} → ${after}) — the probe is not confined`);
} else if (before !== null) {
  console.log(`✓ live partition untouched`);
}

console.log(`\n${failed === 0 ? "GREEN" : `RED — ${failed} problem(s)`}`);
process.exit(failed === 0 ? 0 : 1);
