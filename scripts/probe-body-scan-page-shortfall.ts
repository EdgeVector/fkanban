#!/usr/bin/env bun
/**
 * READ-ONLY probe: why does a `limit=1000` page of the Card body scan come
 * back with ~60 rows, forcing `kanban search` into 16 serial round trips?
 *
 * `scripts/probe-paged-scan-concurrency.ts` ruled out the obvious fix: pages
 * are NOT independently addressable (a fixed-offset concurrent fan-out
 * recovered 113 of ~1500 rows, so it would silently lose data). Before
 * proposing anything else, the shortfall itself has to be explained rather
 * than routed around.
 *
 * Hypothesis: the node drops rows whose projected fields have no atom, AFTER
 * applying `limit` to the scan. `lastdb status` reports `Read integrity:
 * DEGRADED — 1864 query row(s) dropped this process because their tip pointed
 * at a missing atom`, and this repo's own `cardExists` doc states a row comes
 * back only when EVERY projected field resolves. If so, the page shortfall is
 * a function of the PROJECTION, not of paging — and a 1-field scan of the same
 * schema should page normally.
 *
 * Decisive comparison: same schema, same offsets, only the projection differs.
 *
 * Run: bun scripts/probe-body-scan-page-shortfall.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";

const cfg = readConfig();
const sock = cfg.nodeSocketPath;
const cardHash = schemaHashFor("card", cfg);

type Page = {
  rows: number;
  returned: number;
  total: number;
  hasMore: boolean;
  ms: number;
};

async function page(fields: string[], offset: number, limit: number): Promise<Page> {
  const t0 = performance.now();
  const res = await fetch("http://localhost/api/query", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-LastDB-Client": "kanban",
      "X-LastDB-Allow-Full-Scan": "1",
    },
    body: JSON.stringify({ schema_name: cardHash, fields, offset, limit }),
    // @ts-expect-error Bun unix option
    unix: sock,
  });
  const ms = performance.now() - t0;
  const j = (await res.json()) as Record<string, unknown>;
  return {
    rows: Array.isArray(j.results) ? j.results.length : -1,
    returned: Number(j.returned_count ?? -1),
    total: Number(j.total_count ?? -1),
    hasMore: Boolean(j.has_more),
    ms,
  };
}

console.log("=== projection width vs page yield (offset=0, limit=1000) ===");
for (const fields of [["slug"], ["slug", "column"], ["slug", "title"], ["slug", "body"], ["body"]]) {
  const p = await page(fields, 0, 1000);
  console.log(
    `  fields=[${fields.join(",").padEnd(12)}]  rows=${String(p.rows).padStart(4)}  returned_count=${
      String(p.returned).padStart(4)
    }  total_count=${String(p.total).padStart(4)}  has_more=${p.hasMore}  ${p.ms.toFixed(0)}ms`,
  );
}

console.log("\n=== does `limit` bound POSITIONS SCANNED or ROWS RETURNED? ===");
console.log("    slug-only (every row resolves) vs slug+body (many do not)");
for (const fields of [["slug"], ["slug", "body"]]) {
  const out: string[] = [];
  for (const limit of [10, 50, 100, 500, 1000]) {
    const p = await page(fields, 0, limit);
    out.push(`${limit}->${p.rows}`);
  }
  console.log(`  fields=[${fields.join(",").padEnd(12)}]  limit->rows:  ${out.join("  ")}`);
}

console.log("\n=== full serial drain, both projections (real client's advance rule) ===");
for (const fields of [["slug"], ["slug", "body"]]) {
  const t0 = performance.now();
  let offset = 0;
  let pages = 0;
  let rows = 0;
  for (;;) {
    const p = await page(fields, offset, 1000);
    pages++;
    rows += p.rows;
    if (!p.hasMore || p.rows === 0 || pages > 60) break;
    offset += p.rows; // exactly what queryAllPaged does: offset = rows.length
  }
  console.log(
    `  fields=[${fields.join(",").padEnd(12)}]  pages=${String(pages).padStart(3)}  rows=${
      String(rows).padStart(5)
    }  ${(performance.now() - t0).toFixed(0)}ms`,
  );
}
