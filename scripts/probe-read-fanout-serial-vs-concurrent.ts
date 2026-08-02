#!/usr/bin/env bun
/**
 * READ-ONLY probe: do kanban's SERIAL read stages overlap if issued together?
 *
 * Two earlier probes this run pushed the answer here:
 *   - probe-pickup-active-vs-whole.ts   refuted "read only the active columns"
 *     (797ms vs 522ms) — 6 prefix queries + k point reads lost to 2 whole
 *     partition reads, so per-query FIXED overhead beats the archive rows.
 *   - probe-pickup-projection-width.ts  found width is flat within noise at 169
 *     rows (7 fields 382ms vs 22 fields 400ms vs 14 fields 272ms).
 *
 * Both say the same thing: what a kanban command pays for is ROUND TRIPS, and
 * every one of them is issued serially today. `list` makes four
 * (findBoard -> listBoards -> partition(default) -> partition(other)),
 * `pickup status` three. Two of those pairs are genuinely independent.
 *
 * The repo has a measured case where fan-out LOST to serial
 * (`probe-boardcards-write-lock-contention.ts`, 0.91x) — but that was WRITES
 * contending on one partition lock. Reads of different keys have no such gate,
 * and this probe is the check that the read side actually behaves differently
 * rather than assuming it.
 *
 * Interleaved reps; serial and concurrent alternate so node warmth cannot
 * favour either.
 *
 * Run: bun scripts/probe-read-fanout-serial-vs-concurrent.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoardCardsPartition, BOARD_CARDS_LIST_FIELDS } from "../src/board-cards.ts";
import { findBoard, listBoards } from "../src/record.ts";

const reps = Number(process.argv[2] ?? 5);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const ms = async (fn: () => Promise<unknown>): Promise<number> => {
  const t0 = performance.now();
  await fn();
  return Math.round(performance.now() - t0);
};

const boards = await listBoards(node, cfg);
const slugs = boards.map((b) => b.slug);
console.log(`boards: ${slugs.join(", ")}`);

const readPart = (slug: string) =>
  listBoardCardsPartition(node, cfg, slug, { fields: [...BOARD_CARDS_LIST_FIELDS] });

type Case = { name: string; serial: () => Promise<unknown>; concurrent: () => Promise<unknown> };

const cases: Case[] = [
  {
    name: `listAllBoardCards fan-out (${slugs.length} partitions)`,
    serial: async () => {
      for (const s of slugs) await readPart(s);
    },
    concurrent: async () => {
      await Promise.all(slugs.map((s) => readPart(s)));
    },
  },
  {
    name: "list preamble (findBoard + listBoards)",
    serial: async () => {
      await findBoard(node, cfg, "default");
      await listBoards(node, cfg);
    },
    concurrent: async () => {
      await Promise.all([findBoard(node, cfg, "default"), listBoards(node, cfg)]);
    },
  },
];

const results = new Map<string, { serial: number[]; concurrent: number[] }>();
for (const c of cases) results.set(c.name, { serial: [], concurrent: [] });

for (let i = 1; i <= reps; i++) {
  console.log(` rep ${i}`);
  for (const c of cases) {
    // Alternate which shape goes first, so a warming effect within the rep
    // cannot systematically favour one of them.
    const serialFirst = i % 2 === 1;
    const a = serialFirst ? await ms(c.serial) : await ms(c.concurrent);
    const b = serialFirst ? await ms(c.concurrent) : await ms(c.serial);
    const tSerial = serialFirst ? a : b;
    const tConc = serialFirst ? b : a;
    results.get(c.name)!.serial.push(tSerial);
    results.get(c.name)!.concurrent.push(tConc);
    console.log(
      `   ${c.name.padEnd(44)} serial=${String(tSerial).padStart(5)}ms  concurrent=${String(tConc).padStart(5)}ms`,
    );
  }
}

const med = (xs: number[]) => xs.slice().sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log(`\n== median of ${reps} interleaved reps ==`);
for (const c of cases) {
  const r = results.get(c.name)!;
  const s = med(r.serial);
  const k = med(r.concurrent);
  const wins = r.serial.filter((v, i) => r.concurrent[i] < v).length;
  console.log(
    `  ${c.name.padEnd(44)} serial=${String(s).padStart(5)}ms  concurrent=${String(k).padStart(5)}ms  ` +
      `${(s / k).toFixed(2)}x   concurrent won ${wins}/${reps} reps`,
  );
}
