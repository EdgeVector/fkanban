#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does the milestone command family ask the node for?
 * Mirrors scripts/probe-command-reads.ts, for the unprofiled milestone surface.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import {
  milestoneListResult,
  milestonePortfolioResult,
  milestoneGroomResult,
  milestoneDetailResult,
  milestoneReconcileResult,
} from "../src/commands/milestone.ts";

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
        schema:
          SCHEMA_NAME.get((args as { schemaHash: string }).schemaHash) ??
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
  const byShape = new Map<string, { n: number; rows: number; ms: number }>();
  for (const c of calls) {
    const agg = bySchema.get(c.schema) ?? { n: 0, rows: 0, ms: 0 };
    agg.n += 1;
    agg.rows += c.rows;
    agg.ms += c.ms;
    bySchema.set(c.schema, agg);
    const shapeKey = `${c.schema} ${c.filter.replace(/\(.*\)/, "(…)")} fields=${c.fields}`;
    const s = byShape.get(shapeKey) ?? { n: 0, rows: 0, ms: 0 };
    s.n += 1;
    s.rows += c.rows;
    s.ms += c.ms;
    byShape.set(shapeKey, s);
  }
  console.log("  --- by call shape ---");
  for (const [s, a] of [...byShape.entries()].sort((x, y) => y[1].ms - x[1].ms)) {
    console.log(
      `  ${s.padEnd(58)} calls=${String(a.n).padStart(3)} rows=${String(a.rows).padStart(6)} ${a.ms.toFixed(0).padStart(6)}ms`,
    );
  }
  console.log("  --- per schema ---");
  for (const [s, a] of [...bySchema.entries()].sort((x, y) => y[1].ms - x[1].ms)) {
    console.log(
      `  ${s.padEnd(20)} calls=${String(a.n).padStart(3)} rows=${String(a.rows).padStart(6)} ${a.ms.toFixed(0).padStart(6)}ms`,
    );
  }
}

const mk = () =>
  instrument(
    newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: cfg.nodeSocketPath }),
  );

{
  const { node, calls } = mk();
  const t0 = performance.now();
  const r = await milestoneListResult({ cfg, node });
  report(`milestone list (${r.milestones.length} milestones)`, calls, performance.now() - t0);
}

{
  const { node, calls } = mk();
  const t0 = performance.now();
  const r = await milestonePortfolioResult({ cfg, node });
  report(`milestone portfolio (${r.entries.length} entries)`, calls, performance.now() - t0);
}

{
  const { node, calls } = mk();
  const t0 = performance.now();
  const r = await milestoneGroomResult({ cfg, node });
  report(`milestone groom (${r.issues.length} issues)`, calls, performance.now() - t0);
}

{
  const probe = mk();
  const list = await milestoneListResult({ cfg, node: probe.node });
  const slug = list.milestones[0]?.slug;
  if (slug) {
    {
      const { node, calls } = mk();
      const t0 = performance.now();
      await milestoneReconcileResult({ cfg, node, slug });
      report(`milestone reconcile ${slug}`, calls, performance.now() - t0);
    }
    {
      const { node, calls } = mk();
      const t0 = performance.now();
      await milestoneDetailResult({ cfg, node, slug });
      report(`milestone detail ${slug}`, calls, performance.now() - t0);
    }
  }
}
