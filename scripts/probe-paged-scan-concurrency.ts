#!/usr/bin/env bun
/**
 * READ-ONLY probe: can the `/api/query` pagination loop be issued CONCURRENTLY?
 *
 * `scripts/probe-search-wave-payloads.ts` showed `kanban search` walking a
 * 1539-row Card body scan in 16 SERIAL pages. The client asks `limit=1000`
 * every time; the node returns ~55-63 rows, so it is byte-capping, and the
 * loop then feeds each response's row count into the next `offset`. That data
 * dependency — offset N+1 is unknowable until page N returns — is the ONLY
 * reason the pages are serial, and at ~190ms fixed per request it is the whole
 * 3.2s.
 *
 * Two things have to be true to break it, and neither is safe to assume:
 *
 *   Q1. Does the node report a TRUE total for the filter, so the page count is
 *       knowable up front? (Run (e) found `total_count` is computed on every
 *       query and read nowhere in `src/` — verify it holds for a FULL_SCAN.)
 *   Q2. Does a SMALL explicit `limit` come back EXACTLY full? If the node
 *       byte-caps below the asked-for limit, offsets stay unpredictable and no
 *       amount of total-count knowledge makes the pages independent.
 *
 * Q2 is the one that decides it. Q1 without Q2 buys nothing.
 *
 * Run: bun scripts/probe-paged-scan-concurrency.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";

const cfg = readConfig();
const sock = cfg.nodeSocketPath;
const cardHash = schemaHashFor("card", cfg);

async function rawQuery(
  body: Record<string, unknown>,
): Promise<{ rows: number; total: unknown; keys: string[]; ms: number; status: number }> {
  const t0 = performance.now();
  const res = await fetch("http://localhost/api/query", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-LastDB-Client": "kanban",
      "X-LastDB-Allow-Full-Scan": "1",
    },
    body: JSON.stringify(body),
    // @ts-expect-error Bun unix option
    unix: sock,
  });
  const ms = performance.now() - t0;
  const text = await res.text();
  let j: Record<string, unknown> = {};
  try {
    j = JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { rows: -1, total: `HTTP ${res.status}: ${text.slice(0, 120)}`, keys: [], ms, status: res.status };
  }
  const results = Array.isArray(j.results) ? j.results : Array.isArray(j.rows) ? j.rows : [];
  return {
    rows: results.length,
    total: j.total_count ?? j.totalCount ?? j.total ?? null,
    keys: Object.keys(j),
    ms,
    status: res.status,
  };
}

const base = {
  schema_name: cardHash,
  fields: ["slug", "body"],
};

console.log("=== Q1: does a FULL_SCAN page report a true total? ===");
for (const limit of [1, 10, 50, 1000]) {
  const r = await rawQuery({ ...base, offset: 0, limit });
  console.log(
    `  limit=${String(limit).padStart(4)}  rows=${String(r.rows).padStart(4)}  total=${
      String(r.total).padStart(6)
    }  ${r.ms.toFixed(0)}ms  keys=[${r.keys.join(",")}]`,
  );
}

console.log("\n=== Q2: does a small explicit limit come back EXACTLY full? ===");
console.log("    (if rows < limit at a mid-scan offset, the node is byte-capping");
console.log("     and offsets stay unpredictable -> pages cannot be independent)");
for (const limit of [10, 25, 50, 100, 200]) {
  const offsets = [0, 300, 600, 900, 1200];
  const got = await Promise.all(offsets.map((offset) => rawQuery({ ...base, offset, limit })));
  const exact = got.every((g) => g.rows === limit);
  console.log(
    `  limit=${String(limit).padStart(4)}  rows@${offsets.join("/")} = ${
      got.map((g) => g.rows).join("/")
    }  ${exact ? "EXACT ✓" : "SHORT ✗ (byte-capped)"}`,
  );
}

console.log("\n=== Q3: serial vs concurrent, same 1539-row scan ===");
// Serial, mimicking queryAllPaged: advance offset by rows returned.
{
  const t0 = performance.now();
  let offset = 0;
  let pages = 0;
  let rows = 0;
  for (;;) {
    const r = await rawQuery({ ...base, offset, limit: 1000 });
    pages++;
    rows += r.rows;
    if (r.rows === 0) break;
    offset += r.rows;
    if (pages > 40) break;
  }
  console.log(`  serial (limit=1000, node-sized): ${pages} pages, ${rows} rows, ${(performance.now() - t0).toFixed(0)}ms`);
}
// Concurrent, using total + a fixed page size.
for (const pageSize of [50, 100]) {
  const first = await rawQuery({ ...base, offset: 0, limit: pageSize });
  const total = Number(first.total ?? 0);
  if (!total) {
    console.log(`  concurrent (limit=${pageSize}): no usable total — SKIPPED`);
    continue;
  }
  const t0 = performance.now();
  const offsets: number[] = [];
  for (let o = pageSize; o < total; o += pageSize) offsets.push(o);
  const rest = await Promise.all(offsets.map((offset) => rawQuery({ ...base, offset, limit: pageSize })));
  const rows = first.rows + rest.reduce((a, r) => a + r.rows, 0);
  console.log(
    `  concurrent (limit=${pageSize}, total=${total}): ${1 + offsets.length} pages, ${rows} rows, ${
      (performance.now() - t0).toFixed(0)
    }ms (+1 lead page)`,
  );
}
