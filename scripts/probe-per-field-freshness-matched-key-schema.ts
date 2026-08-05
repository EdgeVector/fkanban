#!/usr/bin/env bun
/**
 * Probe: does the read-after-ack lag follow the catalog-DECLARED key field in
 * general, or only where the declared key and the client-supplied key DISAGREE?
 *
 * ## Why this exists
 *
 * `probe-per-field-readback-freshness.ts` established that read-after-ack on
 * this node is per FIELD, not per row: after one BoardCards write in which
 * every field carries a new value, 17 of 18 varied fields read fresh at 5ms and
 * `milestone` alone lagged ~0.9-1.8s. The one property that singles `milestone`
 * out is that the node's catalog declares it the schema's partition key while
 * the app supplies `board` — the multi-key expand artifact.
 *
 * That left a fork the correlation cannot settle, and it is the whole question:
 *
 *   H_disagree   the lag needs declared != supplied. It is an expand artifact.
 *   H_sibling    the lag hits whichever field is the OTHER member of the
 *                multi-key pair, symmetrically, whichever way round you write.
 *
 * ## Why BoardCards and MilestoneCards are a controlled pair
 *
 * These two schemas are the same 24 field NAMES, the same HashRange shape, the
 * same app, the same write path, and by design the same protein field identity
 * for every shared payload field. They differ in exactly one thing: which of
 * `{board, milestone}` is the supplied partition key.
 *
 *   | schema          | catalog declares | app supplies | agree |
 *   |-----------------|------------------|--------------|-------|
 *   | board_cards     | milestone        | board        | NO    |
 *   | milestone_cards | milestone        | milestone    | YES   |
 *
 * (Both read off the live catalog, not from source: `board_cards` is
 * `39a0424f…` with `key.hash_field = "milestone"`; `milestone_cards` is
 * `511b23e9…` with `key.hash_field = "milestone"`.)
 *
 * So on `milestone_cards` the declared key field is held constant, and `board`
 * — the field that is the SIBLING schema's partition key — is a plain varying
 * payload field. That is the arm BoardCards cannot provide, because there the
 * lagging field only varies freely by virtue of not really being the key.
 *
 * ## Predictions, recorded BEFORE the run
 *
 *   H_disagree  every varied field fresh <100ms, `board` included.
 *   H_sibling   `board` lags ~1s+, every other varied field fresh.
 *
 * The two differ on one cell, so a single run decides it.
 *
 * ## Result 2026-08-05, primary 0.23.2-409-gee967a073, 3/3 reps: H_disagree
 *
 * All 18 varied fields fresh, `board` included — 4ms / 5ms / 8ms, and every
 * other varied field fresh in the same poll. Nothing on this schema lags.
 *
 * The BoardCards control was re-run minutes later in the same session on the
 * same binary and reproduced its lag, so the contrast is not time-of-day:
 *
 *   | schema                  | declares  | supplies  | agree | varying field | med    |
 *   |-------------------------|-----------|-----------|-------|---------------|--------|
 *   | board_cards 39a0424f    | milestone | board     | NO    | milestone     | 1479ms |
 *   | milestone_cards 69e7607 | milestone | milestone | YES   | board         |    5ms |
 *   | both                    |           |           |       | 17 others     |  3-8ms |
 *
 * **H_sibling is falsified.** The lag is not symmetric across the multi-key
 * pair and is not a property of declared key fields in general. It requires the
 * catalog to declare a hash_field the client does not supply, which makes it an
 * artifact of the multi-key expand and puts it on the node, not on this repo.
 *
 * ## Incidental, and deliberately not acted on here
 *
 * `milestoneCardsHash(cfg)` resolves to `69e76079…`, whose catalog entry is
 * `descriptive_name = "Milestone"` with 30 fields — MILESTONE_CARDS_FIELDS
 * plus the milestone RECORD's own `body state driver proof_card proof_status
 * completed_at`. The 24-field `MilestoneCards_hashrange_v1_children_20260723`
 * (`511b23e9…`) also exists in the catalog and is NOT what the app resolves.
 * So Milestone and MilestoneCards appear to share one expanded schema, which
 * is why `listMilestoneCardsPartitionSpine` filters `isForeignLayout` out of
 * the partition — that guard is load-bearing, not defensive dead code. This
 * does not affect the verdict above: the arm only needs declared == supplied,
 * which holds either way. Left as an observation for a run that can measure it.
 *
 * Labelled `kanban-probe`; every row it writes is deleted.
 *
 * Run: bun scripts/probe-per-field-freshness-matched-key-schema.ts
 *      REPS=5 bun scripts/probe-per-field-freshness-matched-key-schema.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { MILESTONE_CARDS_FIELDS, MILESTONE_CARDS_LAYOUT } from "../src/schemas.ts";
import { milestoneCardsHash } from "../src/milestone-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const schemaHash = milestoneCardsHash(cfg);
if (!schemaHash) {
  console.error("no milestone_cards schema hash resolved — is kanban initialised?");
  process.exit(2);
}

const REPS = Number(process.env.REPS ?? 3);
const POLL_MS = 50;
const GIVE_UP_MS = 9000;
const SETTLE_MS = 3500;

const SLUG = "zz-subject";
const SK = `todo#00000001#${SLUG}`;

/**
 * Key/layout fields: not varied by the write, so not measurable.
 *
 * Note this is the MIRROR of the BoardCards probe's HELD set: there `board` is
 * held and `milestone` varies; here `milestone` is held and `board` varies.
 * That inversion is the entire experiment.
 */
