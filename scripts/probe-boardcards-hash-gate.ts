#!/usr/bin/env bun
/**
 * Does BoardCards have the same hash-gate blind spot MilestoneCards had?
 *
 * The rule was established on MilestoneCards
 * (`scripts/probe-projection-rule-constructed.ts`, HASH-ELSE-LEAD 204/0), and
 * `MILESTONE_CARDS_PAYLOAD_FIELDS` fixed the read that tripped over it. The
 * same shape exists here: `board` is BoardCards' HASH field and it sits in
 * `BOARD_CARDS_FIELDS`, `BOARD_CARDS_LIST_FIELDS` and the spine — so every
 * product list read of the board is, if the rule generalises, gated on a
 * payload copy of the partition key.
 *
 * This is the busiest index on the node, so the question is worth an answer
 * rather than an inference from a different index.
 *
 * Read-only.
 *
 *   bun scripts/probe-boardcards-hash-gate.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_LIST_FIELDS } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const bcHash = cfg.schemaHashes!.board_cards!;
const BOARD = "default";

async function ranges(fields: readonly string[]): Promise<Set<string>> {
  const out = new Set<string>();
  try {
    const res = await node.queryAll({
      schemaHash: bcHash,
      fields: [...fields],
      filter: { HashKey: BOARD },
    });
    for (const r of res.results ?? []) {
      if (typeof r.key?.range === "string" && r.key.range) out.add(r.key.range);
    }
  } catch (err) {
    console.log(`  ! [${fields[0]}…] threw: ${String(err).slice(0, 70)}`);
  }
  return out;
}

// Completeness baseline: union over every field as a single-field projection.
const sweep = new Set<string>();
for (const f of BOARD_CARDS_FIELDS) for (const r of await ranges([f])) sweep.add(r);

const withBoard = await ranges(BOARD_CARDS_FIELDS);
const noBoard = await ranges(["slug", ...BOARD_CARDS_FIELDS.filter((f) => f !== "slug" && f !== "board")]);
const listWith = await ranges(BOARD_CARDS_LIST_FIELDS);
const listNo = await ranges(["slug", ...BOARD_CARDS_LIST_FIELDS.filter((f) => f !== "slug" && f !== "board")]);
const boardOnly = await ranges(["board"]);
const slugOnly = await ranges(["slug"]);

console.log(`BoardCards HashKey=${BOARD}`);
console.log(`  sweep (all leads unioned)      ${sweep.size}`);
console.log(`  ["board"] alone                ${boardOnly.size}`);
console.log(`  ["slug"] alone                 ${slugOnly.size}`);
console.log(`  BOARD_CARDS_FIELDS  as-shipped ${withBoard.size}`);
console.log(`  BOARD_CARDS_FIELDS  no-hash    ${noBoard.size}`);
console.log(`  LIST_FIELDS         as-shipped ${listWith.size}`);
console.log(`  LIST_FIELDS         no-hash    ${listNo.size}`);

const gap = sweep.size - withBoard.size;
console.log(
  gap > 0
    ? `\nRED: ${gap} row(s) exist that the shipped wide read cannot see.` +
      (noBoard.size > withBoard.size
        ? ` Dropping the hash field recovers ${noBoard.size - withBoard.size}.`
        : ` Dropping the hash field recovers none — the loss is elsewhere.`)
    : `\nGREEN: every row the sweep reaches is reachable by the shipped read. No live blind spot today.`,
);
console.log(
  boardOnly.size < sweep.size
    ? `NOTE: ${sweep.size - boardOnly.size} row(s) lack a \`board\` atom, so the hash gate is live on this index — the exposure is latent, not absent.`
    : `NOTE: every row carries a \`board\` atom, so the hash gate cannot bite here today.`,
);
