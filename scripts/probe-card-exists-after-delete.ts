#!/usr/bin/env bun
/**
 * Probe: does `cardExists` — the read that AUTHORIZES reaping board membership —
 * still answer "yes" for a card that was deleted?
 *
 * `cardExists` projects the hash key alone, deliberately, so that a merely
 * SPARSE card cannot read as absent and get its board membership reaped
 * (`board_cards_heal.ts:714`). That reasoning is sound in the direction it was
 * written for. This probe asks the other direction, which nothing had measured:
 * after `rm`, does the node still serve a slug-only row?
 *
 * Measured on the live primary 2026-08-06 with a raw `/api/query`: a deleted
 * Card partition still returns ONE row, carrying exactly one field — `slug`,
 * the hash key — with every other projected field absent:
 *
 *   {"fields":{"slug":"zz-husk-raw-…"},"key":{"hash":"zz-husk-raw-…"},…}
 *
 * If that row satisfies `cardExists`, then a genuinely orphaned BoardCards row
 * (its Card deleted) is permanently classified "sparse Card record, NOT an
 * orphan" and the `missing_card` reap branch is unreachable for the exact case
 * it exists to handle.
 *
 * Writes: ONE scratch card on `agent-dogfood-scratch`, deleted before the probe
 * reads. Net zero cards on exit.
 *
 * Run: bun scripts/probe-card-exists-after-delete.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { cardExists, findCard } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const N = Number(process.argv[2] ?? 10);

type Outcome = { existsHusk: boolean; cardHusk: boolean; settledMs: number | null };

async function once(i: number): Promise<Outcome | null> {
  const slug = `zz-probe-exists-${Date.now()}-${i}`;

  // Create via the CLI so the card is written exactly the way a real one is.
  const add = Bun.spawnSync([
    "kanban", "add", slug,
    "--title", "cardExists-after-delete probe",
    "--board", "agent-dogfood-scratch",
    "--column", "todo",
    "--kind", "validation",
    "--repo", "EdgeVector/fold",
  ]);
  if (add.exitCode !== 0) {
    console.log(`  ${i}: ABORT add rc=${add.exitCode} ${add.stderr.toString().trim()}`);
    return null;
  }

  const rm = Bun.spawnSync(["kanban", "rm", slug]);
  if (rm.exitCode !== 0) {
    console.log(`  ${i}: ABORT rm rc=${rm.exitCode}`);
    return null;
  }

  // Read back with NO delay — this is the window a script hits.
  const t0 = performance.now();
  const goneExists = await cardExists(node, cfg, slug);
  const goneCard = await findCard(node, cfg, slug);

  // If either lied, poll until it settles so the window is measured, not guessed.
  let settledMs: number | null = null;
  if (goneExists || goneCard !== null) {
    for (;;) {
      const e = await cardExists(node, cfg, slug);
      const c = await findCard(node, cfg, slug);
      if (!e && c === null) {
        settledMs = performance.now() - t0;
        break;
      }
      if (performance.now() - t0 > 30_000) break;
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  console.log(
    `  ${i}: cardExists=${goneExists} findCard=${goneCard === null ? "null" : "HUSK"}` +
      (goneCard
        ? ` (title="${goneCard.title}" board="${goneCard.board}" column="${goneCard.column}")`
        : "") +
      (settledMs === null ? "" : ` settled after ${settledMs.toFixed(0)}ms`),
  );

  return { existsHusk: goneExists, cardHusk: goneCard !== null, settledMs };
}

async function main(): Promise<void> {
  console.log(`cardExists / findCard immediately after rm — ${N} iterations`);
  const outcomes: Outcome[] = [];
  for (let i = 1; i <= N; i += 1) {
    const o = await once(i);
    if (o) outcomes.push(o);
  }
  const existsHusks = outcomes.filter((o) => o.existsHusk).length;
  const cardHusks = outcomes.filter((o) => o.cardHusk).length;
  const settles = outcomes.map((o) => o.settledMs).filter((m): m is number => m !== null);
  console.log("");
  console.log(`cardExists said "still there" after rm : ${existsHusks}/${outcomes.length}`);
  console.log(`findCard returned a husk after rm     : ${cardHusks}/${outcomes.length}`);
  if (settles.length > 0) {
    console.log(
      `settle window (ms)                    : min=${Math.min(...settles).toFixed(0)} ` +
        `max=${Math.max(...settles).toFixed(0)}`,
    );
  }
}

await main();
