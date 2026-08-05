#!/usr/bin/env bun
/**
 * Probe: how long does one BoardCards row read STALE after its own write acks?
 *
 * ## SCOPE CORRECTION 2026-08-05 — read this before quoting the number below
 *
 * This probe polls ONE witness field, `milestone`, and its ~0.8-2.4s figure is
 * a fact about THAT FIELD, not about the row. `probe-per-field-readback-
 * freshness.ts` writes one row and polls all 24 fields off that single write:
 * 17 of the 18 varied fields are fresh at 5ms and `milestone` alone lags,
 * 3/3 reps. The sibling probe that reported "fresh in 6ms, 11/11" polled `tags`
 * and is equally correct and equally non-general.
 *
 * `probe-freshness-bisect-raw-vs-real-path.ts` settled which factor it is: a
 * five-rung ladder from this probe's configuration to the sibling's moved the
 * number only when the polled FIELD changed — seed path and write path did
 * nothing, 15/15. So the explanations previously attached to this probe — that
 * it writes raw rather than through `writeCardPatch`, and that it hammers one
 * slot — are both retired; `probe-followon-write-drains-deferred-put.ts`
 * measured repeated same-slot writes as FASTER to fresh, not slower.
 *
 * The measurement below stands. Its scope does not: say "`milestone` reads
 * stale for ~1-2s", never "BoardCards reads stale for 1.2-2.4s".
 *
 * Writes a row, then polls the exact query `readWholeBoardCardRow` issues
 * (`HashRangePrefix` on the full sk, 24-field projection) until it reflects the
 * write, printing what it saw at each step.
 *
 * ## Why this is not the same question `probe-readback-lag-by-schema.ts` asked
 *
 * That probe asked whether the FIRST read after an ack is fresh, and recorded
 * BoardCards at 0/6 fresh with a ~514ms lag (2026-08-03). This asks how long
 * the staleness LASTS, because that is the number that matters to a caller
 * which reads in order to decide what to write. Measured 2026-08-05 on the
 * post-15:40Z binary:
 *
 *   | write | ack    | still stale until |
 *   |-------|--------|-------------------|
 *   | ms-2  | 3291ms | ~2.0s after ack   |
 *   | ms-3  |  593ms | ~2.4s after ack   |
 *   | ms-4  |  302ms | ~1.2s after ack   |
 *
 * and a freshly CREATED row read immediately returns `<absent>`, not a partial
 * row. So the window is seconds, not the half-second on record.
 *
 * ## What depends on it
 *
 * `upsertBoardCard`'s narrow path reads this index to diff against, inside that
 * window, on every non-move metadata write. Two consequences, both measured in
 * `probe-prewrite-read-vs-blind-wide.ts`:
 *
 *   - a genuine no-op diffs against a stale row, "finds" a change that is not
 *     one, and pays a ~2.3s write where the node's own byte-identical skip
 *     would have cost ~60ms (16/16 samples)
 *   - a field whose STALE value already equals what we are about to write is
 *     omitted from the narrow write even when the row's CURRENT value differs,
 *     so the narrow write cannot correct it. A wide write has no such mode.
 *
 * `upsertBoardCard` documents this hazard for its DELETE ordering — "the INDEX
 * lags; the record does not" — and then states that "the production paths do
 * not" read a partition back to decide something. Its own narrow path does.
 *
 * Scratch board key that no Board record points at; the row is deleted at the
 * end. Labelled `kanban-probe`.
 *
 * Run: bun scripts/probe-boardcard-read-after-write-lag.ts
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
const BOARD = `zz-lagcheck-${Date.now()}`;
const SLUG = "zz-subject";
const SK = `todo#00000001#${SLUG}`;

const f = (gen: number) => ({
  board: BOARD, sk: SK, slug: SLUG, title: `t${gen}`, column: "todo", position: "00000001",
  assignee: `a${gen}`, tags: [`g${gen}`], deps: [], surfaces: [],
  created_at: "2026-07-31T00:00:00.000Z", created_by: "probe",
  updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
  db: `d${gen}`, repo: `r${gen}`, base: `b${gen}`, kind: "task",
  block_status: "clear", block_reason: `br${gen}`, north_star: `ns${gen}`,
  milestone: `ms-${gen}`, pr_url: `https://x.invalid/${gen}`, branch: `br${gen}`,
  layout: BOARD_CARDS_LAYOUT,
});

const readWhole = async () => {
  const filter = { HashRangePrefix: { hash: BOARD, prefix: SK } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const fl = r.fields as Record<string, unknown>;
    if (fl.sk !== SK) continue;
    return fl.milestone as string;
  }
  return "<absent>";
};

await node.createRecord({ schemaHash, fields: f(1), keyHash: BOARD, rangeKey: SK });
console.log(`seeded ms-1; immediate read -> ${await readWhole()}`);

for (const gen of [2, 3, 4]) {
  const t0 = performance.now();
  await node.updateRecord({ schemaHash, fields: f(gen), keyHash: BOARD, rangeKey: SK });
  const wrote = performance.now() - t0;
  const seen: string[] = [];
  for (let i = 0; i < 12; i += 1) {
    seen.push(`${((performance.now() - t0) / 1000).toFixed(1)}s:${await readWhole()}`);
    if (seen[seen.length - 1]!.endsWith(`ms-${gen}`)) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  console.log(`wrote ms-${gen} (ack ${wrote.toFixed(0)}ms) -> ${seen.join("  ")}`);
}

await node.deleteRecord({ schemaHash, keyHash: BOARD, rangeKey: SK });
console.log("cleaned up");
