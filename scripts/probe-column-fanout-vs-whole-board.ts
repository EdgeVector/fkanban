#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does a per-column dashboard sweep cost against the one
 * whole-board read that answers the same question?
 *
 * `lastdb ops` has named `client=kanban kind=query schema=board_cards` the top
 * PRODUCT consumer of node wall time for several runs, and the open question
 * was never the per-call cost (run (o) retired that) but the CALL COUNT. A
 * process sampler on 2026-08-04 answered it: the calls arrive in bursts of four
 * sibling `kanban list --column <col> --json` processes — backlog, todo, doing,
 * done — which is `ops-terminal/server.ts:collectKanban()` polling the board.
 *
 * That caller wants two things: a count for every column, and the card metadata
 * for the three live ones. A bare `list --json` already returns exactly that,
 * in one command. So the comparison that matters is not "is a column read
 * cheaper than a whole-partition read" — it is "four column reads against one
 * whole-board read", and the fan-out pays its per-read floor four times over
 * for a strictly SMALLER answer.
 *
 * Counts client-side, so the fleet's concurrent traffic cannot pollute it.
 *
 * Run: bun scripts/probe-column-fanout-vs-whole-board.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { listCmd } from "../src/commands/list.ts";

const cfg = readConfig();
const SCHEMA_NAME = new Map<string, string>(
  Object.entries(cfg.schemaHashes ?? {}).map(([name, hash]) => [hash as string, name]),
);

type Call = { schema: string; filter: string; rows: number; ms: number };

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
        rows: res.results.length,
        ms: performance.now() - t0,
      });
      return res;
    },
  });
  return { node: wrapped, calls };
}

const mk = () =>
  instrument(
    newNodeClient({
      baseUrl: cfg.nodeUrl,
      userHash: cfg.userHash,
      socketPath: cfg.nodeSocketPath,
    }),
  );

function summarize(label: string, calls: Call[], wallMs: number): void {
  const rows = calls.reduce((a, c) => a + c.rows, 0);
  console.log(`\n=== ${label}`);
  for (const c of calls) {
    console.log(
      `  ${c.schema.padEnd(14)} ${c.filter.padEnd(40)} rows=${String(c.rows).padStart(4)} ${
        c.ms.toFixed(0).padStart(5)
      }ms`,
    );
  }
  console.log(
    `  TOTAL queries=${calls.length} rows=${rows} nodeMs=${
      calls.reduce((a, c) => a + c.ms, 0).toFixed(0)
    } wall=${wallMs.toFixed(0)}ms`,
  );
}

const REPS = Number(process.env.REPS || 5);

// --- A: the ops-terminal pattern — four column reads, one per column ---
// Each is a SEPARATE process in production (a fresh `kanban` CLI spawn), so a
// fresh client per column is the honest model of it; sharing one would hide the
// per-connection cost the real caller pays four times.
const COLUMNS = ["backlog", "todo", "doing", "done"] as const;

const fanout: Array<{ queries: number; rows: number; wall: number }> = [];
const whole: Array<{ queries: number; rows: number; wall: number }> = [];

for (let rep = 0; rep < REPS; rep++) {
  {
    const t0 = performance.now();
    const all: Call[] = [];
    // Production spawns these four CONCURRENTLY (`Promise.all` over the columns).
    const results = await Promise.all(
      COLUMNS.map(async (column) => {
        const { node, calls } = mk();
        await listCmd({ cfg, node, column, json: true });
        return calls;
      }),
    );
    for (const calls of results) all.push(...calls);
    const wall = performance.now() - t0;
    if (rep === 0) summarize("A: four `list --column <col> --json` (ops-terminal today)", all, wall);
    fanout.push({ queries: all.length, rows: all.reduce((a, c) => a + c.rows, 0), wall });
  }

  {
    const { node, calls } = mk();
    const t0 = performance.now();
    await listCmd({ cfg, node, json: true });
    const wall = performance.now() - t0;
    if (rep === 0) summarize("B: one bare `list --json` (same information)", calls, wall);
    whole.push({ queries: calls.length, rows: calls.reduce((a, c) => a + c.rows, 0), wall });
  }
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;

console.log(`\n=== verdict over ${REPS} reps (median wall)`);
console.log(
  `  A fan-out : queries=${fanout[0]!.queries} rows=${fanout[0]!.rows} wall=${
    med(fanout.map((r) => r.wall)).toFixed(0)
  }ms`,
);
console.log(
  `  B whole   : queries=${whole[0]!.queries} rows=${whole[0]!.rows} wall=${
    med(whole.map((r) => r.wall)).toFixed(0)
  }ms`,
);
console.log(
  `  ratio     : queries=${(fanout[0]!.queries / whole[0]!.queries).toFixed(1)}x  wall=${
    (med(fanout.map((r) => r.wall)) / med(whole.map((r) => r.wall))).toFixed(2)
  }x`,
);
console.log(
  `\n  NOTE: A also pays 4 process spawns (bun boot + config + socket connect)\n` +
    `  that this in-process probe does NOT charge it. The production gap is wider.`,
);
