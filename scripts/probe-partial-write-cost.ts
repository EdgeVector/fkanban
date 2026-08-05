#!/usr/bin/env bun
/**
 * Probe: does a BoardCards write get cheaper when you send fewer fields?
 *
 * Every non-move card mutation (tag, claim, pr_url, block_status) reaches
 * `upsertBoardCard`, which reads the stored row first so it can send only the
 * fields that changed. That read is on the hot path of every metadata write in
 * the product, and the table in `upsertBoardCard`'s docstring — the argument
 * that the read pays for itself — came from this probe. So this probe has to be
 * able to carry that weight.
 *
 * ## Why this was rewritten (2026-08-05)
 *
 * The previous version ran its arms in a FIXED order, A B D C, every rep. Slot
 * and arm were therefore the same variable, and it printed a confident verdict
 * anyway. It also took the median of THREE samples and reported the difference
 * between two of them to the millisecond.
 *
 * Re-run on the post-15:40Z binary it produced, from its own output:
 *
 *     A  24 fields, 24 changed    655ms
 *     D  24 fields,  2 changed   1708ms   (261% of A)
 *     C   4 fields,  2 changed   1330ms   (203% of A)
 *
 * A changes twelve times as many fields as D and measured a third of its cost.
 * If payload width or changed-field count drove cost that ordering is
 * impossible, so the number being reported was not the effect. Arm D's own
 * three samples spanned 1559–4270ms while the headline difference it announced
 * (D − C) was 378ms — the spread was seven times the effect.
 *
 * This is the same defect `probe-boardcards-per-field-cost.ts` was fixed for on
 * 2026-08-04, and it is fixed the same way, because the lesson generalizes: a
 * probe that cannot reproduce its own ordering must say so instead of ranking.
 *
 *   1. **Arms are shuffled per rep**, so no arm owns a slot.
 *   2. **Every arm gets the same untimed setup write**, so its precondition is
 *      established rather than inherited from whichever arm ran before it. The
 *      old B arm only measured a no-op because A happened to precede it; that
 *      was a property of the ORDER, not of the arm.
 *   3. **The noise floor is measured in-run** as the median within-arm IQR, and
 *      a difference narrower than the floor is printed as `~noise` rather than
 *      as a finding.
 *   4. **Reps default to 8** and are settable: `bun scripts/probe-partial-write-cost.ts 20`.
 *
 * ## The arms
 *
 *   A  24 fields sent, all 24 values changed
 *   B  24 fields sent, every value byte-identical to what is stored
 *   D  24 fields sent, 2 changed        <- what a wide upsert would cost today
 *   C   4 fields sent, the same 2 changed  <- what the narrow path sends instead
 *
 * D − C is the whole question: it is what `upsertBoardCard`'s pre-write read is
 * spent to buy. If it does not clear the floor, the read is buying nothing and
 * the narrow path is a round trip the product pays for on every metadata write.
 * B is the control for whether the node skips byte-identical molecules at all.
 *
 * Writes land on a scratch board key that no Board record points at, so the
 * live board list never sees them; the row is deleted at the end. Traffic is
 * labelled `kanban-probe` so it does not bill to `client=kanban` in
 * `lastdb ops` — the previous version sent the default label and its writes
 * were indistinguishable from a user's.
 *
 * Run: bun scripts/probe-partial-write-cost.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardsHash } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const REPS = Math.max(3, Number(process.argv[2] ?? 8) || 8);
const BOARD = `zz-probe-partial-${Date.now()}`;
const SLUG = "zz-probe-card";
const SK = `todo#00000001#${SLUG}`;

/** Full 24-field row. `gen` varies every non-key value so the write is real. */
function fullFields(gen: number): Record<string, unknown> {
  return {
    board: BOARD,
    sk: SK,
    slug: SLUG,
    title: `probe card gen ${gen}`,
    column: "todo",
    position: "1",
    assignee: `agent-${gen}`,
    tags: [`gen-${gen}`],
    deps: [],
    surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z",
    created_by: "probe",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    db: `db-${gen}`,
    repo: `EdgeVector/probe-${gen}`,
    base: `main-${gen}`,
    kind: "task",
    block_status: gen % 2 === 0 ? "blocked" : "clear",
    block_reason: `reason ${gen}`,
    north_star: `ns-${gen}`,
    milestone: `ms-${gen}`,
    pr_url: `https://example.invalid/${gen}`,
    branch: `branch-${gen}`,
    layout: BOARD_CARDS_LAYOUT,
  };
}

