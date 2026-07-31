#!/usr/bin/env bun
/**
 * READ-ONLY probe: which declared dependencies point at cards that do not exist?
 *
 * A dangling dep is not only a wasted point-read on every `pickup status`
 * (measured: 4 of them, ~620ms per call, forever) — it is a card that can never
 * be unblocked, because the thing it waits on can never reach a terminal column.
 *
 * Run: bun scripts/probe-dangling-deps.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCards } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const cards = await listCards(node, cfg);
const known = new Set(cards.map((c) => c.slug));
console.log(`cards on live boards: ${cards.length}`);

const dangling = new Map<string, Array<{ slug: string; column: string; board: string }>>();
let withDeps = 0;
for (const c of cards) {
  if ((c.deps ?? []).length > 0) withDeps += 1;
  for (const d of c.deps ?? []) {
    if (known.has(d)) continue;
    const list = dangling.get(d) ?? [];
    list.push({ slug: c.slug, column: c.column, board: c.board });
    dangling.set(d, list);
  }
}

console.log(`cards declaring >=1 dep: ${withDeps}`);
console.log(`distinct dangling dep targets: ${dangling.size}\n`);
for (const [dep, holders] of [...dangling.entries()].sort()) {
  console.log(`  ${dep}`);
  for (const h of holders) console.log(`      <- ${h.board}/${h.column}  ${h.slug}`);
}
