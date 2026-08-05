#!/usr/bin/env bun
/**
 * Probe: is the one stale field stale BECAUSE it is a partition key?
 *
 * ## The observation this has to explain
 *
 * `probe-per-field-readback-freshness.ts` writes one BoardCards row and then
 * polls all 24 fields off a single write. 3/3 reps, unambiguous:
 *
 *   17 of 18 varied fields fresh at  5ms
 *   `milestone`                      935-1798ms
 *
 * It is not field position — `pr_url` and `branch` sit AFTER `milestone` in the
 * projection and are fresh. It is that one field.
 *
 * ## The candidate mechanism, and why it is not a guess
 *
 * `board_cards` and `milestone_cards` are ONE node schema bound to two lookups
 * by a multi-key catalog expand (the standing rule in CLAUDE.md: same product,
 * different lookup keys, keep BOTH indexes). `src/schemas.ts` records the
 * consequence measured on the primary 2026-08-04: the live `board_cards` pin
 * reports `hash_field=milestone`, which is exactly why
 * `checkPinnedSchemaIdentity` compares `range_field` strictly and `hash_field`
 * loosely.
 *
 * So `milestone` is not an ordinary payload field on these rows. It is the
 * declared HASH (partition) field of the schema they are written into, and
 * changing it re-places the row in the sibling partition. If the node defers
 * that re-placement past the ack while serving payload fields resident-first,
 * then `milestone` reading stale is not a quirk of one field name — it is the
 * partition key lagging, and every other field being fresh is the same fact.
 *
 * ## The prediction, which is what makes this a test rather than a story
 *
 * If the lag is re-placement, the row should be INVISIBLE in its new
 * `milestone` partition for the same window in which the `milestone` field
 * reads stale — the two are then one event seen from two sides. If instead the
 * row appears in its new partition immediately while the field still reads
 * stale, re-placement is NOT the mechanism and the candidate dies.
 *
 * It also splits by read shape, which is the axis the ratified no-stale-reads
 * law turns on (`decision-2026-08-05-no-stale-reads-after-ack`): only HashKey
 * POINT reads are resident-first on this node today. So each poll asks three
 * questions at once, off ONE write:
 *
 *   1. `milestone` field, via the BoardCards prefix read (the known-stale one)
 *   2. row present under the NEW milestone partition, HashKey point read
 *   3. row absent from the OLD milestone partition, HashKey point read
 *
 * Whichever way it comes out, the answer is worth having: (2) and (3) are the
 * reads `milestone detail` and `milestone reconcile` actually issue.
 *
 * Writes to stamped `zz-` partitions no Board record points at; every row is
 * deleted. Labelled `kanban-probe`.
 *
 * ## Result 2026-08-05 — the prediction FAILED, and that is the useful part
 *
 *   rep 1  seeded-in-old=false  ack   93ms  field 1388ms  arrived-in-new >9000ms
 *   rep 2  seeded-in-old=false  ack  105ms  field 1130ms  arrived-in-new >9000ms
 *
 * The row is not in a `milestone`-keyed partition BEFORE the write
 * (`seeded-in-old=false`) and never arrives in one after it. `HashKey=<the
 * milestone value>` on this schema returns nothing at all: despite the catalog
 * declaring `hash_field = "milestone"`, rows are physically partitioned by the
 * `keyHash` the client supplies, which is `board`. `milestone_cards` is a
 * SEPARATE pinned schema (different hash) that this app dual-writes; it is not
 * a projection the node maintains off these rows.
 *
 * So deferred re-placement is **falsified** as the mechanism. What survives is
 * the correlation, which is still worth having and is still sharp: the one
 * field on this row that reads stale is exactly the one the node's catalog
 * names as the partition key, on a schema whose rows are keyed by a different
 * field. Why that costs ~1.4s of read-after-ack is open, and belongs to the
 * node, not to this repo — `lastdb-read-after-ack-conformance-bar` is where it
 * should be settled, with a per-FIELD arm.
 *
 * Kept because a falsified prediction that took two reps is cheaper to read
 * than to re-run, and because `seeded-in-old=false` is itself a fact about this
 * schema that no other probe here records.
 *
 * Run: bun scripts/probe-partition-key-field-is-the-stale-one.ts
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
const schemaHash = boardCardsHash(cfg)!;

const REPS = Number(process.env.REPS ?? 3);
const POLL_MS = 50;
const GIVE_UP_MS = 9000;
const SETTLE_MS = 3500;

const SLUG = "zz-subject";
const SK = `todo#00000001#${SLUG}`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function row(board: string, milestone: string, gen: number) {
  return {
    board, sk: SK, slug: SLUG, column: "todo", position: "00000001",
    layout: BOARD_CARDS_LAYOUT, title: `t${gen}`, assignee: `a${gen}`,
    created_by: "probe", db: `d${gen}`, repo: `r${gen}`, base: `b${gen}`,
    kind: "task", block_status: "clear", block_reason: `br${gen}`,
    north_star: `ns${gen}`, milestone, pr_url: `https://x.invalid/${gen}`,
    branch: `b${gen}`, tags: [`g${gen}`], deps: [], surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  } as Record<string, unknown>;
}

/** (1) The BoardCards prefix read — what `readWholeBoardCardRow` issues. */
async function readMilestoneField(board: string): Promise<string> {
  const filter = { HashRangePrefix: { hash: board, prefix: SK } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const fl = r.fields as Record<string, unknown>;
    if (fl.sk === SK) return (fl.milestone as string) ?? "";
  }
  return "<absent>";
}

