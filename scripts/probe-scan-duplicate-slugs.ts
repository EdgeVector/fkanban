#!/usr/bin/env bun
/**
 * READ-ONLY probe: does the slug+body scan return more than one row per slug,
 * and do the duplicates disagree about the body?
 *
 * The search residual is not a projection-width effect (point reads return the
 * full body at every width). The remaining candidate is the SCAN returning
 * several rows for one slug — in which case a last-write-wins `map.set(slug, …)`
 * can land on the empty one.
 *
 * Run: bun scripts/probe-scan-duplicate-slugs.ts
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
  fields: ["slug", "body"],
  allowFullScan: true,
});

const rowsBySlug = new Map<string, string[]>();
for (const row of res.results) {
  const f = (row as { fields?: Record<string, unknown> }).fields ?? {};
  const slug = typeof f.slug === "string" ? f.slug : "";
  if (!slug) continue;
  const body = typeof f.body === "string" ? f.body : "";
  const list = rowsBySlug.get(slug) ?? [];
  list.push(body);
  rowsBySlug.set(slug, list);
}

const dupes = [...rowsBySlug.entries()].filter(([, bodies]) => bodies.length > 1);
const disagreeing = dupes.filter(([, bodies]) => new Set(bodies.map((b) => b.length)).size > 1);
const lastWinsEmpty = disagreeing.filter(([, bodies]) => bodies[bodies.length - 1] === "");

console.log(`scan rows            : ${res.results.length}`);
console.log(`distinct slugs       : ${rowsBySlug.size}`);
console.log(`slugs with >1 row    : ${dupes.length}`);
console.log(`  ...whose rows disagree on body length : ${disagreeing.length}`);
console.log(`  ...where the LAST row is empty        : ${lastWinsEmpty.length}   <-- lost by last-write-wins`);
for (const [slug, bodies] of lastWinsEmpty.slice(0, 8)) {
  console.log(`    ${slug}: bodies=[${bodies.map((b) => b.length).join(", ")}]`);
}
