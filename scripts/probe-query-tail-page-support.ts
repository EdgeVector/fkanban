#!/usr/bin/env bun
/**
 * READ-ONLY probe: can /api/query serve the TAIL of a range partition?
 *
 * `capPerColumn` renders the LAST `limit` rows of the terminal column (the most
 * recently finished cards), so a head-bounded page — which is what `limit` alone
 * gives — returns the wrong twelve. Getting the tail is either
 *
 *   (a) one round trip, if the node accepts a reverse/descending order, or
 *   (b) two, offset = total_count - limit, learned from a limit=1 count probe.
 *
 * This asks the node which one it is, by trying each plausible spelling and
 * checking the returned range keys against the known head and tail. It writes
 * nothing.
 *
 * Run: bun scripts/probe-query-tail-page-support.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, BOARD_CARDS_LIST_FIELDS, boardCardsWireProjection } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) throw new Error("BoardCards schema not bound");

const BOARD = "default";
const filter = { HashRangePrefix: { hash: BOARD, prefix: "done#" } };
const fields = boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS]);

type Res = { status: number; rows: number; total: number | null; first: string; last: string; ms: number; err?: string };

async function q(extra: Record<string, unknown>): Promise<Res> {
  const t0 = performance.now();
  const res = await node.rawCall("POST", "/api/query", {
    schema_name: schemaHash,
    fields,
    filter,
    ...extra,
  });
  const ms = performance.now() - t0;
  const raw = res.body;
  // A rejected param comes back as a bare text body ("Bad request: …"), not
  // JSON — so the parse itself must not be what fails the probe.
  let body: Record<string, unknown> = {};
  if (typeof raw === "string") {
    try {
      body = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      body = { _text: raw };
    }
  } else {
    body = (raw ?? {}) as Record<string, unknown>;
  }
  if (res.status !== 200) {
    return { status: res.status, rows: 0, total: null, first: "", last: "", ms, err: JSON.stringify(body).slice(0, 120) };
  }
  const rows = (body.results ?? body.rows ?? []) as Array<Record<string, unknown>>;
  const rangeOf = (r: Record<string, unknown> | undefined): string => {
    const key = (r?.key ?? null) as Record<string, unknown> | null;
    return String(key?.range ?? "?");
  };
  return {
    status: res.status,
    rows: rows.length,
    total: (body.total_count as number | undefined) ?? null,
    first: rangeOf(rows[0]),
    last: rangeOf(rows[rows.length - 1]),
    ms,
  };
}

// Ground truth: the whole column, in the node's natural order.
const full = await q({ limit: 1000 });
console.log(`ground truth: rows=${full.rows} total=${full.total}`);
console.log(`  head sk = ${full.first}`);
console.log(`  tail sk = ${full.last}\n`);

const LIMIT = 12;
const head = await q({ limit: LIMIT });
console.log(`limit=${LIMIT} (head page)      rows=${head.rows} total=${head.total} first=${head.first} ${head.ms.toFixed(0)}ms`);
console.log(`  -> ${head.first === full.first ? "HEAD, as expected" : "unexpected order"}\n`);

console.log("candidate one-round-trip tail spellings:");
for (const [label, extra] of [
  ["reverse:true", { limit: LIMIT, reverse: true }],
  ["descending:true", { limit: LIMIT, descending: true }],
  ["order:desc", { limit: LIMIT, order: "desc" }],
  ["sort:desc", { limit: LIMIT, sort: "desc" }],
  ["scan_forward:false", { limit: LIMIT, scan_forward: false }],
  ["scan_index_forward:false", { limit: LIMIT, scan_index_forward: false }],
] as const) {
  const r = await q(extra as Record<string, unknown>);
  const verdict =
    r.status !== 200
      ? `HTTP ${r.status} ${r.err ?? ""}`
      : r.first === full.last
        ? "*** TAIL — one round trip works ***"
        : r.first === full.first
          ? "ignored (still head)"
          : `unknown order (first=${r.first})`;
  console.log(`  ${label.padEnd(26)} rows=${String(r.rows).padStart(3)} ${r.ms.toFixed(0).padStart(4)}ms  ${verdict}`);
}

console.log("\ntwo-round-trip fallback (count probe, then offset page):");
const t0 = performance.now();
const countProbe = await q({ limit: 1 });
const offset = Math.max(0, (countProbe.total ?? 0) - LIMIT);
const tail = await q({ limit: LIMIT, offset });
const twoRt = performance.now() - t0;
console.log(`  count probe limit=1        total=${countProbe.total} ${countProbe.ms.toFixed(0)}ms`);
console.log(`  tail page offset=${offset}       rows=${tail.rows} first=${tail.first} last=${tail.last} ${tail.ms.toFixed(0)}ms`);
console.log(`  -> ${tail.last === full.last ? "TAIL matches ground truth" : "MISMATCH"} — ${twoRt.toFixed(0)}ms serial`);
