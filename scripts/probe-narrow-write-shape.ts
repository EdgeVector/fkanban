#!/usr/bin/env bun
/**
 * Follow-up to probe-partial-write-cost.ts — two questions the cost probe
 * left open, both of which decide the SHAPE of a narrow BoardCards write:
 *
 *   1. Must a narrow update re-send the key fields (`board`, `sk`)? They are
 *      the partition/range key AND projected fields, so they already have
 *      atoms. If the node accepts an update without them, every narrow write
 *      drops two fields (~400ms at the measured ~200ms/field).
 *
 *   2. Does `updateRecord` FAIL on a row that does not exist? The narrow path
 *      needs that to be a loud error, because its fallback must be a WIDE
 *      create — a narrow create would store an incomplete row, which LastDB
 *      silently drops from every wide projection.
 *
 * Run: bun scripts/probe-narrow-write-shape.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardsHash } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const BOARD = `zz-probe-shape-${Date.now()}`;
const SLUG = "zz-probe-card";
const SK = `todo#00000001#${SLUG}`;

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T | null, number, unknown]> => {
  const t0 = performance.now();
  try {
    const v = await fn();
    const dt = performance.now() - t0;
    console.log(`  ${label.padEnd(46)} ${dt.toFixed(0).padStart(6)}ms  ok`);
    return [v, dt, null];
  } catch (err) {
    const dt = performance.now() - t0;
    const msg = err instanceof Error ? err.message : String(err);
    console.log(`  ${label.padEnd(46)} ${dt.toFixed(0).padStart(6)}ms  ERR ${msg.slice(0, 90)}`);
    return [null, dt, err];
  }
};

function fullFields(gen: number): Record<string, unknown> {
  return {
    board: BOARD,
    sk: SK,
    slug: SLUG,
    title: `probe card gen ${gen}`,
    column: "todo",
    position: "1",
    assignee: `agent-${gen}`,
    tags: [`gen-${gen}`],
    deps: [],
    surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z",
    created_by: "probe",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    db: `db-${gen}`,
    repo: `EdgeVector/probe-${gen}`,
    base: `main-${gen}`,
    kind: "task",
    block_status: "clear",
    block_reason: `reason ${gen}`,
    north_star: `ns-${gen}`,
    milestone: `ms-${gen}`,
    pr_url: `https://example.invalid/${gen}`,
    branch: `branch-${gen}`,
    layout: BOARD_CARDS_LAYOUT,
  };
}

console.log(`schema ${schemaHash.slice(0, 12)}…  board ${BOARD}\n`);

// --- Q2 first: update a row that does not exist --------------------------
console.log("== Q2: updateRecord on a MISSING row ==");
const [, , missErr] = await ms("update (row absent)", () =>
  node.updateRecord({
    schemaHash,
    fields: { tags: ["x"], updated_at: "2026-07-31T00:00:00.000Z" },
    keyHash: BOARD,
    rangeKey: SK,
  }),
);
console.log(
  missErr
    ? "  -> FAILS loudly. A narrow update can safely fall back to a wide create.\n"
    : "  -> SUCCEEDS. DANGER: a narrow update would create an incomplete row.\n",
);

// If the no-op update actually created a row, the wide seed below repairs it.
console.log("== seed ==");
await ms("create (24 fields)", () =>
  node.createRecord({ schemaHash, fields: fullFields(1), keyHash: BOARD, rangeKey: SK }),
);

// --- Q1: narrow update WITHOUT the key fields ----------------------------
console.log("\n== Q1: narrow update, key fields omitted ==");
const [, , noKeyErr] = await ms("update {tags, updated_at} only", () =>
  node.updateRecord({
    schemaHash,
    fields: { tags: ["gen-2"], updated_at: "2026-07-31T00:00:02.000Z" },
    keyHash: BOARD,
    rangeKey: SK,
  }),
);

console.log("\n== is the row still whole at the 24-field projection? ==");
const [wide] = await ms("query all 24 fields", () =>
  node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter: { HashKey: BOARD } as never }),
);
const row = (wide?.results[0]?.fields ?? undefined) as Record<string, unknown> | undefined;
if (!row) {
  console.log("  ROW NOT RETURNED — key-less narrow update damaged the row.");
} else {
  const missing = BOARD_CARDS_FIELDS.filter((f) => row[f] === undefined || row[f] === null);
  console.log(`  missing/null fields: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`  board = ${JSON.stringify(row.board)}   sk = ${JSON.stringify(row.sk)}`);
  console.log(`  tags  = ${JSON.stringify(row.tags)}    title = ${JSON.stringify(row.title)}`);
}
console.log(
  `\n  verdict: narrow update ${noKeyErr ? "REQUIRES" : "does NOT require"} the key fields in the payload.`,
);

console.log("\n== cleanup ==");
await ms("delete", () => node.deleteRecord({ schemaHash, keyHash: BOARD, rangeKey: SK }));
