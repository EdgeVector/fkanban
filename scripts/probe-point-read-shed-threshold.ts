#!/usr/bin/env bun
/**
 * READ-ONLY probe: where does the node ACTUALLY shed concurrent point reads?
 *
 * Companion to `probe-point-read-concurrency-width.ts`, which found zero shed
 * up to width 24 and a flat ~190ms per serial wave. That is only half an
 * answer: "we saw no shedding up to 24" is not a threshold, and picking a new
 * `POINT_READ_CONCURRENCY` from it would repeat the mistake being fixed —
 * swapping one unmeasured constant for another.
 *
 * So escalate until the node pushes back, and report the width where it does.
 * A chosen default should sit below a MEASURED ceiling with margin, not below
 * the point where the last probe happened to stop looking.
 *
 * Escalation is bounded and stops at the first width that sheds: this is a
 * shared primary and other agents are reading it.
 *
 * Run: bun scripts/probe-point-read-shed-threshold.ts [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { listBoardCardsPartitionSpine } from "../src/board-cards.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";
import { CARD_DISPLAY_FIELDS } from "../src/record.ts";

const cfg = readConfig();
const node: NodeClient = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.argv[2] ?? "default";
const WIDTHS = [24, 32, 48, 64, 96];
const SAMPLE = 96;

const cardHash = cfg.schemaHashes?.card;
if (!cardHash) {
  console.log("card schema unbound — nothing to measure.");
  process.exit(0);
}

const spine = (await listBoardCardsPartitionSpine(node, cfg, BOARD)) ?? [];
const all = spine.map((r) => r.slug).filter((s) => s.length > 0);
const slugs = Array.from({ length: SAMPLE }, (_, i) => all[i % all.length]!);
if (all.length < 2) {
  console.log(`board "${BOARD}" has too few cards to measure (${all.length}).`);
  process.exit(0);
}

const shedReasons = new Map<string, number>();
const isShed = (err: unknown): boolean => {
  const m = err instanceof Error ? err.message : String(err);
  if (/too many concurrent|503|service_timeout|busy|EMFILE|ECONNRESET|socket/i.test(m)) {
    shedReasons.set(m.slice(0, 80), (shedReasons.get(m.slice(0, 80)) ?? 0) + 1);
    return true;
  }
  return false;
};

async function pointRead(slug: string): Promise<boolean> {
  try {
    await node.queryAll({
      schemaHash: cardHash!,
      fields: [...CARD_DISPLAY_FIELDS],
      filter: { HashKey: slug } as never,
    });
    return true;
  } catch (err) {
    if (isShed(err)) return false;
    shedReasons.set(
      `UNEXPECTED ${(err as Error).message.slice(0, 60)}`,
      (shedReasons.get(`UNEXPECTED ${(err as Error).message.slice(0, 60)}`) ?? 0) + 1,
    );
    return false;
  }
}

console.log(`Shed-threshold escalation — ${SAMPLE} point reads, board "${BOARD}"\n`);
console.log(`  width   ms     ms/wave   shed`);
let ceiling: number | null = null;
for (const width of WIDTHS) {
  const t0 = performance.now();
  const ok = await mapWithConcurrency(slugs, (s) => pointRead(s), width);
  const ms = performance.now() - t0;
  const shed = ok.filter((v) => v === false).length;
  const waves = Math.ceil(SAMPLE / width);
  console.log(
    `  ${String(width).padStart(5)}   ${String(Math.round(ms)).padStart(5)}  ` +
      `${String(Math.round(ms / waves)).padStart(8)}   ${String(shed).padStart(4)}`,
  );
  if (shed > 0) {
    ceiling = width;
    console.log(`\n  Node pushed back at width ${width} — stopping the escalation.`);
    break;
  }
  // Let the node settle between widths so one width's tail cannot be charged
  // to the next.
  await new Promise((r) => setTimeout(r, 750));
}

if (shedReasons.size > 0) {
  console.log(`\n  Reasons:`);
  for (const [reason, n] of shedReasons) console.log(`    ${n}x  ${reason}`);
}
console.log(
  ceiling === null
    ? `\n  No shedding up to width ${WIDTHS[WIDTHS.length - 1]} on ${SAMPLE} reads.`
    : `\n  Measured shed ceiling: ${ceiling}.`,
);
console.log("\nRead-only. Nothing was written.");
