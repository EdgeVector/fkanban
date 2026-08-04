#!/usr/bin/env bun
/**
 * What does the new pinned-identity check say about the LIVE primary?
 *
 * Read-only companion to `probe-extra-schema-resolution-blindspot.ts`, which
 * established that the four EXTRA_SCHEMAS get no identity check at all and
 * found `milestone_cards` pinned to a hash the node registers under
 * `descriptive_name: "Milestone"`. This runs the check that now exists —
 * `checkPinnedSchemaIdentity` — over all seven pinned keys and prints the
 * verdict doctor will print.
 *
 * No writes: one `listSchemas()` and one config read. Safe on the primary.
 *
 *   bun scripts/probe-pinned-schema-identity.ts
 */
import { readConfig, resolveSocketPath } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { allPinnedSchemas, checkPinnedSchemaIdentity, formatSchemaIdentityMismatch } from "../src/schemas.ts";

const cfg = readConfig();
const socket = resolveSocketPath(cfg);
const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: socket });
const loaded = await node.listSchemas();
console.log(`socket: ${socket}\nnode has ${loaded.length} loaded schemas\n`);

let crossed = 0;
for (const entry of allPinnedSchemas()) {
  const hash = cfg.schemaHashes[entry.key];
  const check = checkPinnedSchemaIdentity(entry, hash, loaded);
  const label = entry.key.padEnd(18);
  if (check.kind === "mismatch") {
    crossed += 1;
    console.log(`✗ ${label} ${hash}`);
    console.log(`  ${formatSchemaIdentityMismatch(check)}`);
  } else if (check.kind === "ok") {
    console.log(`✓ ${label} ${entry.schema.schema.descriptive_name}`);
  } else {
    console.log(`· ${label} ${check.kind}${hash ? ` (${hash})` : ""}`);
  }
}
console.log(`\n${crossed} crossed ${crossed === 1 ? "identity" : "identities"}`);
