#!/usr/bin/env bun
/**
 * What would doctor's schema-identity check say about the FOUR schemas it does
 * not run on?
 *
 * `doctor` cross-checks config hashes against the node's loaded set, flags a
 * config pinned to a narrower version, and write-probes each one — for
 * `UNIQUE_SCHEMAS` only: card, board, milestone. The four `EXTRA_SCHEMAS`
 * (card_list_index, board_cards, board_milestones, milestone_cards) get none of
 * it, while doctor prints green "key layout" and "projection parity" lines about
 * them that read as coverage.
 *
 * It is not a scoping decision. `resolveLoadedSchema(type)` reads
 * `RECORDS[type]`, which only has the three record types — calling it for an
 * index schema throws. The check cannot be run on them, so nobody ran it.
 *
 * Read-only. Prints, for every catalog schema, what the node has loaded under
 * that identity and whether the pinned hash is one of them.
 *
 *   bun scripts/probe-extra-schema-resolution-blindspot.ts
 */
import { readConfig, resolveSocketPath } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { UNIQUE_SCHEMAS, EXTRA_SCHEMAS, OWNER_APP_ID } from "../src/schemas.ts";

const cfg = readConfig();
const socket = resolveSocketPath(cfg);
console.log(`socket: ${socket}\n`);

const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: socket });
const loaded = await node.listSchemas();
console.log(`node has ${loaded.length} loaded schemas\n`);

type Entry = { key: string; schema: { schema: { descriptive_name: string; fields: string[] } } };

for (const [group, entries] of [
  ["CHECKED by doctor (UNIQUE_SCHEMAS)", UNIQUE_SCHEMAS],
  ["NOT CHECKED by doctor (EXTRA_SCHEMAS)", EXTRA_SCHEMAS],
] as const) {
  console.log(`=== ${group} ===`);
  for (const entry of entries as ReadonlyArray<Entry>) {
    const descriptive = entry.schema.schema.descriptive_name;
    const configHash = (cfg.schemaHashes as Record<string, string | undefined>)[entry.key];
    const pinnedRow = loaded.find((s) => s.name === configHash);
    const byName = loaded.filter(
      (s) => s.descriptive_name === descriptive && s.owner_app_id === OWNER_APP_ID,
    );

    console.log(
      `${entry.key.padEnd(18)} declared_name=${descriptive}\n` +
        `  pinned=${String(configHash).slice(0, 16)} ` +
        `loaded=${pinnedRow ? "yes" : "NO"} ` +
        `local_fields=${entry.schema.schema.fields.length}`,
    );
    if (pinnedRow) {
      console.log(
        `  pinned row: descriptive_name=${pinnedRow.descriptive_name} ` +
          `fields=${pinnedRow.fields.length} key=${JSON.stringify(pinnedRow.key ?? null)}`,
      );
      if (pinnedRow.descriptive_name !== descriptive) {
        console.log(
          `  ** IDENTITY MISMATCH: config pins a schema registered as ` +
            `"${pinnedRow.descriptive_name}", not "${descriptive}" **`,
        );
      }
    }
    console.log(`  loaded under declared name "${descriptive}": ${byName.length}`);
    for (const c of byName) {
      const mark = c.name === configHash ? "*" : " ";
      console.log(`   ${mark} ${c.name.slice(0, 16)} fields=${c.fields.length} key=${JSON.stringify(c.key ?? null)}`);
    }
    console.log("");
  }
}

// Who else shares the identity the milestone_cards pin was registered under?
const mcPin = (cfg.schemaHashes as Record<string, string | undefined>).milestone_cards;
const mcRow = loaded.find((s) => s.name === mcPin);
if (mcRow) {
  console.log(`=== everything loaded under "${mcRow.descriptive_name}" (the milestone_cards pin's identity) ===`);
  for (const c of loaded.filter((s) => s.descriptive_name === mcRow.descriptive_name)) {
    console.log(
      `  ${c.name.slice(0, 16)} owner=${c.owner_app_id} fields=${c.fields.length} key=${JSON.stringify(c.key ?? null)}`,
    );
  }
}
