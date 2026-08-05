#!/usr/bin/env bun
/**
 * Probe: after a REAL board mutation, how long until the BoardCards row reads
 * back the new value — and does sending 24 fields instead of 2 change that?
 *
 * This is the safety check on deleting `upsertBoardCard`'s narrow path. Every
 * board read is BoardCards-backed (`list`, `pickup`, `overlap`, `rank`,
 * `milestone portfolio`), so if a wide write stays invisible longer than a
 * narrow one, unconditional wide writes buy correctness by making the board
 * lag — and that trade has to be measured before it ships, not after.
 *
 * ## Why the figure on record could not answer this
 *
 * `probe-boardcard-read-after-write-lag.ts` measured 1.2-2.4s of staleness and
 * that number is now quoted as "BoardCards reads stale for 1.2-2.4s after its
 * own ack", flatly. But it measured ONE shape: a synthetic 24-field row with
 * every value changed, written straight through `node.updateRecord` into a
 * brand-new single-row `zz-` partition, at acks of 972-2178ms. Production
 * metadata traffic is a 2-field update to a settled row on a warm partition at
 * ~100ms acks. Whether the figure carries across that gap was assumed, not
 * measured — and the two are not close.
 *
 * So this probe holds the traffic fixed (a real `tag add` through
 * `writeCardPatch`, the path `tag`/`dep`/`rank` share) and varies only the write
 * SHAPE, by pointing `FKANBAN_UNDER_TEST` at a tree whose `upsertBoardCard`
 * narrows and then at one that does not:
 *
 *   FKANBAN_UNDER_TEST=<pre-fix>/src bun scripts/probe-write-shape-vs-readback-freshness.ts
 *   bun scripts/probe-write-shape-vs-readback-freshness.ts
 *
 * It polls the EXACT query `readWholeBoardCardRow` issues — 24 fields,
 * `HashRangePrefix` on the full sk — because projection width and prefix
 * selectivity are axes this schema's reads turn on, and a lookalike read is not
 * evidence about the real one.
 *
 * Writes to `agent-dogfood-scratch` under a stamped `zz-` slug and deletes both
 * rows per rep. Labelled `kanban-probe`.
 */
const UNDER_TEST = process.env.FKANBAN_UNDER_TEST ?? new URL("../src", import.meta.url).pathname;
const REPS = Number(process.env.REPS ?? 4);

/* eslint-disable @typescript-eslint/no-explicit-any */
const { readConfig } = (await import(`${UNDER_TEST}/config.ts`)) as any;
const { newNodeClient } = (await import(`${UNDER_TEST}/client.ts`)) as any;
const { boardCardsHash } = (await import(`${UNDER_TEST}/board-cards.ts`)) as any;
const { createCardRecord, writeCardPatch, emptyStructuredFields } = (await import(
  `${UNDER_TEST}/record.ts`
)) as any;
const { BOARD_CARDS_FIELDS } = (await import(`${UNDER_TEST}/schemas.ts`)) as any;

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const bcHash = boardCardsHash(cfg)!;

/**
 * Default is the WARM `agent-dogfood-scratch` partition, because that is what
 * production traffic writes into. Override to a fresh `zz-` board to test the
 * other candidate variable — the lag figure on record was measured on a
 * brand-new single-row partition.
 */
const BOARD = process.env.PROBE_BOARD ?? "agent-dogfood-scratch";
const SETTLE_MS = 3500;
const POLL_MS = 100;
const GIVE_UP_MS = 8000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Exactly what `readWholeBoardCardRow` issues. */
async function readRowTags(sk: string): Promise<string[] | "<absent>"> {
  const res = await node.queryAll({
    schemaHash: bcHash,
    fields: [...BOARD_CARDS_FIELDS],
    filter: { HashRangePrefix: { hash: BOARD, prefix: sk } },
  });
  for (const r of res.results) {
    if (r.fields.sk !== sk) continue;
    return (r.fields.tags as string[]) ?? [];
  }
  return "<absent>";
}

function baseCard(slug: string, stamp: number) {
  return {
    slug,
    title: "probe: write shape vs readback freshness",
    body: "",
    board: BOARD,
    column: "todo",
    position: "1",
    assignee: "",
    tags: [] as string[],
    deps: [] as string[],
    created_at: new Date(stamp).toISOString(),
    updated_at: new Date(stamp).toISOString(),
    ...emptyStructuredFields(),
    surfaces: [] as string[],
  };
}

console.log(`under test : ${UNDER_TEST}`);
console.log(`board      : ${BOARD}   reps=${REPS}\n`);

const opts = { cfg, node };
const results: Array<{ ack: number; fresh: number | null; sent: number }> = [];

for (let rep = 1; rep <= REPS; rep++) {
  const stamp = Date.now();
  const slug = `zz-fresh-${stamp}`;
  const sk = `todo#00000001#${slug}`;
  const created = baseCard(slug, stamp);
  await createCardRecord(opts, created);
  // Settle, so the mutation under test updates a row the index already serves —
  // the production case. An <absent> read routes to a wide write in either tree
  // and would make the arms identical by construction.
  await sleep(SETTLE_MS);

  // Count the fields the write path actually sends, so the arm labels itself
  // rather than being trusted from the tree path.
  let sent = 0;
  const counting = {
    ...node,
    async updateRecord(req: any) {
      if (req.schemaHash === bcHash) sent = Object.keys(req.fields).length;
      return node.updateRecord(req);
    },
    async createRecord(req: any) {
      if (req.schemaHash === bcHash) sent = Object.keys(req.fields).length;
      return node.createRecord(req);
    },
  };

  const TAG = `zz-g${rep}`;
  const t0 = Date.now();
  await writeCardPatch({ cfg, node: counting }, created, { tags: [TAG] });
  const ack = Date.now() - t0;

  // Poll the real query until it reflects the write.
  let fresh: number | null = null;
  const deadline = Date.now() + GIVE_UP_MS;
  for (;;) {
    const tags = await readRowTags(sk);
    if (Array.isArray(tags) && tags.includes(TAG)) {
      fresh = Date.now() - t0 - ack;
      break;
    }
    if (Date.now() > deadline) break;
    await sleep(POLL_MS);
  }

  results.push({ ack, fresh, sent });
  console.log(
    `rep ${rep}: sent ${String(sent).padStart(2)} fields  ack ${String(ack).padStart(5)}ms  ` +
      `fresh ${fresh === null ? `NOT within ${GIVE_UP_MS}ms` : `${fresh}ms after ack`}`,
  );

  await node.deleteRecord({ schemaHash: bcHash, keyHash: BOARD, rangeKey: sk });
  const cardHash = cfg.schemaHashes?.card;
  if (cardHash) await node.deleteRecord({ schemaHash: cardHash, keyHash: slug });
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : NaN;
};
const freshes = results.map((r) => r.fresh).filter((x): x is number => x !== null);
console.log(
  `\nfields sent: ${[...new Set(results.map((r) => r.sent))].join("/")}` +
    `   median ack ${med(results.map((r) => r.ack))}ms` +
    `   median time-to-fresh ${freshes.length === results.length ? `${med(freshes)}ms` : "INCOMPLETE"}` +
    `   (${freshes.length}/${results.length} became fresh)`,
);
