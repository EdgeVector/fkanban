#!/usr/bin/env bun
/**
 * READ-ONLY probe: what is `kanban pickup status`'s 137-request Card fan-out?
 *
 *   bun scripts/probe-pickup-hydrate.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards, listDependencyStatusesForCards } from "../src/record.ts";
import { pickupClassificationNeedsBody, hydrateForPickupClassification } from "../src/pickup.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const cards = await listCards(node, cfg);
const boards = await listBoards(node, cfg);
console.log(`cards=${cards.length} boards=${boards.length}`);

const t0 = performance.now();
const withDeps = await listDependencyStatusesForCards(node, cfg, cards);
console.log(`listDependencyStatusesForCards: ${(performance.now() - t0).toFixed(0)}ms -> ${withDeps.length}`);

const needy = withDeps.filter(pickupClassificationNeedsBody);
console.log(`\npickupClassificationNeedsBody: ${needy.length} cards`);
const byColumn: Record<string, number> = {};
for (const c of needy) byColumn[`${c.board}/${c.column}`] = (byColumn[`${c.board}/${c.column}`] ?? 0) + 1;
console.log(byColumn);

const t1 = performance.now();
const hydrated = await hydrateForPickupClassification(node, cfg, withDeps);
const hMs = performance.now() - t1;
const bodies = hydrated.filter((c) => needy.some((n) => n.slug === c.slug));
const bytes = bodies.reduce((n, c) => n + (c.body?.length ?? 0), 0);
console.log(
  `\nhydrateForPickupClassification: ${hMs.toFixed(0)}ms for ${needy.length} point-reads, ` +
    `${(bytes / 1024).toFixed(0)} KiB of body fetched`,
);

// How many of those bodies actually YIELD a Repo: / Base: header?
let withHeader = 0;
for (const c of bodies) {
  if (/^[ \t]*Repo:[ \t]*\S+/im.test(c.body ?? "")) withHeader += 1;
}
console.log(`bodies carrying a Repo: header: ${withHeader}/${bodies.length}`);