const HELD = new Set(["milestone", "sk", "slug", "column", "position", "layout"]);
const VARIED = MILESTONE_CARDS_FIELDS.filter((f) => !HELD.has(f));
const LIST_FIELDS = new Set(["tags", "deps", "surfaces"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function row(milestone: string, gen: number) {
  const v = (name: string) => `${name}-g${gen}`;
  return {
    milestone, sk: SK, slug: SLUG, column: "todo", position: "00000001",
    layout: MILESTONE_CARDS_LAYOUT,
    title: v("title"), assignee: v("assignee"), created_by: v("createdby"),
    db: v("db"), repo: v("repo"), base: v("base"), kind: v("kind"),
    block_status: v("blockstatus"), block_reason: v("blockreason"),
    north_star: v("northstar"), board: v("board"),
    pr_url: v("prurl"), branch: v("branch"),
    tags: [v("tags")], deps: [v("deps")], surfaces: [v("surfaces")],
    created_at: new Date(1785000000000 + gen * 1000).toISOString(),
    updated_at: new Date(1785000000000 + gen * 2000).toISOString(),
  } as Record<string, unknown>;
}

/** The same shape `listMilestoneCardsPartitionSpine` issues (src/milestone-cards.ts). */
async function readRow(milestone: string): Promise<Record<string, unknown> | null> {
  const filter = { HashRangePrefix: { hash: milestone, prefix: SK } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...MILESTONE_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const fl = r.fields as Record<string, unknown>;
    if (fl.sk === SK) return fl;
  }
  return null;
}

function matches(seen: unknown, want: unknown, field: string): boolean {
  if (LIST_FIELDS.has(field)) {
    const a = Array.isArray(seen) ? seen : [];
    return a.length === 1 && a[0] === (want as string[])[0];
  }
  return seen === want;
}

const perField = new Map<string, Array<number | null>>();
for (const f of VARIED) perField.set(f, []);

console.log(`schema milestone_cards ${schemaHash.slice(0, 12)}…  (declared key = supplied key = "milestone")`);
console.log(`reps=${REPS}  settle=${SETTLE_MS}ms  poll=${POLL_MS}ms  give-up=${GIVE_UP_MS}ms`);
console.log(`measuring ${VARIED.length} varied fields (${HELD.size} held: ${[...HELD].join(", ")})`);
console.log(`WATCH "board": H_disagree says fresh, H_sibling says ~1s+\n`);

for (let rep = 1; rep <= REPS; rep += 1) {
  const milestone = `zz-perfield-ms-${Date.now()}-${Math.round(performance.now() * 1000) % 100000}`;
  const gen = rep * 10;

  await node.createRecord({ schemaHash, fields: row(milestone, gen), keyHash: milestone, rangeKey: SK });
  await sleep(SETTLE_MS);

  const want = row(milestone, gen + 1);
  const t0 = performance.now();
  await node.updateRecord({ schemaHash, fields: want, keyHash: milestone, rangeKey: SK });
  const ack = performance.now() - t0;

  const firstFresh = new Map<string, number>();
  const deadline = performance.now() + GIVE_UP_MS;
  for (;;) {
    const seen = await readRow(milestone);
    const at = Math.max(0, performance.now() - t0 - ack);
    if (seen) {
      for (const f of VARIED) {
        if (!firstFresh.has(f) && matches(seen[f], want[f], f)) firstFresh.set(f, at);
      }
    }
    if (firstFresh.size === VARIED.length) break;
    if (performance.now() > deadline) break;
    await sleep(POLL_MS);
  }

  for (const f of VARIED) perField.get(f)!.push(firstFresh.get(f) ?? null);

  const freshNow = VARIED.filter((f) => (firstFresh.get(f) ?? Infinity) < 100).length;
  const boardAt = firstFresh.get("board");
  console.log(
    `rep ${rep}  ack ${ack.toFixed(0).padStart(5)}ms  ` +
      `${freshNow}/${VARIED.length} fields fresh within 100ms  ` +
      `board=${boardAt === undefined ? ">give-up" : `${boardAt.toFixed(0)}ms`}`,
  );

  await node.deleteRecord({ schemaHash, keyHash: milestone, rangeKey: SK });
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${"#".padStart(2)} ${"field".padEnd(14)} ${"med fresh".padStart(10)}   per-rep`);
MILESTONE_CARDS_FIELDS.forEach((f, i) => {
  if (HELD.has(f)) {
    console.log(`${String(i).padStart(2)} ${f.padEnd(14)} ${"(held)".padStart(10)}`);
    return;
  }
  const xs = perField.get(f)!;
  const ok = xs.filter((x): x is number => x !== null);
  const cells = xs.map((x) => (x === null ? ">give-up" : `${x.toFixed(0)}ms`)).join("  ");
  const m = ok.length ? `${med(ok).toFixed(0)}ms` : "—";
  console.log(`${String(i).padStart(2)} ${f.padEnd(14)} ${m.padStart(10)}   ${cells}`);
});

const boardXs = perField.get("board")!.filter((x): x is number => x !== null);
const others = VARIED.filter((f) => f !== "board")
  .flatMap((f) => perField.get(f)!)
  .filter((x): x is number => x !== null);
const boardMed = boardXs.length ? med(boardXs) : NaN;
const otherMed = others.length ? med(others) : NaN;
console.log(`\nboard med ${boardMed.toFixed(0)}ms vs all-other-varied med ${otherMed.toFixed(0)}ms`);
console.log(
  boardMed > 500
    ? "VERDICT: board lags -> H_sibling. The lag is symmetric across the multi-key pair."
    : "VERDICT: board is fresh -> H_disagree. The lag needs declared != supplied.",
);
