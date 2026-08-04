#!/usr/bin/env bun
/**
 * READ-ONLY probe: is `doctor`'s BoardCards projection-parity RED real drift,
 * or a race against concurrent writers?
 *
 * `checkProjectionParity` compares an all-leads SWEEP (24 partition queries)
 * against a single WIDE read, taken one after the other. On a live board the
 * pickup / papercut / groom routines are writing the whole time, and a `rank`
 * is a write-new-sk + delete-old-sk pair. A row the sweep saw and the later
 * wide read cannot is therefore ambiguous between:
 *
 *   - DRIFT  — the row lacks an atom for the gating field (the real bug), or
 *   - RACE   — the row was deleted (or re-keyed) in the window between the two
 *              reads, which is a healthy board doing its job.
 *
 * Doctor cannot currently tell these apart, and tells the operator to run
 * `groom board-cards-heal --apply` either way.
 *
 * This brackets the wide read between TWO sweeps. A row present in BOTH sweeps
 * was stably in the partition across the whole window, so if the wide read
 * missed it, that is drift. A row in only one sweep moved during the window —
 * that is the race, and it is not evidence of anything.
 *
 * Run: bun scripts/probe-parity-race-vs-drift.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards } from "../src/record.ts";
import { listBoardCardsPartition, sweepBoardCardsPartition } from "../src/board-cards.ts";

const REPS = Number(process.argv[2] ?? 3);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);

for (const b of boards) {
  const first = await sweepBoardCardsPartition(node, cfg, b.slug);
  if (!first || first.rows.length === 0) continue;
  console.log(`\n── board ${b.slug}`);

  for (let i = 0; i < REPS; i++) {
    const sweepA = await sweepBoardCardsPartition(node, cfg, b.slug);
    const wide = await listBoardCardsPartition(node, cfg, b.slug);
    const sweepB = await sweepBoardCardsPartition(node, cfg, b.slug);
    if (!sweepA || !sweepB || wide === null) continue;

    const a = new Set(sweepA.rows.map((r) => r.sk));
    const bb = new Set(sweepB.rows.map((r) => r.sk));
    // The wide read is a Card[] with no sk; compare on slug, which is what
    // `checkProjectionParity` itself compares on.
    const wideSlugs = new Set(wide.map((c) => c.slug));

    const stable = [...a].filter((sk) => bb.has(sk));
    const moved = [...a].filter((sk) => !bb.has(sk)).concat([...bb].filter((sk) => !a.has(sk)));

    const slugOf = (sk: string) => sk.split("#").slice(2).join("#");
    // What doctor reports today: sweepA − wide, on slug.
    const doctorSays = [...new Set(sweepA.rows.map((r) => r.slug))].filter((s) => !wideSlugs.has(s));
    // What survives the bracket: stably-present rows the wide read still missed.
    const realDrift = [...new Set(stable.map(slugOf))].filter((s) => !wideSlugs.has(s));

    console.log(
      `   rep ${i + 1}: sweepA=${a.size} sweepB=${bb.size} wide=${wide.length} ` +
      `| stable=${stable.length} moved=${moved.length} ` +
      `| doctor RED=${doctorSays.length} → after bracket=${realDrift.length}`,
    );
    for (const s of realDrift) console.log(`        DRIFT: ${s}`);
    for (const s of doctorSays.filter((x) => !realDrift.includes(x))) {
      console.log(`        race-only (doctor would have flagged): ${s}`);
    }
  }
}
