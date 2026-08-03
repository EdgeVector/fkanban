#!/usr/bin/env bun
/**
 * `groom milestone-indexes-heal` reports `scanned=<n>`, but that is NOT the
 * scan's yield — it is the count that SURVIVED hydration:
 *
 *     for (const slug of slugs) {
 *       const full = await findMilestone(node, cfg, slug);
 *       if (!full) continue;              // <- silent, uncounted
 *       milestones.push(full);
 *     }
 *
 * The scan enumerates 17; heal reported scanned=10. So 7 enumerated slugs did
 * not survive the point-read, and nothing anywhere records that.
 *
 * Two very different causes are indistinguishable from the output:
 *   (a) they are HUSKS of deleted milestones — dropping them is CORRECT;
 *   (b) the point-read failed transiently — dropping them silently shrinks the
 *       repair set, and the heal still reports success.
 *
 * This probe separates them by re-reading each casualty N times.
 * Read-only.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { fieldsFor } from "../src/schemas.ts";
import { findMilestone, rowToMilestone, milestoneQueryFieldsLookSparse } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const RETRIES = Number(process.env.RETRIES ?? 5);

const res = await node.queryAll({
  schemaHash: cfg.schemaHashes.milestone!,
  fields: [...fieldsFor("milestone")],
  allowFullScan: true,
});

// Mirror heal's slug extraction exactly.
const slugs = res.results
  .map((row) => {
    const mapped = rowToMilestone(row);
    if (!milestoneQueryFieldsLookSparse((row.fields ?? {}) as Record<string, unknown>)) {
      return mapped.slug;
    }
    return mapped.slug || String((row.fields as { slug?: string } | undefined)?.slug ?? "");
  })
  .filter(Boolean);

console.log(`== heal's hydrate loop, instrumented ==\n`);
console.log(`  full scan enumerated      ${slugs.length} slugs`);

const survivors: string[] = [];
const casualties: string[] = [];
for (const slug of slugs) {
  const full = await findMilestone(node, cfg, slug);
  if (full) survivors.push(slug);
  else casualties.push(slug);
}

console.log(`  survived findMilestone    ${survivors.length}   <- what heal calls "scanned"`);
console.log(`  DROPPED, silently         ${casualties.length}\n`);

if (casualties.length === 0) {
  console.log("  No casualties this pass.");
} else {
  console.log(`== Are the dropped slugs husks, or transient read failures? ==`);
  console.log(`   (re-reading each ${RETRIES}x; a husk is null EVERY time)\n`);
  for (const slug of casualties) {
    let found = 0;
    for (let i = 0; i < RETRIES; i++) {
      if (await findMilestone(node, cfg, slug)) found++;
    }
    const verdict =
      found === 0 ? "HUSK (always null — correct to drop)" : `TRANSIENT (${found}/${RETRIES} reads FOUND it)`;
    console.log(`    ${slug.padEnd(52)} ${verdict}`);
  }
}

console.log("\nRead-only probe complete. Nothing was written or deleted.");
