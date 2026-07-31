#!/usr/bin/env bun
/**
 * Probe: does a BoardCards write get cheaper when you send fewer fields?
 *
 * Every non-move card mutation (tag, claim, pr_url, block_status) currently
 * goes through `upsertBoardCard`, which rewrites all 24 fields. Brain
 * `lastdb-write-cost-decomposed-one-card-write-is-24-molecules-plus-a-serial-sibling-fold`
 * measured that a write costs 24 atoms + 24 molecules + one serial protein
 * sibling fold PER MUTATED FIELD, so cost should scale with field count — but
 * only if LastDB actually writes what you send and does not silently rewrite
 * the whole row (or, conversely, skip molecules whose value is unchanged).
 *
 * Three arms, interleaved so node warm-up cannot bias one:
 *   A  update all 24 fields, every value CHANGED
 *   B  update all 24 fields, every value IDENTICAL to what is stored
 *   C  update 3 fields, changed (the shape a tag/claim write would use)
 *
 * B is the open question from the 2026-07-31d chief-engineer checkpoint: if
 * B ~= A, the node does not skip byte-identical molecules, and narrowing the
 * field set is the only lever.
 *
 * Writes land on a scratch board key that no Board record points at, so the
 * live board list never sees them; rows are deleted at the end.
 *
 * Run: bun scripts/probe-partial-write-cost.ts
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
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const BOARD = `zz-probe-partial-${Date.now()}`;
const SLUG = "zz-probe-card";
const SK = `todo#00000001#${SLUG}`;

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(44)} ${dt.toFixed(0).padStart(6)}ms`);
  return [v, dt];
};

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

/** The narrow shape a tag/claim write would send: keys + only what changed. */
function partialFields(gen: number): Record<string, unknown> {
  return {
    board: BOARD,
    sk: SK,
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

/**
 * What `upsertBoardCard` sends TODAY on a tag/claim: the whole 24-field row,
 * of which only tags + updated_at differ from what is stored. If the node
 * skips byte-identical molecules (arm B), this should cost the same as the
 * narrow arm C — i.e. narrowing the payload would buy nothing.
 */
function wideButTwoChangedFields(base: number, gen: number): Record<string, unknown> {
  return {
    ...fullFields(base),
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

const update = (fields: Record<string, unknown>) =>
  node.updateRecord({ schemaHash, fields, keyHash: BOARD, rangeKey: SK });

console.log(`schema ${schemaHash.slice(0, 12)}…  board ${BOARD}\n`);

console.log("== seed ==");
let gen = 1;
await ms("createRecord (24 fields)", () =>
  node.createRecord({ schemaHash, fields: fullFields(gen), keyHash: BOARD, rangeKey: SK }),
);

const A: number[] = [];
const B: number[] = [];
const C: number[] = [];
const D: number[] = [];
const REPS = 3;

console.log(`\n== ${REPS} interleaved reps ==`);
for (let r = 0; r < REPS; r += 1) {
  console.log(` rep ${r + 1}`);
  gen += 1;
  const base = gen;
  const [, a] = await ms("A  24 fields, all values CHANGED", () => update(fullFields(gen)));
  A.push(a);

  // B re-sends exactly what A just stored — byte-identical, nothing changed.
  const [, b] = await ms("B  24 fields, all values IDENTICAL", () => update(fullFields(gen)));
  B.push(b);

  gen += 1;
  const [, d] = await ms("D  24 fields, 2 CHANGED (today's tag)", () =>
    update(wideButTwoChangedFields(base, gen)),
  );
  D.push(d);

  gen += 1;
  const [, c] = await ms("C   4 fields (2 keys + 2 changed)", () => update(partialFields(gen)));
  C.push(c);
}

console.log("\n== did the partial write preserve the other 22 fields? ==");
const [wide] = await ms("query all 24 fields", () =>
  node.queryAll({
    schemaHash,
    fields: [...BOARD_CARDS_FIELDS],
    filter: { HashKey: BOARD } as never,
  }),
);
const row = wide.results[0]?.fields as Record<string, unknown> | undefined;
if (!row) {
  console.log("  ROW NOT RETURNED at the 24-field projection — partial write DROPPED fields.");
} else {
  const missing = BOARD_CARDS_FIELDS.filter((f) => row[f] === undefined || row[f] === null);
  console.log(`  row returned; fields missing/null: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`  title    = ${JSON.stringify(row.title)}   (survived from arm A/B gen ${gen - 1})`);
  console.log(`  tags     = ${JSON.stringify(row.tags)}   (set by arm C gen ${gen})`);
  console.log(`  repo     = ${JSON.stringify(row.repo)}`);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
console.log("\n== verdict (median of reps) ==");
console.log(`  A  24 fields changed    ${med(A).toFixed(0)}ms`);
console.log(`  B  24 fields identical  ${med(B).toFixed(0)}ms   (${((med(B) / med(A)) * 100).toFixed(0)}% of A)`);
console.log(`  D  24 sent, 2 changed   ${med(D).toFixed(0)}ms   (${((med(D) / med(A)) * 100).toFixed(0)}% of A)  <- what upsertBoardCard does today`);
console.log(`  C   4 fields changed    ${med(C).toFixed(0)}ms   (${((med(C) / med(A)) * 100).toFixed(0)}% of A)`);
console.log(
  `\n  narrowing the payload buys: ${(med(D) - med(C)).toFixed(0)}ms (D - C). ` +
    `If that is ~0, the node already dedupes and payload width is NOT the lever.`,
);

console.log("\n== cleanup ==");
await ms("deleteRecord", () => node.deleteRecord({ schemaHash, keyHash: BOARD, rangeKey: SK }));