/** (2)/(3) HashKey point read on a milestone partition — is our sk in it? */
async function inMilestonePartition(milestone: string): Promise<boolean> {
  const filter = { HashKey: milestone } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  return res.results.some((r) => (r.fields as Record<string, unknown>).sk === SK);
}

type Rep = { ack: number; field: number | null; arrived: number | null; departed: number | null };
const reps: Rep[] = [];

console.log(`reps=${REPS}  settle=${SETTLE_MS}ms  poll=${POLL_MS}ms  give-up=${GIVE_UP_MS}ms\n`);

for (let rep = 1; rep <= REPS; rep += 1) {
  const stamp = Date.now();
  const board = `zz-pk-${stamp}-${Math.round(performance.now() * 1000) % 100000}`;
  const oldMs = `zz-ms-old-${stamp}`;
  const newMs = `zz-ms-new-${stamp}`;

  await node.createRecord({ schemaHash, fields: row(board, oldMs, 1), keyHash: board, rangeKey: SK });
  await sleep(SETTLE_MS);

  // Sanity: the row must be in its OLD partition before we move it, or (3)
  // measures nothing. Reported, not assumed.
  const seeded = await inMilestonePartition(oldMs);

  const t0 = performance.now();
  await node.updateRecord({ schemaHash, fields: row(board, newMs, 2), keyHash: board, rangeKey: SK });
  const ack = performance.now() - t0;

  let field: number | null = null;
  let arrived: number | null = null;
  let departed: number | null = null;
  const deadline = performance.now() + GIVE_UP_MS;
  for (;;) {
    const at = Math.max(0, performance.now() - t0 - ack);
    if (field === null && (await readMilestoneField(board)) === newMs) field = at;
    if (arrived === null && (await inMilestonePartition(newMs))) arrived = at;
    if (departed === null && !(await inMilestonePartition(oldMs))) departed = at;
    if (field !== null && arrived !== null && departed !== null) break;
    if (performance.now() > deadline) break;
    await sleep(POLL_MS);
  }

  reps.push({ ack, field, arrived, departed });
  const fmt = (x: number | null) => (x === null ? `>${GIVE_UP_MS}ms` : `${x.toFixed(0)}ms`);
  console.log(
    `rep ${rep}  seeded-in-old=${seeded}  ack ${ack.toFixed(0).padStart(5)}ms  ` +
      `field ${fmt(field).padStart(8)}  arrived-in-new ${fmt(arrived).padStart(8)}  ` +
      `gone-from-old ${fmt(departed).padStart(8)}`,
  );

  await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: SK });
}

const med = (xs: Array<number | null>) => {
  const s = xs.filter((x): x is number => x !== null).sort((a, b) => a - b);
  if (!s.length) return "never";
  return `${(s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2).toFixed(0)}ms`;
};
console.log(
  `\nmedian:  milestone field ${med(reps.map((r) => r.field))}` +
    `   arrived in new partition ${med(reps.map((r) => r.arrived))}` +
    `   gone from old partition ${med(reps.map((r) => r.departed))}`,
);
console.log(
  "\nIf field-lag and arrival-lag match, the stale field IS the deferred re-placement.\n" +
    "If arrival is immediate while the field lags, re-placement is NOT the mechanism.",
);
