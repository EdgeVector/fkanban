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
import { searchResult } from "../src/commands/search.ts";
import { showResult } from "../src/commands/show.ts";
import { milestonePortfolioResult } from "../src/commands/milestone.ts";
import { archiveDoneResult } from "../src/commands/archive_done.ts";

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

/**
 * First todo slug, from `listCmd(--json)`'s ACTUAL shape.
 *
 * `list --json` renders a BARE ARRAY of cards. The overlap arm used to read
 * `JSON.parse(todo).cards?.[0]?.slug`, which is `undefined` for an array — so
 * on a board with 14 todo cards it took the else branch and printed "(no todo
 * card to probe overlap with)". That arm had therefore never once run since it
 * was written, and it announced the fact as a property of the BOARD rather than
 * of the parse. A probe that cannot find its subject must not report an empty
 * board; that is the failure mode this whole script exists to catch elsewhere.
 *
 * Accepts both shapes so a future move to `{cards: […]}` does not silently
 * re-disarm the arm.
 */
function firstTodoSlug(json: string): string | undefined {
  const parsed = JSON.parse(json) as unknown;
  const cards = Array.isArray(parsed)
    ? (parsed as Array<{ slug?: string }>)
    : ((parsed as { cards?: Array<{ slug?: string }> }).cards ?? []);
  return cards[0]?.slug;
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
  const first = firstTodoSlug(todo);
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

// --- search: the agent's "has this already been filed?" read, run before
//     nearly every card write by the dedupe convention ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await searchResult({ cfg, node, query: "lastdb" });
  report('kanban search "lastdb"', calls, performance.now() - t0);
}

// --- show: the single-card read every agent makes before editing a body ---
{
  const { node, calls } = mk();
  const todo = await listCmd({ cfg, node, column: "todo", json: true });
  const first = firstTodoSlug(todo);
  calls.length = 0;
  if (first) {
    const t0 = performance.now();
    await showResult({ cfg, node, slug: first });
    report(`kanban show ${first}`, calls, performance.now() - t0);
  } else {
    console.log("\n(no todo card to probe show with)");
  }
}

// --- milestone portfolio: the rollup the milestone driver polls ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await milestonePortfolioResult({ cfg, node });
  report("kanban milestone portfolio", calls, performance.now() - t0);
}

// --- groom archive-done (DRY RUN, no writes): the scheduled sweep that reads
//     every board's terminal column plus a dependency reach over live cards ---
{
  const { node, calls } = mk();
  const t0 = performance.now();
  await archiveDoneResult({ cfg, node });
  report("kanban groom archive-done (dry-run)", calls, performance.now() - t0);
}
