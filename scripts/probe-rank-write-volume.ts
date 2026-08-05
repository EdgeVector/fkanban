#!/usr/bin/env bun
/**
 * Probe: how many gated BoardCards writes does one `rank` run actually cost,
 * and how many does the resulting ORDER require?
 *
 * `rank` assigns `position = (i + 1) * RANK_POSITION_STEP` over the whole
 * column, so every card below an insertion point is rewritten even though its
 * neighbours are unchanged. Each of those is one `(molecule, hash)` gate
 * acquisition on the `default` board partition
 * (papercut-kanban-board-cards-partition-gate-is-the-board-write-bottleneck).
 *
 * The order a rank produces is a PERMUTATION. Realizing it does not require
 * renumbering every card — only enough of them that the retained positions are
 * strictly increasing in target order. The minimum number of cards that must
 * move is `n - LIS`, where LIS is the longest strictly-increasing subsequence
 * of the CURRENT positions read in TARGET order.
 *
 * This probe reports both, so the fix is sized before it is written.
 *
 * Read-only — computes the same order `rankCmd` would and writes nothing.
 * Run: bun scripts/probe-rank-write-volume.ts [--board default] [--column todo]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  RANK_POSITION_STEP,
  isMetaCardKind,
  listBoardCardsWithBodies,
  listMilestonesOnBoard,
  rankCards,
} from "../src/record.ts";
import {
  isFrontierMilestoneState,
  rankCardsHardTodo,
  type HardTodoRankContext,
} from "../src/pickup_lanes.ts";
import { planRankPositions } from "../src/rank_positions.ts";

const argOf = (name: string, fallback: string): string => {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1]! : fallback;
};

const BOARD = argOf("board", "default");
const COLUMN = argOf("column", "todo");
const MODE = argOf("mode", "hard");

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

/** Length of the longest strictly-increasing subsequence of `xs`. */
function lisLength(xs: number[]): number {
  // tails[k] = smallest possible tail of an increasing subsequence of length k+1
  const tails: number[] = [];
  for (const x of xs) {
    // strictly increasing -> lower_bound
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < x) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = x;
  }
  return tails.length;
}

const all = await listBoardCardsWithBodies(node, cfg);
const inColumn = all.filter((c) => c.board === BOARD && c.column === COLUMN && !isMetaCardKind(c.kind));

let ctx: HardTodoRankContext | undefined;
if (MODE === "hard") {
  try {
    const milestones = await listMilestonesOnBoard(node, cfg, BOARD);
    ctx = {
      frontierMilestones: new Set(
        milestones.filter((m) => isFrontierMilestoneState(m.state)).map((m) => m.slug),
      ),
    };
  } catch {
    ctx = {};
  }
}

const ranked = MODE === "hard" ? rankCardsHardTodo(inColumn, ctx) : rankCards(inColumn);
const n = ranked.length;

// What ships today: dense renumber, skip the ones already at their dense slot.
let denseWrites = 0;
for (let i = 0; i < n; i++) {
  if (ranked[i]!.position !== String((i + 1) * RANK_POSITION_STEP)) denseWrites++;
}

// Lower bound: cards whose CURRENT position already sits in increasing order
// along the target sequence may keep it. Everything else must be written.
const current = ranked.map((c) => Number(c.position));
const parsable = current.every((v) => Number.isFinite(v));
const keep = parsable ? lisLength(current) : 0;
const minimalWrites = n - keep;

// How much room is there between retained anchors? A minimal-write scheme needs
// to fit the movers into the gaps, so report the tightest one.
const sorted = [...current].filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
let tightestGap = Number.POSITIVE_INFINITY;
for (let i = 1; i < sorted.length; i++) {
  const gap = sorted[i]! - sorted[i - 1]!;
  if (gap > 0 && gap < tightestGap) tightestGap = gap;
}

// What the shipped planner actually decides, against the same live order.
const plan = planRankPositions(ranked.map((c) => c.position), RANK_POSITION_STEP);
let planOrdered = true;
for (let i = 1; i < plan.positions.length; i++) {
  if (!(plan.positions[i]! > plan.positions[i - 1]!)) planOrdered = false;
}

console.log(`board=${BOARD} column=${COLUMN} mode=${MODE}`);
console.log(`  cards ranked                 ${String(n).padStart(6)}`);
console.log(`  positions all numeric        ${String(parsable).padStart(6)}`);
console.log(`  dense renumber writes (now)  ${String(denseWrites).padStart(6)}`);
console.log(`  order-required writes (LIS)  ${String(minimalWrites).padStart(6)}`);
console.log(`  retained (already in order)  ${String(keep).padStart(6)}`);
console.log(`  tightest gap between rows    ${String(tightestGap).padStart(6)}`);
console.log(`  planner writes (shipped)     ${String(plan.writeIndices.length).padStart(6)}`);
console.log(`  planner compacted            ${String(plan.compacted).padStart(6)}`);
console.log(`  planner order strictly inc.  ${String(planOrdered).padStart(6)}`);
const saved = denseWrites - plan.writeIndices.length;
console.log(
  `  gated writes avoided         ${String(saved).padStart(6)}` +
    (denseWrites > 0 ? `  (${((saved / denseWrites) * 100).toFixed(0)}% of this run)` : ""),
);
