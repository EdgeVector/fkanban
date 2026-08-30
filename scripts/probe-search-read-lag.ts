#!/usr/bin/env bun
/**
 * READ-ONLY probe (after one create): at the exact moment the stress harness
 * runs `search`, which of search's sources can see the new card?
 *
 * The `search-index-divergence` finding is always the same shape — `show` reads
 * a card back and `search` misses it — and two fixes have now moved which index
 * search trusts without asking whether that index is fresh at the ACK. This
 * probe asks directly.
 *
 * It drives the REAL CLI create, then issues exactly the pair of reads
 * `indexedSearchCards` issues, starting the instant `add` returns:
 *
 *   A. display  — BoardCards partition, BOARD_CARDS_SEARCH_FIELDS (the 2026-08-27
 *                 fix's read, and the one its write-side wait polls)
 *   B. surfaces — the Card key list (the 2026-08-23 fix's recovery source)
 *   C. show     — Card HashKey point get (what the harness proves the card with)
 *
 * Measured 2026-08-30 on the live primary, four rounds:
 *
 *   round 1: display=miss surfaces=HIT  show=HIT
 *   round 2: display=miss surfaces=miss show=HIT
 *   round 3: display=miss surfaces=miss show=HIT
 *   round 4: display=miss surfaces=miss show=HIT
 *
 * Both enumerations lag the write ACK; the point get never does. That is why a
 * wait polling only the partition, on a 1575 ms budget, returned before search
 * could answer — and returned silently.
 *
 * Writes ONLY to a scratch board and removes each card it creates.
 * NO CATCH AROUND THE READS. A probe that cannot read must stop.
 *
 * Run: bun scripts/probe-search-read-lag.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCardSearchSurfaces, findCard } from "../src/record.ts";
import { listBoardCardsPartition, BOARD_CARDS_SEARCH_FIELDS } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const BOARD = process.env.PROBE_BOARD || "agent-dogfood-scratch";
const CLI = process.env.PROBE_CLI || "kanban";
const ROUNDS = Number(process.env.PROBE_ROUNDS || "4");

for (let round = 1; round <= ROUNDS; round++) {
  const stamp = Date.now();
  const slug = `probe-srl-${stamp}`;
  const proc = Bun.spawn(
    [CLI, "add", slug, "--title", `find me probetok${stamp}`, "--board", BOARD,
      "--column", "todo", "--force", "--tags", "kstress", "--repo", "EdgeVector/fold"],
    { stdout: "pipe", stderr: "pipe" },
  );
  const rc = await proc.exited;
  if (rc !== 0) {
    console.log(`round ${round}: add failed rc=${rc}\n${await new Response(proc.stderr).text()}`);
    continue;
  }

  // t0 is the harness's moment: `add` has returned, `search` runs now.
  const t0 = performance.now();
  const [rows, surfaces] = await Promise.all([
    listBoardCardsPartition(node, cfg, BOARD, { fields: BOARD_CARDS_SEARCH_FIELDS }),
    listCardSearchSurfaces(node, cfg),
  ]);
  const readMs = Math.round(performance.now() - t0);

  const inDisplay = rows?.some((row) => row.slug === slug) ?? false;
  const inSurfaces = surfaces.has(slug);
  const card = await findCard(node, cfg, slug);

  console.log(
    `round ${round}: display=${inDisplay ? "HIT " : "miss"} ` +
      `surfaces=${inSurfaces ? "HIT " : "miss"} ` +
      `show=${card ? "HIT " : "miss"}  ` +
      `(both reads ${readMs}ms, surfaces=${surfaces.size})`,
  );

  Bun.spawnSync([CLI, "rm", slug], { stdout: "ignore", stderr: "ignore" });
}
