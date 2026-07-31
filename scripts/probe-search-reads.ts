#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does `kanban search` actually ask the node for?
 *
 * `search` is the agent fleet's discovery command (CLI + the `fkanban_search`
 * MCP tool) and is the last hot read command nobody has profiled. Ten prior
 * chief-engineer runs measured `pickup status`, `list`, `overlap`, `doctor`,
 * `add` and the six milestone reads; `scripts/probe-command-reads.ts` and
 * `scripts/probe-milestone-reads.ts` cover exactly those.
 *
 * Same shape as those two: wrap the node client, count one line per query
 * (schema, filter shape, projected field count, rows, ms). Client-side
 * counting, so the fleet's concurrent traffic cannot pollute the numbers.
 *
 * Run: bun scripts/probe-search-reads.ts [query ...]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { searchResult } from "../src/commands/search.ts";

const cfg = readConfig();
const SCHEMA_NAME = new Map<string, string>(
  Object.entries(cfg.schemaHashes ?? {}).map(([name, hash]) => [hash as string, name]),
);

type Call = { schema: string; filter: string; fields: number; rows: number; ms: number };

function instrument(node: NodeClient): { node: NodeClient; calls: Call[] } {
  const calls: Call[] = [];
  const realQueryAll = node.queryAll.bind(node);
  const wrapped: NodeClient = Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const t0 = performance.now();
      const res = await realQueryAll(args);
      const f = (args as { filter?: Record<string, unknown> }).filter;
      let filter = "FULL_SCAN";
      if (f) {
        const key = Object.keys(f)[0] ?? "?";
        const v = f[key];
        filter =
          typeof v === "object" && v !== null
            ? `${key}(${Object.values(v as Record<string, unknown>).join(",")})`
            : `${key}(${String(v)})`;
      }
      calls.push({
        schema: SCHEMA_NAME.get((args as { schemaHash: string }).schemaHash) ??
          (args as { schemaHash: string }).schemaHash.slice(0, 8),
        filter,
        fields: ((args as { fields?: string[] }).fields ?? []).length,
        rows: res.results.length,
        ms: performance.now() - t0,
      });
      return res;
    },
  });
  return { node: wrapped, calls };
}

function report(label: string, calls: Call[], totalMs: number, extra?: string): void {
  console.log(`\n=== ${label} — ${calls.length} queries, ${totalMs.toFixed(0)}ms wall${extra ? ` ${extra}` : ""}`);
  // Point reads dominate the line count; roll identical (schema, fields) shapes
  // up so the table stays readable while the per-schema totals stay exact.
  const byShape = new Map<string, { n: number; rows: number; ms: number; filter: string }>();
  for (const c of calls) {
    const key = `${c.schema}|${c.fields}|${c.filter.split("(")[0]}`;
    const agg = byShape.get(key) ?? { n: 0, rows: 0, ms: 0, filter: c.filter.split("(")[0] ?? "?" };
    agg.n += 1;
    agg.rows += c.rows;
    agg.ms += c.ms;
    byShape.set(key, agg);
  }
  console.log("  shape (schema / filter / projected fields)                 calls   rows      ms");
  for (const [key, a] of [...byShape.entries()].sort((x, y) => y[1].ms - x[1].ms)) {
    const [schema, fields, filter] = key.split("|");
    console.log(
      `  ${(schema ?? "?").padEnd(16)} ${(filter ?? "?").padEnd(22)} f=${String(fields).padStart(2)}  ` +
        `${String(a.n).padStart(5)}  ${String(a.rows).padStart(5)}  ${a.ms.toFixed(0).padStart(6)}ms`,
    );
  }
  const totalNode = calls.reduce((s, c) => s + c.ms, 0);
  console.log(`  --- ${calls.length} queries, ${totalNode.toFixed(0)}ms total node time ---`);
}

const mk = () =>
  instrument(
    newNodeClient({
      baseUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      socketPath: cfg.nodeSocketPath,
    }),
  );

const queries = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["lastdb", "reconcile"];

for (const q of queries) {
  const { node, calls } = mk();
  const t0 = performance.now();
  const res = await searchResult({ cfg, node, query: q });
  report(`kanban search "${q}"`, calls, performance.now() - t0, `→ ${res.cards.length} matches`);
}

// Complete mode: the historical exhaustive body scan, for comparison.
{
  const q = queries[0] ?? "lastdb";
  const { node, calls } = mk();
  const t0 = performance.now();
  const res = await searchResult({ cfg, node, query: q, complete: true });
  report(`kanban search "${q}" --complete`, calls, performance.now() - t0, `→ ${res.cards.length} matches`);
}
