#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does each hot kanban command actually ask the node for?
 *
 * `lastdb ops` says BoardCards under client=kanban is the #1 consumer of node
 * wall time system-wide, but it cannot say WHICH command issues those reads,
 * how wide the projection is, or how many rows come back. This wraps the node
 * client and counts, per command:
 *
 *   - one line per query: schema, filter shape, projected field count, rows, ms
 *
 * Client-side counting, so the fleet's concurrent traffic cannot pollute it
 * (an `lastdb ops` delta around a command cannot say the same).
 *
 * Run: bun scripts/probe-command-reads.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import { overlapResult } from "../src/commands/overlap.ts";
import { listCmd } from "../src/commands/list.ts";

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

function report(label: string, calls: Call[], totalMs: number): void {
  console.log(`\n=== ${label} — ${calls.length} queries, ${totalMs.toFixed(0)}ms wall`);
  const bySchema = new Map<string, { n: number; rows: number; ms: number }>();
  for (const c of calls) {
    console.log(
      `  ${c.schema.padEnd(16)} ${c.filter.padEnd(34)} fields=${String(c.fields).padStart(2)} ` +
        `rows=${String(c.rows).padStart(4)} ${c.ms.toFixed(0).padStart(5)}ms`,
    );
    const agg = bySchema.get(c.schema) ?? { n: 0, rows: 0, ms: 0 };
    agg.n += 1;
    agg.rows += c.rows;
    agg.ms += c.ms;
    bySchema.set(c.schema, agg);
  }
  console.log("  --- per schema ---");
  for (const [s, a] of [...bySchema.entries()].sort((x, y) => y[1].ms - x[1].ms)) {
    console.log(
      `  ${s.padEnd(16)} calls=${String(a.n).padStart(3)} rows=${String(a.rows).padStart(5)} ` +
        `${a.ms.toFixed(0).padStart(6)}ms`,
    );
  }
}

const mk = () =>
  instrument(
    newNodeClient({
      baseUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      socketPath: cfg.nodeSocketPath,
    }),
  );

// --- pickup status: the fleet's hottest read (kanban-pickup, ~2930 runs) ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await pickupStatusResult({ cfg, node });
  report("kanban pickup status", calls, performance.now() - t0);
}

// --- list (bare, text): the human/agent board read ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await listCmd({ cfg, node });
  report("kanban list (bare text)", calls, performance.now() - t0);
}

// --- list --column todo: the pickup frontier read ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await listCmd({ cfg, node, column: "todo" });
  report("kanban list --column todo", calls, performance.now() - t0);
}

// --- overlap: the claim-collision gate ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  const todo = await listCmd({ cfg, node, column: "todo", json: true });
  const first = (JSON.parse(todo) as { cards?: Array<{ slug: string }> }).cards?.[0]?.slug;
  calls.length = 0;
  if (first) {
    const t1 = performance.now();
    await overlapResult({ cfg, node, slug: first });
    report(`kanban overlap ${first}`, calls, performance.now() - t1);
  } else {
    console.log("\n(no todo card to probe overlap with)");
  }
  void t0;
}
