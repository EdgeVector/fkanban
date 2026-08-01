#!/usr/bin/env bun
/**
 * Settle the projection rule at the WIRE, not through any client layer.
 *
 * `probe-projection-drop-rule.ts` measured that a projected field with no atom
 * does not drop the row — the key is simply absent from `fields`. That
 * contradicts the rule `test/fake-node.ts` calls "faithful" and enforces by
 * default for all 1136 tests. Before flipping a test oracle on that evidence,
 * rule out the cheaper explanation: that some layer BETWEEN the node and the
 * probe (the vendored SDK's parse, `queryRowFromSdk`, dedupe) is what drops the
 * key, and the node really does drop the row.
 *
 * So: raw POST /api/query over the unix socket, print the JSON the node
 * actually sent. If the row is in `results` and its `fields` object has no
 * `layout` key, the node returned a partial row and the question is closed.
 *
 * Read-only.
 *
 *   bun scripts/probe-wire-projection-semantics.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { MILESTONE_CARDS_FIELDS, BOARD_MILESTONES_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

async function raw(schemaHash: string, fields: readonly string[], filter: unknown, label: string) {
  const res = await node.rawCall("POST", "/api/query", {
    schema_name: schemaHash,
    fields: [...fields],
    limit: 200,
    filter,
  });
  console.log(`\n== ${label} ==`);
  console.log(`   HTTP ${res.status}`);
  const body = res.json as { results?: Array<{ fields?: Record<string, unknown> }> } | null;
  const results = body?.results ?? [];
  console.log(`   results: ${results.length}`);
  return results;
}

// 1. MilestoneCards partition that holds a row whose `layout` did not come back.
const mcHash = cfg.schemaHashes?.milestone_cards;
if (mcHash) {
  const results = await raw(
    mcHash,
    MILESTONE_CARDS_FIELDS,
    { HashKey: "lastdb-0231-read-regression-fixes" },
    `MilestoneCards / lastdb-0231-read-regression-fixes, ${MILESTONE_CARDS_FIELDS.length} fields projected`,
  );
  for (const r of results) {
    const f = r.fields ?? {};
    const keys = Object.keys(f);
    const missing = [...MILESTONE_CARDS_FIELDS].filter((n) => !(n in f));
    console.log(
      `   slug=${String(f.slug ?? "(absent)")}  keys=${keys.length}/${MILESTONE_CARDS_FIELDS.length}` +
        `  missing=[${missing.join(", ") || "none"}]`,
    );
  }
  const partial = results.filter((r) => Object.keys(r.fields ?? {}).length < MILESTONE_CARDS_FIELDS.length);
  console.log(
    `\n   VERDICT: ${
      partial.length > 0
        ? `the NODE returned ${partial.length} PARTIAL row(s). It does not drop them. Rule is false.`
        : "every returned row is complete — the rule may hold; look elsewhere."
    }`,
  );
}

// 2. BoardMilestones — no row this app writes has a `completed_at` atom, and
//    every read projects it. If the rule held, this would return nothing.
const bmHash = cfg.schemaHashes?.board_milestones;
if (bmHash) {
  const results = await raw(
    bmHash,
    BOARD_MILESTONES_FIELDS,
    { HashKey: "default" },
    `BoardMilestones / default, ${BOARD_MILESTONES_FIELDS.length} fields incl. never-written completed_at`,
  );
  const withCompleted = results.filter((r) => "completed_at" in (r.fields ?? {})).length;
  console.log(`   rows carrying a completed_at key: ${withCompleted} of ${results.length}`);
  console.log(
    `\n   VERDICT: ${
      results.length === 0
        ? "rule HOLDS — the never-written field emptied the read."
        : `rule is FALSE — ${results.length} rows returned despite a projected field no row has.`
    }`,
  );
}

console.log("\nRead-only. Nothing was written.");
