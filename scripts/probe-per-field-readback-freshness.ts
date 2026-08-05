#!/usr/bin/env bun
/**
 * Probe: after ONE BoardCards write, which of the row's 24 fields read back
 * fresh, and which read back stale — measured per field, off a single write.
 *
 * ## Why this exists
 *
 * `probe-freshness-bisect-raw-vs-real-path.ts` set out to explain why two
 * instruments in this repo disagreed by three orders of magnitude about
 * read-after-ack staleness on this schema. It ran a five-rung ladder from one
 * instrument's configuration to the other's and found, 15/15, that neither the
 * seed path nor the write path moves the number at all:
 *
 *   | arm                    | med time-to-fresh |
 *   |------------------------|-------------------|
 *   | raw seed, raw write, `tags`      |    3ms  |
 *   | card seed, real write, `tags`    |    4ms  |
 *   | raw seed, raw write, `milestone` | 1158ms  |
 *   | card seed, raw write, `milestone`| 1760ms  |
 *   | card seed, real write, `milestone`| 842ms  |
 *
 * The variable is **which field you read**. Same row, same write, same query,
 * same 24-field projection — one field is fresh in 3ms and another is stale for
 * a second or more.
 *
 * That matters well beyond this repo, and it is why the measurement gets its own
 * instrument instead of staying a footnote. Every freshness claim on record here
 * was made by polling ONE witness field, so each of them is really a claim about
 * that field: run (j)'s "the real path reads fresh in 6ms, 11/11" polled `tags`,
 * and `probe-boardcard-read-after-write-lag.ts`'s "1.2-2.4s stale" polled
 * `milestone`. Both are correct and neither generalizes, which is exactly the
 * shape of the four prior instrument-artifact findings in this lane.
 *
 * ## What it does
 *
 * Seeds a row on its own brand-new `zz-` partition, settles, then writes ONE
 * update in which EVERY field carries a new, per-field-distinguishable value.
 * It then polls the exact query `readWholeBoardCardRow` issues and, on each
 * poll, records the first moment each individual field shows its new value.
 *
 * One write, one polling loop, 24 answers — so the fields are compared against
 * each other under identical conditions rather than across runs, and no field
 * can be fresh merely because it was measured at a quieter moment.
 *
 * `board`, `sk`, `slug`, `column`, `position` and `layout` are part of the key
 * or the layout and are not varied; they are reported as `held` rather than
 * silently counted as fresh.
 *
 * Labelled `kanban-probe`; every row it writes is deleted.
 *
 * ## Result 2026-08-05, primary `0.23.2-409-gee967a073`, 3/3 reps
 *
 * Seventeen of eighteen varied fields fresh at **5ms**, every rep:
 * `title` `assignee` `tags` `deps` `surfaces` `created_at` `created_by`
 * `updated_at` `db` `repo` `base` `kind` `block_status` `block_reason`
 * `north_star` `pr_url` `branch`.
 *
 * `milestone`: **1798ms / 1402ms / 935ms**.
 *
 * Not field position — `pr_url` and `branch` follow `milestone` in the
 * projection and are fresh. What singles `milestone` out is that the node's
 * catalog declares it the schema's partition key: the live `board_cards` pin
 * reports `key.hash_field = "milestone"`, read off the catalog on this binary,
 * while every row is written with `keyHash = board` — the multi-key expand
 * artifact `checkPinnedSchemaIdentity` already exists to tolerate.
 *
 * That is a correlation with a named cause, NOT a proven mechanism, and the
 * obvious mechanism is ruled out:
 * `probe-partition-key-field-is-the-stale-one.ts` predicted the row would be
 * re-placed into a `milestone`-keyed partition and found it is never in one,
 * before or after the write. Do not restate this as re-placement.
 *
 * Run: bun scripts/probe-per-field-readback-freshness.ts
 *      REPS=5 bun scripts/probe-per-field-readback-freshness.ts
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

/** Key/layout fields: not varied by the write, so not measurable. */
const HELD = new Set(["board", "sk", "slug", "column", "position", "layout"]);
const VARIED = BOARD_CARDS_FIELDS.filter((f) => !HELD.has(f));
const LIST_FIELDS = new Set(["tags", "deps", "surfaces"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function row(board: string, gen: number) {
  const v = (name: string) => `${name}-g${gen}`;
  return {
    board, sk: SK, slug: SLUG, column: "todo", position: "00000001",
    layout: BOARD_CARDS_LAYOUT,
    title: v("title"), assignee: v("assignee"), created_by: v("createdby"),
    db: v("db"), repo: v("repo"), base: v("base"), kind: v("kind"),
    block_status: v("blockstatus"), block_reason: v("blockreason"),
    north_star: v("northstar"), milestone: v("milestone"),
    pr_url: v("prurl"), branch: v("branch"),
    tags: [v("tags")], deps: [v("deps")], surfaces: [v("surfaces")],
    created_at: new Date(1785000000000 + gen * 1000).toISOString(),
    updated_at: new Date(1785000000000 + gen * 2000).toISOString(),
  } as Record<string, unknown>;
}

/** Exactly what `readWholeBoardCardRow` issues. */
async function readRow(board: string): Promise<Record<string, unknown> | null> {
  const filter = { HashRangePrefix: { hash: board, prefix: SK } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
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

console.log(`reps=${REPS}  settle=${SETTLE_MS}ms  poll=${POLL_MS}ms  give-up=${GIVE_UP_MS}ms`);
console.log(`measuring ${VARIED.length} varied fields (${HELD.size} held: ${[...HELD].join(", ")})\n`);

for (let rep = 1; rep <= REPS; rep += 1) {
  const board = `zz-perfield-${Date.now()}-${Math.round(performance.now() * 1000) % 100000}`;
  const gen = rep * 10;

  await node.createRecord({ schemaHash, fields: row(board, gen), keyHash: board, rangeKey: SK });
  await sleep(SETTLE_MS);

  const want = row(board, gen + 1);
  const t0 = performance.now();
  await node.updateRecord({ schemaHash, fields: want, keyHash: board, rangeKey: SK });
  const ack = performance.now() - t0;

  const firstFresh = new Map<string, number>();
  const deadline = performance.now() + GIVE_UP_MS;
  for (;;) {
    const seen = await readRow(board);
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
  console.log(
    `rep ${rep}  ack ${ack.toFixed(0).padStart(5)}ms  ` +
      `${freshNow}/${VARIED.length} fields fresh within 100ms  ` +
      `(${firstFresh.size}/${VARIED.length} fresh within ${GIVE_UP_MS}ms)`,
  );

  await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: SK });
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${"#".padStart(2)} ${"field".padEnd(14)} ${"med fresh".padStart(10)}   per-rep`);
BOARD_CARDS_FIELDS.forEach((f, i) => {
  if (HELD.has(f)) {
    console.log(`${String(i).padStart(2)} ${f.padEnd(14)} ${"(held)".padStart(10)}`);
    return;
  }
  const xs = perField.get(f)!;
  const ok = xs.filter((x): x is number => x !== null);
  console.log(
    `${String(i).padStart(2)} ${f.padEnd(14)} ` +
      `${(ok.length ? med(ok).toFixed(0) + "ms" : "NEVER").padStart(10)}   ` +
      xs.map((x) => (x === null ? "never" : `${x.toFixed(0)}ms`)).join("  "),
  );
});
