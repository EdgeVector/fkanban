#!/usr/bin/env bun
/**
 * Probe: is the narrow path's MISSED WRITE reachable by ordinary board traffic?
 *
 * **Answer, measured 2026-08-05 against the pre-fix tree: NO — 3/3 reps did not
 * reproduce it, because the precondition never held.** Keep this probe: it is
 * the instrument that establishes the defect was latent rather than active, and
 * re-running it is how anyone checks whether that is still true.
 *
 * `papercut-kanban-prewrite-read-narrows-against-a-stale-index` measured the
 * mechanism — a field whose STALE value already equals the intended value is
 * dropped from a narrow write even when the row's CURRENT value differs — but
 * its 16/16 figure came from a probe that set the conditions up directly, and
 * the record says plainly that "the production RATE is unmeasured".
 *
 * ## The traffic shape that would reach it
 *
 * The stale row is OLDER than the stored one, so a miss needs the intended value
 * to equal the OLD value while the CURRENT value differs — a field being set
 * back to what it was. A TOGGLE:
 *
 *   t0  create, tags=[]
 *   ..  settle, so the index serves tags=[]
 *   t1  tag add zz-toggle  -> tags=[zz-toggle]
 *   t2  tag rm  zz-toggle  -> intent tags=[]
 *       IF t2's read still serves the pre-t1 row, diff(stale=[], intent=[]) sees
 *       no change in tags and DROPS it. The write still happens — every caller
 *       bumps updated_at — but without the field the user actually changed, so
 *       the board keeps a tag the card does not have and nothing errors.
 *
 * `tag add` then `tag rm` within two seconds is a correction a human makes after
 * a typo and an agent makes routinely, so if the window were open this would be
 * a live data defect.
 *
 * ## What actually happened, 3/3
 *
 * The window was not open. The narrow path's OWN read — 24 fields,
 * `HashRangePrefix` on the full sk, recorded off the real client rather than
 * imitated — returned the FRESH row 3-6ms after t1's ack, so the diff was
 * correct and `tags` was sent:
 *
 *   t1 ack 113ms / 105ms / 824ms
 *   its read -> tags=["zz-toggle"]   (fresh)   x3
 *   its write update, 2 fields: tags,updated_at   (tags SENT)   x3
 *
 * The 1.2-2.4s staleness on record does not describe this traffic. Its own probe
 * (`probe-boardcard-read-after-write-lag.ts`) still reproduced ~0.8-1.2s of
 * post-ack staleness on the same node in the same hour, so the figure is real
 * for the shape it measured — repeated raw `node.updateRecord` writes to ONE slot
 * with no settle between generations — and does not carry to a real mutation
 * through `writeCardPatch`. Width and partition age were both eliminated as the
 * variable (`probe-write-shape-vs-readback-freshness.ts`: 2 fields 6ms, 24
 * fields 6ms, brand-new partition 2ms, 11/11 fresh). The leading remaining
 * candidate is that the real path does further node work after the BoardCards
 * write — `retireMilestoneCardMembership` — which may carry the pending put
 * through. NOT proven; do not state it as mechanism.
 *
 * So the narrow path was removed as an unsound pattern and a measured non-saving,
 * NOT as a live incident. Anyone quoting "BoardCards reads stale for 1.2-2.4s"
 * must name the write shape or they are quoting a probe artifact.
 *
 * ## Both directions, one probe
 *
 * `FKANBAN_UNDER_TEST` picks the tree whose `upsertBoardCard` runs:
 *
 *   bun scripts/probe-narrow-write-drops-a-toggled-field.ts
 *   FKANBAN_UNDER_TEST=/path/to/pre-fix/src bun scripts/probe-narrow-write-drops-a-toggled-field.ts
 *
 * Writes to the `agent-dogfood-scratch` board with a stamped `zz-` slug and
 * deletes both rows at the end. Labelled `kanban-probe`, so its writes do not
 * bill to `client=kanban` in `lastdb ops`.
 */
const UNDER_TEST = process.env.FKANBAN_UNDER_TEST ?? new URL("../src", import.meta.url).pathname;

/* eslint-disable @typescript-eslint/no-explicit-any */
const { readConfig } = (await import(`${UNDER_TEST}/config.ts`)) as any;
const { newNodeClient } = (await import(`${UNDER_TEST}/client.ts`)) as any;
const { boardCardsHash } = (await import(`${UNDER_TEST}/board-cards.ts`)) as any;
const { createCardRecord, writeCardPatch, emptyStructuredFields } = (await import(
  `${UNDER_TEST}/record.ts`
)) as any;

const cfg = readConfig();
const rawNode = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const bcHash = boardCardsHash(cfg)!;

/**
 * Watch the write path's OWN read and write, rather than issuing a lookalike.
 *
 * An earlier version of this probe observed staleness with its own query — 5
 * fields, `prefix: "todo#"` — and concluded from three fresh reads that the
 * precondition failed. That query is not the one `readWholeBoardCardRow` makes
 * (24 fields, `prefix: <full sk>`), and projection width and prefix selectivity
 * are exactly the axes this schema's reads have been measured to turn on. So the
 * only sound instrument is the real read: record what the narrow path was
 * handed, and which fields it then chose to send.
 */
