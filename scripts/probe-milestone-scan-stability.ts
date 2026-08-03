#!/usr/bin/env bun
/**
 * Is the `Milestone` full scan STABLE call-to-call?
 *
 * `groom milestone-indexes-heal` enumerates repair truth with
 * `queryAll({ allowFullScan: true })`. A previous run documented that this scan
 * MISSES live rows (papercut-kanban-milestone-full-scan-returns-husks-and-misses-live-rows)
 * and the delete path was fixed to require a point-read before removing anything.
 *
 * But `heal` reported scanned=10 while probe-milestone-heal-truth-drop.ts,
 * running the identical query minutes later, reported 17. If the scan yield
 * VARIES, then the heal's repair set varies too — and the heal reports success
 * either way, with no signal that it was blind to most of the space.
 *
 * Read-only. Issues the same scan N times and reports the yield + set drift.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = cfg.schemaHashes.milestone!;
const ROUNDS = Number(process.env.ROUNDS ?? 8);

async function scanOnce(): Promise<{ slugs: Set<string>; ms: number }> {
  const t0 = performance.now();
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...fieldsFor("milestone")],
    allowFullScan: true,
  });
  const ms = performance.now() - t0;
  const slugs = new Set<string>();
  for (const r of res.results ?? []) {
    const s = String((r.fields as Record<string, unknown>)?.slug ?? "");
    if (s) slugs.add(s);
  }
  return { slugs, ms };
}

console.log(`== Milestone full-scan stability, ${ROUNDS} identical calls ==\n`);

const runs: Set<string>[] = [];
for (let i = 0; i < ROUNDS; i++) {
  const { slugs, ms } = await scanOnce();
  runs.push(slugs);
  console.log(`  round ${String(i + 1).padStart(2)}  yield=${String(slugs.size).padStart(3)}  ${ms.toFixed(0)}ms`);
}

const sizes = runs.map((r) => r.size);
const min = Math.min(...sizes);
const max = Math.max(...sizes);

const union = new Set<string>();
for (const r of runs) for (const s of r) union.add(s);
const intersection = [...union].filter((s) => runs.every((r) => r.has(s)));

console.log(`\n  yield min/max          ${min} / ${max}`);
console.log(`  union over all rounds  ${union.size}`);
console.log(`  present in EVERY round ${intersection.length}`);
console.log(`  unstable slugs         ${union.size - intersection.length}`);

if (union.size - intersection.length > 0) {
  console.log(`\n  Slugs that appeared in some rounds but not others:`);
  for (const s of [...union].filter((x) => !intersection.includes(x)).slice(0, 20)) {
    const hits = runs.filter((r) => r.has(s)).length;
    console.log(`    ${s}  (${hits}/${ROUNDS} rounds)`);
  }
}

console.log("\nRead-only probe complete. Nothing was written or deleted.");
