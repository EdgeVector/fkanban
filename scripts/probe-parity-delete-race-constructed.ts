#!/usr/bin/env bun
/**
 * Does `doctor`'s BoardCards projection-parity check report DRIFT for a row
 * that was merely DELETED while it was running?
 *
 * `probe-parity-race-vs-drift.ts` asks this of the live board and can only
 * answer when a routine happens to be writing — it caught a RED at 09:5x
 * (129 rows, 1 invisible; then 132 rows, 5 invisible with two sks for one slug)
 * and was green four minutes later. That is a statement about when it ran, not
 * about the check.
 *
 * So construct it. Every witness here is written with EVERY field, so no
 * projection gate can drop any of them — if parity goes RED, the delete is the
 * only thing that can have caused it.
 *
 * The check reads, in order: `sweepBoardCardsPartition` (24 queries) then one
 * wide `listBoardCardsPartition`. A row deleted between the two is present in
 * the sweep and absent from the wide read — indistinguishable, to the shipped
 * check, from a row whose gating field has no atom.
 *
 * Arm A — as shipped:   sweep, delete, wide.            Expect: RED.
 * Arm B — bracketed:    sweep, delete, wide, sweep.     Expect: green,
 *   because the row is missing from the SECOND sweep too, so it moved during
 *   the window rather than being invisible to the projection.
 *
 * Inert on the primary for the same reason as
 * `probe-boardcards-hash-gate-constructed.ts`: the rows live under a HashKey no
 * product read addresses (no Board record names it), and are deleted at the
 * end. A leaked row is inert; the next run re-cleans.
 *
 * Run: bun scripts/probe-parity-delete-race-constructed.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoardCardsPartition, sweepBoardCardsPartition } from "../src/board-cards.ts";
import { confirmParityDrop } from "../src/membership_schema_guard.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const PROBE_PARTITION = "zzz-probe-parity-delete-race-do-not-use";
const NAMES = ["alpha", "bravo", "charlie", "delta"];
const VICTIM = "bravo";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const bcHash = cfg.schemaHashes!.board_cards!;
const sk = (name: string) => `todo#00000000#probe-${name}`;
const settle = (ms = 9000) => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  for (const name of NAMES) {
    try {
      await node.deleteRecord({ schemaHash: bcHash, keyHash: PROBE_PARTITION, rangeKey: sk(name) });
    } catch { /* already gone */ }
  }
}

async function writeAll(): Promise<void> {
  for (const name of NAMES) {
    const payload: Record<string, unknown> = {};
    for (const f of BOARD_CARDS_FIELDS) {
      payload[f] = f === "board" ? PROBE_PARTITION
        : f === "sk" ? sk(name)
        : f === "slug" ? `probe-${name}`
        : f === "column" ? "todo"
        : f === "position" ? "00000000"
        : ["tags", "deps", "surfaces"].includes(f) ? []
        : `v-${f}`;
    }
    await node.updateRecord({ schemaHash: bcHash, keyHash: PROBE_PARTITION, rangeKey: sk(name), fields: payload });
  }
}

try {
  await cleanup();
  await writeAll();
  await settle();

  const sweepA = await sweepBoardCardsPartition(node, cfg, PROBE_PARTITION);
  console.log(`sweepA: ${sweepA?.rows.length} rows (all ${BOARD_CARDS_FIELDS.length} fields written — no gate is possible)`);

  await node.deleteRecord({ schemaHash: bcHash, keyHash: PROBE_PARTITION, rangeKey: sk(VICTIM) });
  console.log(`deleted probe-${VICTIM} — a rank does exactly this to the old sk`);
  await settle();

  const wide = await listBoardCardsPartition(node, cfg, PROBE_PARTITION);
  const sweepB = await sweepBoardCardsPartition(node, cfg, PROBE_PARTITION);
  console.log(`wide:   ${wide?.length} rows`);
  console.log(`sweepB: ${sweepB?.rows.length} rows`);

  const wideSlugs = new Set((wide ?? []).map((c) => c.slug));
  const aSks = new Set((sweepA?.rows ?? []).map((r) => r.sk));
  const bSks = new Set((sweepB?.rows ?? []).map((r) => r.sk));

  // Arm A — exactly what `checkProjectionParity` is fed today.
  const armA = [...new Set((sweepA?.rows ?? []).map((r) => r.slug))].filter((s) => !wideSlugs.has(s));

  // Arm B — the SHIPPED helper, not a restatement of it. If doctor's
  // confirmation ever stops separating these two, this probe goes red.
  const armB = confirmParityDrop(sweepA?.rows ?? [], sweepB?.rows ?? [], wideSlugs).drift;
  void aSks;
  void bSks;

  console.log(`\n  arm A (as shipped) : ${armA.length ? `RED — ${armA.join(", ")}` : "green"}`);
  console.log(`  arm B (bracketed)  : ${armB.length ? `RED — ${armB.join(", ")}` : "green"}`);
  console.log(`\n  verdict: ${armA.length > 0 && armB.length === 0
    ? "the shipped check reports DRIFT for a plain delete; the bracket does not."
    : "inconclusive — see counts above."}`);
} finally {
  await cleanup();
}
