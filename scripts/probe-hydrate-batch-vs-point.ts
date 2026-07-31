#!/usr/bin/env bun
/**
 * READ-ONLY probe: is `pickup status`'s body hydration cheaper as N point-reads
 * or as ONE admin scan?
 *
 * `hydrateCardBodies` pays one `card HashKey(<slug>)` point-read per card whose
 * body it needs. `probe-command-reads.ts` measured that as the dominant cost of
 * `kanban pickup status` — far above the BoardCards partitions it also reads.
 *
 * `listCardsWithBodies` is the other shape already used in this codebase
 * (`listBoardCardsWithBodies`): ONE admin full-scan that returns every body.
 * Flat in N, but it reads bodies nobody asked for.
 *
 * The crossover decides which is correct, so measure it on the real board
 * rather than reasoning about it. Interleaved reps, because the live node
 * serves the whole fleet and a single rep mostly measures whatever else was
 * running at that moment.
 *
 * Run: bun scripts/probe-hydrate-batch-vs-point.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoards,
  listCards,
  listCardsWithBodies,
  hydrateCardBodies,
  listDependencyStatusesForCards,
} from "../src/record.ts";
import { pickupClassificationNeedsBody } from "../src/pickup.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards });
const withDeps = await listDependencyStatusesForCards(node, cfg, cards);

// Exactly the set `hydrateForPickupClassification` hydrates: classified
// (non-terminal) cards whose verdict would otherwise be a guess.
const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
const classified = new Set(
  withDeps.filter((c) => c.column !== (terminalByBoard.get(c.board) ?? "done")).map((c) => c.slug),
);
const needy = withDeps.filter((c) => classified.has(c.slug) && pickupClassificationNeedsBody(c));

const byColumn: Record<string, number> = {};
for (const c of needy) byColumn[`${c.board}/${c.column}`] = (byColumn[`${c.board}/${c.column}`] ?? 0) + 1;
console.log(`cards=${cards.length}  needing body hydration=${needy.length}`);
console.log(byColumn);

const REPS = 3;
const point: number[] = [];
const scan: number[] = [];

for (let i = 0; i < REPS; i += 1) {
  // Interleave so a burst of fleet traffic hits both arms, not just one.
  let t = performance.now();
  await hydrateCardBodies(node, cfg, needy);
  point.push(performance.now() - t);

  t = performance.now();
  const all = await listCardsWithBodies(node, cfg);
  scan.push(performance.now() - t);
  if (i === 0) console.log(`\nscan returns ${all.length} rows (bodies for the whole Card product)`);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]!;
console.log(`\n${needy.length} point-reads (current) : ${point.map((x) => x.toFixed(0)).join(", ")}  median ${med(point).toFixed(0)}ms`);
console.log(`1 admin scan  (candidate)   : ${scan.map((x) => x.toFixed(0)).join(", ")}  median ${med(scan).toFixed(0)}ms`);

const winner = med(scan) < med(point) ? "SCAN" : "POINT-READS";
console.log(`\nwinner on this board: ${winner}`);
console.log(`per-card point-read cost: ${(med(point) / Math.max(1, needy.length)).toFixed(1)}ms`);
console.log(`scan breaks even at ~${Math.max(1, Math.round(med(scan) / (med(point) / Math.max(1, needy.length))))} cards`);
