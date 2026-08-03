#!/usr/bin/env bun
/**
 * READ-ONLY probe: WHERE does the 76% duplication come from — overlapping
 * pages, or duplicate rows inside a single page?
 *
 * `scripts/probe-scan-duplicates-and-completeness.ts` measured the Card body
 * drain at 1539 rows / 373 distinct / 18 pages. The arithmetic already hints
 * at the answer and it is worth being exact about, because it decides whose
 * bug this is:
 *
 *   - If pages OVERLAP, the client's advance rule (`offset = rows.length`)
 *     disagrees with the node's `offset` semantics — a client-side fix.
 *   - If ONE page contains the same slug twice, no advance rule can help; the
 *     node is serving duplicate rows within a single response — a node bug,
 *     and `kanban` can only stop paying for it.
 *
 * Page 1 alone returns 537 rows while the WHOLE 18-page drain yields 373
 * distinct slugs, so page 1 cannot be duplicate-free. Measured rather than
 * inferred, and reported per page.
 *
 * Also measures the alternative kanban could adopt: bounded-concurrency point
 * reads over known board membership, which is exact by construction.
 *
 * Run: bun scripts/probe-scan-duplicate-locus.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCardsByFilter, findCard } from "../src/record.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const sock = cfg.nodeSocketPath;
const cardHash = schemaHashFor("card", cfg);

async function rawPage(offset: number, limit: number): Promise<{ slugs: string[]; hasMore: boolean; total: number; ms: number }> {
  const t0 = performance.now();
  const res = await fetch("http://localhost/api/query", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-LastDB-Client": "kanban",
      "X-LastDB-Allow-Full-Scan": "1",
    },
    body: JSON.stringify({ schema_name: cardHash, fields: ["slug", "body"], offset, limit }),
    // @ts-expect-error Bun unix option
    unix: sock,
  });
  const ms = performance.now() - t0;
  const j = (await res.json()) as {
    results?: Array<Record<string, unknown>>;
    has_more?: boolean;
    total_count?: number;
  };
  const slugs = (j.results ?? []).map((r) => {
    const f = (r.fields ?? r) as Record<string, unknown>;
    return String(f.slug ?? (r as Record<string, unknown>).slug ?? "?");
  });
  return { slugs, hasMore: Boolean(j.has_more), total: Number(j.total_count ?? -1), ms };
}

console.log("=== per-page duplication (client's own advance rule) ===");
console.log("page   rows  distinct  dup-in-page  new-vs-prior  offset");
let offset = 0;
const seen = new Set<string>();
let totalRows = 0;
for (let p = 1; p <= 20; p++) {
  const { slugs, hasMore } = await rawPage(offset, 1000);
  const inPage = new Set(slugs);
  const fresh = slugs.filter((s) => !seen.has(s));
  const freshDistinct = new Set(fresh);
  console.log(
    `${String(p).padStart(4)}  ${String(slugs.length).padStart(5)}  ${
      String(inPage.size).padStart(8)
    }  ${String(slugs.length - inPage.size).padStart(11)}  ${
      String(freshDistinct.size).padStart(12)
    }  ${String(offset).padStart(6)}`,
  );
  for (const s of slugs) seen.add(s);
  totalRows += slugs.length;
  if (!hasMore || slugs.length === 0) break;
  offset += slugs.length;
}
console.log(`\n  total rows=${totalRows}  distinct=${seen.size}  duplicates=${totalRows - seen.size}`);

// --- The alternative: exact reads over known membership -------------------
console.log("\n=== alternative: bounded-concurrency point reads over board membership ===");
const live = await listCardsByFilter(node0(), cfg, {}, ["slug", "board", "column"], {
  allowFullScanFallback: false,
});
function node0() {
  return newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: cfg.nodeSocketPath });
}
const slugs = live.cards.map((c) => c.slug);
console.log(`  board membership: ${slugs.length} cards (1 request)`);

for (const conc of [16, 32, 64]) {
  const node = node0();
  const t0 = performance.now();
  const cards = await mapWithConcurrency(slugs, (s) => findCard(node, cfg, s), conc);
  const ms = performance.now() - t0;
  const withBody = cards.filter((c) => (c?.body?.length ?? 0) > 0).length;
  console.log(
    `  concurrency=${String(conc).padStart(3)}  ${slugs.length} point reads  ${
      ms.toFixed(0).padStart(5)
    }ms  bodies=${withBody}  (~${Math.ceil(slugs.length / conc)} waves)`,
  );
}
