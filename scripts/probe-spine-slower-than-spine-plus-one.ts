#!/usr/bin/env bun
/**
 * READ-ONLY probe: is "spine is slower than spine+1" real, or an artifact of
 * what runs BEFORE it?
 *
 * `probe-boardcards-per-field-cost.ts` reports all 19 fields as negative
 * against its spine baseline, across two independent runs. Its per-field
 * RANKING does not reproduce (`kind` moved from -17ms to -67ms between runs),
 * so the ranking is noise — but the sign does reproduce, and a reproducible
 * sign needs an explanation before anyone narrows a projection on it.
 *
 * The one structural difference between how that probe measures spine and how
 * it measures spine+f: spine always runs immediately after the ADDRESS-ONLY
 * read (a strictly narrower projection), and spine+f never does.
 *
 * So this alternates A/B with no third projection anywhere in the loop:
 *
 *   arm "spine"    — spine, measured after another spine read
 *   arm "spine+f"  — spine+kind, measured after another spine+kind read
 *
 * and then repeats both arms with an address-only read deliberately injected
 * in front, which is the only thing the real probe does differently.
 *
 * If spine is genuinely slower, it is slower in both halves. If it is only
 * slower when preceded by the narrower read, the baseline is an artifact of
 * the predecessor and every delta that probe has ever printed is measured
 * against a poisoned operand.
 *
 * Run: bun scripts/probe-spine-slower-than-spine-plus-one.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_ADDRESS_FIELDS,
  boardCardsHash,
} from "../src/board-cards.ts";

const reps = Number(process.argv[2] ?? 15);
const board = process.argv[3] ?? "default";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const hash = boardCardsHash(cfg);
if (!hash) {
  console.error("no board_cards schema hash in config");
  process.exit(1);
}

const spine = [...BOARD_CARDS_SPINE_FIELDS];
const spinePlus = [...spine, "kind"];
const address = [...BOARD_CARDS_ADDRESS_FIELDS];

async function timeOnce(fields: string[]): Promise<number> {
  const t0 = performance.now();
  await node.queryAll({ schemaHash: hash!, fields, filter: { HashKey: board } });
  return performance.now() - t0;
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

for (let i = 0; i < 4; i++) await timeOnce(spine);

// Half 1: no address-only read anywhere in the loop.
const cleanSpine: number[] = [];
const cleanPlus: number[] = [];
// Half 2: an address-only read immediately precedes the measured query.
const afterAddrSpine: number[] = [];
const afterAddrPlus: number[] = [];

for (let r = 0; r < reps; r++) {
  // Order flipped on odd reps so neither arm owns a fixed slot.
  const flip = r % 2 === 1;

  const cleanFirst = flip ? spinePlus : spine;
  const cleanSecond = flip ? spine : spinePlus;
  const a = await timeOnce(cleanFirst);
  const b = await timeOnce(cleanSecond);
  (flip ? cleanPlus : cleanSpine).push(a);
  (flip ? cleanSpine : cleanPlus).push(b);

  await timeOnce(address);
  afterAddrSpine.push(await timeOnce(spine));
  await timeOnce(address);
  afterAddrPlus.push(await timeOnce(spinePlus));

  process.stderr.write(`  rep ${r + 1}/${reps}\n`);
}

const row = (label: string, xs: number[]) =>
  `   ${label.padEnd(34)} ${Math.round(median(xs)).toString().padStart(5)}ms`;

console.log(`\n== A/B, median of ${reps} reps, HashKey(${board}) ==`);
console.log(`   spine   = ${spine.join(",")}`);
console.log(`   spine+f = spine + kind\n`);

console.log("  no address-only read in the loop:");
console.log(row("spine", cleanSpine));
console.log(row("spine+f", cleanPlus));
const cleanDelta = median(cleanPlus) - median(cleanSpine);
console.log(`   ${"Δ (spine+f - spine)".padEnd(34)} ${cleanDelta >= 0 ? "+" : ""}${Math.round(cleanDelta)}ms\n`);

console.log("  address-only read immediately before each:");
console.log(row("spine", afterAddrSpine));
console.log(row("spine+f", afterAddrPlus));
const addrDelta = median(afterAddrPlus) - median(afterAddrSpine);
console.log(`   ${"Δ (spine+f - spine)".padEnd(34)} ${addrDelta >= 0 ? "+" : ""}${Math.round(addrDelta)}ms\n`);

console.log(
  `   Adding a field should cost >= 0ms. A negative Δ in the lower block and\n` +
    `   a non-negative Δ in the upper one means the per-field probe's baseline is\n` +
    `   an artifact of the address-only read that precedes it, not the spine.`,
);
