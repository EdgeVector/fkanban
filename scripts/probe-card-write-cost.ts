#!/usr/bin/env bun
/**
 * Probe: what does a `Card` write cost, and does narrowing the payload help?
 *
 * `upsertBoardCard` was narrowed by cr-ms8qsq28-4f3a and a tag/claim dropped
 * from 8.4s to 4.6s. The remaining cost is `Card` + `CardListIndex`, and
 * nothing has profiled `Card` the way BoardCards now has been
 * ([[checkpoint-kanban-chief-engineer-20260731e-narrow-boardcards-write]]).
 *
 * Card differs from BoardCards in the one way that might break the "cost
 * tracks fields SENT, ~200ms each" model: it carries `body`, which is
 * kilobytes, not a short scalar. If cost is per-FIELD the body is one atom
 * like any other and narrowing wins the same ~2x; if cost tracks BYTES the
 * body dominates and narrowing wins far more (a tag write stops shipping the
 * body at all).
 *
 * Arms, interleaved so warm-up cannot bias one:
 *   A  22 fields, every value CHANGED          (worst case)
 *   B  22 fields, every value IDENTICAL        (whole-record dedupe check)
 *   D  22 fields sent, 2 CHANGED               <- what updateCardRecord does today
 *   C   3 fields (key + 2 changed)             <- what a narrowed write would send
 *   E  22 fields, 2 changed, BODY 40x LARGER   (does payload size move cost?)
 *
 * Writes use a scratch slug that no board membership row points at, so the
 * live board never sees it; the row is deleted at the end.
 *
 * Run: bun scripts/probe-card-write-cost.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { CARD_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = schemaHashFor("card", cfg);
if (!schemaHash) {
  console.error("card schema not bound");
  process.exit(1);
}

const SLUG = `zz-probe-card-write-${Date.now()}`;

const ms = async <T>(label: string, fn: () => Promise<T>): Promise<[T, number]> => {
  const t0 = performance.now();
  const v = await fn();
  const dt = performance.now() - t0;
  console.log(`  ${label.padEnd(46)} ${dt.toFixed(0).padStart(6)}ms`);
  return [v, dt];
};

/** A body the size a real card brief actually is (## GOAL / ## END STATE). */
const BODY_UNIT =
  "## GOAL\nNarrow the Card write so a tag mutation stops shipping the whole record.\n\n" +
  "## END STATE\nA `kanban tag add` sends only the fields that changed, proven by a\n" +
  "measured latency drop and a full-projection read that shows every other field\n" +
  "intact afterwards.\n\n";
const BODY = BODY_UNIT.repeat(3);
const BIG_BODY = BODY_UNIT.repeat(120);

/** Full 22-field record. `gen` varies every non-key value so the write is real. */
function fullFields(gen: number, body = BODY): Record<string, unknown> {
  return {
    slug: SLUG,
    title: `probe card gen ${gen}`,
    body: `${body}\ngen ${gen}\n`,
    board: `zz-probe-board-${gen}`,
    column: "todo",
    position: String(gen),
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
  };
}

/** The narrow shape a tag write would send: key + only what changed. */
function partialFields(gen: number): Record<string, unknown> {
  return {
    slug: SLUG,
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

/** What `updateCardRecord` sends TODAY on a tag: all 22, of which 2 differ. */
function wideButTwoChanged(base: number, gen: number, body = BODY): Record<string, unknown> {
  return {
    ...fullFields(base, body),
    tags: [`gen-${gen}`],
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  };
}

const update = (fields: Record<string, unknown>) =>
  node.updateRecord({ schemaHash, fields, keyHash: SLUG });

const bytes = (f: Record<string, unknown>) => JSON.stringify(f).length;
console.log(`schema ${schemaHash.slice(0, 12)}…  slug ${SLUG}`);
console.log(
  `payloads: full=${bytes(fullFields(1))}B  narrow=${bytes(partialFields(1))}B  ` +
    `bigbody=${bytes(fullFields(1, BIG_BODY))}B\n`,
);

console.log("== seed ==");
let gen = 1;
await ms("createRecord (22 fields)", () =>
  node.createRecord({ schemaHash, fields: fullFields(gen), keyHash: SLUG }),
);

const A: number[] = [];
const B: number[] = [];
const C: number[] = [];
const D: number[] = [];
const E: number[] = [];
const REPS = 3;

console.log(`\n== ${REPS} interleaved reps ==`);
for (let r = 0; r < REPS; r += 1) {
  console.log(` rep ${r + 1}`);
  gen += 1;
  const base = gen;
  const [, a] = await ms("A  22 fields, all values CHANGED", () => update(fullFields(gen)));
  A.push(a);

  // B re-sends exactly what A just stored — byte-identical, nothing changed.
  const [, b] = await ms("B  22 fields, all values IDENTICAL", () => update(fullFields(gen)));
  B.push(b);

  gen += 1;
  const [, d] = await ms("D  22 sent, 2 CHANGED (today's tag write)", () =>
    update(wideButTwoChanged(base, gen)),
  );
  D.push(d);

  gen += 1;
  const [, c] = await ms("C   3 fields (key + 2 changed)", () => update(partialFields(gen)));
  C.push(c);

  gen += 1;
  const [, e] = await ms("E  22 sent, 2 changed, body 40x", () =>
    update(wideButTwoChanged(base, gen, BIG_BODY)),
  );
  E.push(e);
}

console.log("\n== did the narrow write preserve the other 20 fields? ==");
const [wide] = await ms("query all 22 fields", () =>
  node.queryAll({
    schemaHash,
    fields: [...CARD_FIELDS],
    filter: { HashKey: SLUG } as never,
  }),
);
const row = wide.results[0]?.fields as Record<string, unknown> | undefined;
if (!row) {
  console.log("  ROW NOT RETURNED at the 22-field projection — narrow write DROPPED fields.");
} else {
  const missing = CARD_FIELDS.filter((f) => row[f] === undefined || row[f] === null);
  console.log(`  row returned; fields missing/null: ${missing.length ? missing.join(", ") : "none"}`);
  console.log(`  title = ${JSON.stringify(row.title)}`);
  console.log(`  tags  = ${JSON.stringify(row.tags)}`);
  console.log(`  body  = ${String(row.body ?? "").length} chars`);
}

const med = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];
const pct = (x: number) => `${((x / med(A)) * 100).toFixed(0)}% of A`;
console.log("\n== verdict (median of reps) ==");
console.log(`  A  22 fields changed      ${med(A).toFixed(0)}ms`);
console.log(`  B  22 fields identical    ${med(B).toFixed(0)}ms   (${pct(med(B))})`);
console.log(`  D  22 sent, 2 changed     ${med(D).toFixed(0)}ms   (${pct(med(D))})  <- today`);
console.log(`  C   3 fields changed      ${med(C).toFixed(0)}ms   (${pct(med(C))})  <- narrowed`);
console.log(`  E  22 sent, 2 chg, big    ${med(E).toFixed(0)}ms   (${pct(med(E))})`);
console.log(
  `\n  narrowing buys: ${(med(D) - med(C)).toFixed(0)}ms (D - C)\n` +
    `  body size costs: ${(med(E) - med(D)).toFixed(0)}ms (E - D). ` +
    `~0 ⇒ cost is per-FIELD, not per-BYTE.`,
);

console.log("\n== cleanup ==");
await ms("deleteRecord", () => node.deleteRecord({ schemaHash, keyHash: SLUG }));
