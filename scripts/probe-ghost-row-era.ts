#!/usr/bin/env bun
/**
 * READ-ONLY probe: is the dep-target correlation causal, or is AGE the
 * confounder?
 *
 * Ghost slugs are 6x enriched among dependency targets (55% vs 9%). But dep
 * targets are also older cards on average, and the 8 most recently created
 * cards all have exactly one row. If every ghost's real row predates some date
 * and nothing after it has one, the ghosts are a scar from one era of the
 * schema, not a live write path — and the dep correlation is a confound.
 *
 * Run: bun scripts/probe-ghost-row-era.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const res = await node.queryAll({
  schemaHash: schemaHashFor("card", cfg),
  fields: ["slug", "created_at"],
  allowFullScan: true,
});

const rows = new Map<string, string[]>();
for (const row of res.results) {
  const f = ((row as { fields?: Record<string, unknown> }).fields ?? {}) as Record<string, unknown>;
  const slug = typeof f.slug === "string" ? f.slug : "";
  if (!slug) continue;
  rows.set(slug, [...(rows.get(slug) ?? []), typeof f.created_at === "string" ? f.created_at : ""]);
}

const ghost: string[] = [];
const clean: string[] = [];
for (const [, stamps] of rows) {
  const created = stamps.filter((s) => s.length > 0).sort()[0] ?? "";
  if (created.length === 0) continue;
  (stamps.length > 1 ? ghost : clean).push(created);
}
ghost.sort();
clean.sort();

const pct = (a: string[], p: number) => a[Math.floor((a.length - 1) * p)] ?? "-";
console.log(`ghosted cards : n=${ghost.length}  oldest=${ghost[0]}  newest=${ghost[ghost.length - 1]}`);
console.log(`               p50=${pct(ghost, 0.5)}`);
console.log(`clean cards   : n=${clean.length}  oldest=${clean[0]}  newest=${clean[clean.length - 1]}`);
console.log(`               p50=${pct(clean, 0.5)}`);

const cutoff = ghost[ghost.length - 1];
const cleanAfter = clean.filter((c) => c > cutoff).length;
console.log(`\nNewest ghosted card was created : ${cutoff}`);
console.log(`Clean cards created AFTER that  : ${cleanAfter}`);
console.log(
  cleanAfter > 0
    ? `=> ${cleanAfter} cards created after the last ghost, none ghosted. Consistent with a CLOSED era.`
    : `=> ghosts run right up to the newest card. A live write path is still producing them.`,
);

// Per-day: ghosted vs clean creations, to see where the era boundary sits.
const byDay = new Map<string, { g: number; c: number }>();
for (const s of ghost) {
  const d = s.slice(0, 10);
  byDay.set(d, { g: (byDay.get(d)?.g ?? 0) + 1, c: byDay.get(d)?.c ?? 0 });
}
for (const s of clean) {
  const d = s.slice(0, 10);
  byDay.set(d, { g: byDay.get(d)?.g ?? 0, c: (byDay.get(d)?.c ?? 0) + 1 });
}
console.log(`\nday          ghosted  clean`);
for (const [d, v] of [...byDay.entries()].sort()) {
  console.log(`${d}   ${String(v.g).padStart(5)}  ${String(v.c).padStart(5)}`);
}