/** The narrow shape a tag/claim write sends: keys + only what changed. */
function partialFields(gen: number): Record<string, unknown> {
  return {
    board: BOARD,
    sk: SK,
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

/** The whole 24-field row, of which only tags + updated_at differ from stored. */
function wideButTwoChangedFields(base: number, gen: number): Record<string, unknown> {
  return {
    ...fullFields(base),
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

const update = (fields: Record<string, unknown>) =>
  node.updateRecord({ schemaHash, fields, keyHash: BOARD, rangeKey: SK });

type ArmId = "A" | "B" | "C" | "D";
const ARM_LABEL: Record<ArmId, string> = {
  A: "A  24 fields, all 24 CHANGED",
  B: "B  24 fields, all IDENTICAL",
  D: "D  24 fields, 2 CHANGED (wide upsert)",
  C: "C   4 fields, 2 CHANGED (narrow path)",
};

/**
 * One timed sample. `setupGen` is written WIDE and UNTIMED first, so every arm
 * starts from an identically-known stored row no matter which arm preceded it.
 */
async function sample(arm: ArmId, setupGen: number, writeGen: number): Promise<number> {
  await update(fullFields(setupGen));
  const fields =
    arm === "A"
      ? fullFields(writeGen)
      : arm === "B"
        ? fullFields(setupGen)
        : arm === "D"
          ? wideButTwoChangedFields(setupGen, writeGen)
          : partialFields(writeGen);
  const t0 = performance.now();
  await update(fields);
  return performance.now() - t0;
}

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const iqr = (xs: readonly number[]) => quantile(xs, 0.75) - quantile(xs, 0.25);

console.log(`schema ${schemaHash.slice(0, 12)}…  board ${BOARD}  reps=${REPS}`);
console.log(`client=kanban-probe (writes do NOT bill to client=kanban)\n`);

console.log("== seed ==");
let gen = 1;
const tSeed = performance.now();
await node.createRecord({ schemaHash, fields: fullFields(gen), keyHash: BOARD, rangeKey: SK });
console.log(`  createRecord (24 fields)  ${(performance.now() - tSeed).toFixed(0)}ms`);

const samples: Record<ArmId, number[]> = { A: [], B: [], C: [], D: [] };
const ARMS: ArmId[] = ["A", "B", "C", "D"];

console.log(`\n== ${REPS} reps, arm order shuffled per rep ==`);
for (let r = 0; r < REPS; r += 1) {
  // Fisher-Yates on a fresh copy: the point is that no arm owns a slot.
  const order = [...ARMS];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const timings: string[] = [];
  for (const arm of order) {
    gen += 1;
    const setupGen = gen;
    gen += 1;
    const dt = await sample(arm, setupGen, gen);
    samples[arm].push(dt);
    timings.push(`${arm}=${dt.toFixed(0)}`);
  }
  console.log(`  rep ${String(r + 1).padStart(2)}  order ${order.join("")}  ${timings.join(" ")}`);
}

console.log("\n== did the narrow write preserve the other 22 fields? ==");
// Land a narrow write last so the check below is about arm C's shape.
gen += 1;
await update(fullFields(gen));
const storedGen = gen;
gen += 1;
await update(partialFields(gen));
const wide = await node.queryAll({
  schemaHash,
  fields: [...BOARD_CARDS_FIELDS],
  filter: { HashKey: BOARD } as never,
});
const row = wide.results[0]?.fields as Record<string, unknown> | undefined;
if (!row) {
  console.log("  ROW NOT RETURNED at the 24-field projection — the narrow write DROPPED fields.");
} else {
  const missing = BOARD_CARDS_FIELDS.filter((f) => row[f] === undefined || row[f] === null);
  console.log(`  row returned; fields missing/null: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`  title = ${JSON.stringify(row.title)}   (must still read gen ${storedGen})`);
  console.log(`  tags  = ${JSON.stringify(row.tags)}   (set by the narrow write, gen ${gen})`);
}

// The floor: how much an IDENTICAL operation moves run to run. Any difference
// between two arms narrower than this is a difference this probe cannot see.
const floor = median(ARMS.map((a) => iqr(samples[a])));

console.log(`\n== per-arm distribution (${REPS} samples each) ==`);
for (const arm of ARMS) {
  const xs = samples[arm];
  console.log(
    `  ${ARM_LABEL[arm].padEnd(40)} med=${median(xs).toFixed(0).padStart(5)}ms` +
      `  p25=${quantile(xs, 0.25).toFixed(0).padStart(5)}  p75=${quantile(xs, 0.75).toFixed(0).padStart(5)}` +
      `  min=${Math.min(...xs).toFixed(0).padStart(5)}  max=${Math.max(...xs).toFixed(0).padStart(5)}`,
  );
}
console.log(`\n  noise floor (median within-arm IQR): ${floor.toFixed(0)}ms`);
console.log("  A difference smaller than the floor is not a result. Raise reps to lower it.");

/** Report a comparison only when the two arms' interquartile ranges are disjoint. */
function verdict(left: ArmId, right: ArmId, question: string) {
  const l = samples[left];
  const r = samples[right];
  const delta = median(l) - median(r);
  const disjoint = quantile(l, 0.25) > quantile(r, 0.75) || quantile(r, 0.25) > quantile(l, 0.75);
  const clears = Math.abs(delta) >= floor && disjoint;
  const tag = clears ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}ms` : "~noise";
  console.log(`  ${left}−${right}  ${tag.padStart(9)}   ${question}`);
  if (!clears) {
    console.log(
      `           (|Δ|=${Math.abs(delta).toFixed(0)}ms vs floor ${floor.toFixed(0)}ms, IQRs ` +
        `${disjoint ? "disjoint" : "OVERLAP"} — this probe cannot separate them)`,
    );
  }
  return clears;
}

console.log("\n== verdict ==");
const narrowingPays = verdict("D", "C", "what upsertBoardCard's pre-write read buys");
verdict("A", "B", "does the node skip byte-identical molecules?");
const widthDrives = verdict("A", "D", "does sending 24 changed cost more than 24 with 2 changed?");

console.log("");
if (!narrowingPays) {
  console.log("  D ~= C: narrowing the payload buys nothing this probe can measure.");
  console.log("  If that holds across runs, upsertBoardCard's pre-write read is a round");
  console.log("  trip spent for no saving — see its docstring before acting on it.");
}
if (widthDrives && median(samples.A) < median(samples.D)) {
  console.log("  WARNING: A (24 changed) measured CHEAPER than D (2 changed) by more than");
  console.log("  the floor. Changed-field count cannot be what this is costing. Do not");
  console.log("  report either arm as a per-field cost until that inversion is explained.");
}

console.log("\n== cleanup ==");
const tDel = performance.now();
await node.deleteRecord({ schemaHash, keyHash: BOARD, rangeKey: SK });
console.log(`  deleteRecord  ${(performance.now() - tDel).toFixed(0)}ms`);