let watching = false;
const seenReads: Array<{ fields: number; prefix: string; tags: unknown }> = [];
const seenWrites: Array<{ op: string; fields: string[] }> = [];
const node = {
  ...rawNode,
  async queryAll(req: any) {
    const res = await rawNode.queryAll(req);
    if (watching && req.schemaHash === bcHash) {
      const row = res.results.find((r: any) => r.fields?.slug === SLUG);
      seenReads.push({
        fields: req.fields?.length ?? 0,
        prefix: String(req.filter?.HashRangePrefix?.prefix ?? req.filter?.HashKey ?? "?"),
        tags: row ? (row.fields.tags ?? null) : "<absent>",
      });
    }
    return res;
  },
  async updateRecord(req: any) {
    if (watching && req.schemaHash === bcHash) {
      seenWrites.push({ op: "update", fields: Object.keys(req.fields) });
    }
    return rawNode.updateRecord(req);
  },
  async createRecord(req: any) {
    if (watching && req.schemaHash === bcHash) {
      seenWrites.push({ op: "create", fields: Object.keys(req.fields) });
    }
    return rawNode.createRecord(req);
  },
};

const BOARD = "agent-dogfood-scratch";
const STAMP = Date.now();
const SLUG = `zz-toggle-${STAMP}`;
const TAG = "zz-toggle";
/** Long enough for the index to catch up (measured window is 1.2-2.4s). */
const SETTLE_MS = 3500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function baseCard() {
  return {
    slug: SLUG,
    title: "probe: narrow write drops a toggled field",
    body: "",
    board: BOARD,
    column: "todo",
    position: "1",
    assignee: "",
    tags: [] as string[],
    deps: [] as string[],
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date(STAMP).toISOString(),
    ...emptyStructuredFields(),
    surfaces: [] as string[],
  };
}

/** The BoardCards row's `tags`, read at the address projection plus tags. */
async function boardRowTags(): Promise<string[] | "<absent>"> {
  const res = await node.queryAll({
    schemaHash: bcHash,
    fields: ["board", "sk", "slug", "tags", "milestone"],
    filter: { HashRangePrefix: { hash: BOARD, prefix: "todo#" } },
  });
  for (const r of res.results) {
    if (r.fields.slug !== SLUG) continue;
    return (r.fields.tags as string[]) ?? [];
  }
  return "<absent>";
}

console.log(`under test : ${UNDER_TEST}`);
console.log(`board/slug : ${BOARD} / ${SLUG}\n`);

const opts = { cfg, node };
const created = baseCard();
await createCardRecord(opts, created);
console.log(`t0 create   tags=[]           -> board row ${JSON.stringify(await boardRowTags())}`);

// Let the index catch up, so the pre-write read RETURNS a row rather than
// <absent>. An absent read falls through to a wide write, which is exactly the
// case that does NOT reproduce this — and is why a naive back-to-back probe
// misses the defect.
await sleep(SETTLE_MS);
console.log(`   settled  ${SETTLE_MS}ms          -> board row ${JSON.stringify(await boardRowTags())}`);

// t1: add the tag. The index is now one generation behind, serving tags=[].
const withTag = { ...created, tags: [TAG] };
const t1 = Date.now();
await writeCardPatch(opts, created, { tags: [TAG] });
const t1Ack = Date.now() - t1;
console.log(`t1 tag add  tags=["${TAG}"]  ack ${t1Ack}ms`);

// t2: remove it again, as fast as the process can issue it. Intent equals the
// pre-t1 value, so if the write path's own read is still serving that row, the
// diff sees no change in `tags` and drops the field the user just changed.
watching = true;
const t2 = Date.now();
await writeCardPatch(opts, withTag, { tags: [] });
const t2Ack = Date.now() - t2;
watching = false;
console.log(`t2 tag rm   tags=[]           ack ${t2Ack}ms  (issued ${t2 - t1 - t1Ack}ms after t1's ack)`);

for (const r of seenReads) {
  const stale = JSON.stringify(r.tags) === "[]";
  console.log(
    `   its read  ${r.fields} fields, prefix=${r.prefix} -> tags=${JSON.stringify(r.tags)}` +
      `  ${stale ? "(STALE — precondition holds)" : "(fresh — precondition FAILS)"}`,
  );
}
for (const w of seenWrites) {
  const sentTags = w.fields.includes("tags");
  console.log(
    `   its write ${w.op}, ${w.fields.length} fields: ${w.fields.join(",")}` +
      `  ${sentTags ? "(tags SENT)" : "(tags DROPPED)"}`,
  );
}

await sleep(SETTLE_MS);
const final = await boardRowTags();
console.log(`\nboard row after settle: tags=${JSON.stringify(final)}`);

const dropped = Array.isArray(final) && final.includes(TAG);
console.log(
  dropped
    ? `VERDICT: REPRODUCED — the board still carries "${TAG}" the card does not have.\n` +
        `         The tag rm was acked and silently dropped from the BoardCards row.`
    : `VERDICT: not reproduced — the removal landed on the board row.`,
);

// Cleanup: both rows, by address.
await node.deleteRecord({ schemaHash: bcHash, keyHash: BOARD, rangeKey: `todo#00000001#${SLUG}` });
const cardHash = cfg.schemaHashes?.card;
if (cardHash) await node.deleteRecord({ schemaHash: cardHash, keyHash: SLUG });
console.log("cleaned up.");
