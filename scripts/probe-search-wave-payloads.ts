#!/usr/bin/env bun
/**
 * READ-ONLY probe: WHAT does each serial wave of `kanban search` ask for?
 *
 * `scripts/probe-round-trip-depth.ts` measured `search` at 18 waves / 3.8s —
 * waves 2..16 are fifteen consecutive SINGLE-request waves, i.e. a pure serial
 * chain, ~3.2s of the total at this node's ~190ms fixed per-request cost. The
 * two batched waves (6 and 16 concurrent) are already right.
 *
 * The depth probe only records paths, and every request is `/api/query`. This
 * one records the request BODY — schema, filter, offset/limit, projected field
 * count — plus the row count returned, so the chain can be named.
 *
 * Run: bun scripts/probe-search-wave-payloads.ts [query]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg = readConfig();
const SCHEMA_NAME = new Map<string, string>(
  Object.entries(cfg.schemaHashes ?? {}).map(([name, hash]) => [hash as string, name]),
);

type Rec = { start: number; end: number; desc: string; rows: number };
const recs: Rec[] = [];
let recording = false;

const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  if (!recording) return realFetch(input as Parameters<typeof realFetch>[0], init);
  const start = performance.now();
  const res = await realFetch(input as Parameters<typeof realFetch>[0], init);
  const end = performance.now();

  let desc = String(init?.method ?? "GET") + " " +
    String(typeof input === "string" ? input : (input as Request).url).replace(
      /^https?:\/\/[^/]+/,
      "",
    );
  let rows = -1;
  try {
    const body = typeof init?.body === "string" ? JSON.parse(init.body) : null;
    if (body && typeof body === "object") {
      const b = body as Record<string, unknown>;
      const schema = typeof b.schema === "string"
        ? (SCHEMA_NAME.get(b.schema) ?? b.schema.slice(0, 8))
        : "?";
      const filter = b.filter ? JSON.stringify(b.filter) : "FULL_SCAN";
      const fields = Array.isArray(b.fields) ? b.fields.length : 0;
      desc = `${schema} filter=${filter} fields=${fields} offset=${
        String(b.offset ?? "-")
      } limit=${String(b.limit ?? "-")}`;
    }
  } catch { /* non-JSON body */ }

  // Read the response without consuming it for the caller.
  try {
    const clone = res.clone();
    const j = (await clone.json()) as { results?: unknown[] };
    if (Array.isArray(j.results)) rows = j.results.length;
  } catch { /* not JSON */ }

  recs.push({ start, end, desc, rows });
  return res;
}) as typeof fetch;

const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const query = process.argv[2] ?? "kanban";

// Warm the process so lazy attestation is not billed into wave 1.
await searchResult({ cfg, node, query: "zzzznomatchzzzz" });

recs.length = 0;
recording = true;
const t0 = performance.now();
const out = await searchResult({ cfg, node, query });
const wall = performance.now() - t0;
recording = false;

console.log(`search "${query}" -> ${out.cards.length} matches, ${wall.toFixed(0)}ms, ${recs.length} requests\n`);

// Group into waves the same way the depth probe does.
const sorted = [...recs].sort((a, b) => a.start - b.start);
let waveNo = 1;
let waveEnd = sorted[0]!.end;
const buckets: Rec[][] = [[]];
for (const r of sorted) {
  if (r.start >= waveEnd && buckets[waveNo - 1]!.length) {
    waveNo++;
    buckets.push([]);
    waveEnd = r.end;
  } else {
    waveEnd = Math.max(waveEnd, r.end);
  }
  buckets[waveNo - 1]!.push(r);
}

for (const [i, b] of buckets.entries()) {
  const span = Math.max(...b.map((r) => r.end)) - Math.min(...b.map((r) => r.start));
  console.log(`wave ${String(i + 1).padStart(2)}  n=${String(b.length).padStart(2)}  ${span.toFixed(0).padStart(5)}ms`);
  const tally = new Map<string, { n: number; rows: number }>();
  for (const r of b) {
    const cur = tally.get(r.desc) ?? { n: 0, rows: 0 };
    tally.set(r.desc, { n: cur.n + 1, rows: cur.rows + Math.max(r.rows, 0) });
  }
  for (const [desc, t] of tally) {
    console.log(`         ${t.n > 1 ? `x${t.n} ` : "   "}rows=${String(t.rows).padStart(4)}  ${desc}`);
  }
}
