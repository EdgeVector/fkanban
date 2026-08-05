/**
 * The three things that had to be true before `upsertBoardCard`'s narrow path
 * could be deleted — pinned so it cannot come back.
 *
 * Until 2026-08-05 every non-move, non-create BoardCards write read the stored
 * row, diffed it against the intended fields, and sent only the difference. Two
 * separate arguments held that up, and measurement retired both:
 *
 *  - **The saving was not real.** 24-changed 1983ms, 24-sent-2-changed 1768ms,
 *    narrow-4-field 1806ms, against a 229ms within-arm noise floor
 *    (`scripts/probe-partial-write-cost.ts`, arms shuffled per rep — the table
 *    that justified narrowing ran a FIXED arm order, making arm and slot the
 *    same variable). Those three are one number.
 *  - **The diff basis could be stale.** The read consults durable storage while
 *    the write acks off resident and defers the durable put, so it can serve
 *    pre-write state; a freshly created row reads `<absent>` rather than partial.
 *    How wide that window is depends on the write SHAPE: ~0.8-2.4s for the
 *    repeated same-slot raw writes `probe-boardcard-read-after-write-lag.ts`
 *    makes, but 2-9ms (11/11) for a real mutation through `writeCardPatch`
 *    (`probe-write-shape-vs-readback-freshness.ts`,
 *    `probe-narrow-write-drops-a-toggled-field.ts`). So the narrow path was
 *    removed for being unsound, NOT for a defect measured happening: deciding a
 *    write from a read that CAN lag is the pattern at fault, and 3/3 attempts to
 *    reproduce the missed write on real traffic found the read already fresh.
 *
 * Evidence: brain `papercut-kanban-prewrite-read-narrows-against-a-stale-index`.
 * Law: brain `decision-2026-08-05-no-stale-reads-after-ack` — an ack is a
 * promise about reads, and until the node keeps it on every read shape, no
 * caller may read a partition back to decide what to write.
 *
 * ## Why a stub, and why these three
 *
 * The failure this file guards is SILENT in all three of its forms — a dropped
 * field, a wasted round trip, and a row invisible to every wide reader. None
 * raises, so only an assertion on the wire catches a regression. The narrow path
 * is easy to reintroduce as an optimisation (it reads as an obvious one), so the
 * first two cases were CHECKED against it rather than assumed: with the narrow
 * path pasted back in, the no-op case fails `Expected length: 1, Received: 0`
 * and the missed-write case fails `Expected: "TARGET", Received: "WRONG"` — the
 * silent data defect, reproduced.
 *
 * The holed-row case does NOT discriminate, and saying so is the point of this
 * paragraph: the narrow path passed it too, because `readWholeBoardCardRow`
 * returned `null` for a holed row and fell through to a wide write. It pins the
 * fall-through behaviour that is now the only behaviour — a wide write must keep
 * healing a hole, since nothing else on this path will.
 */
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient } from "../src/client.ts";
import { boardCardFieldsFromCard, boardCardSk, listAllBoardCards, upsertBoardCard } from "../src/board-cards.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const BC = "board-cards-hash";

/**
 * The LIVE catalog `hash_field` for BoardCards — `milestone`, not the `board`
 * its declared layout names (`src/membership_schema_guard.ts`, `alsoAccepts`).
 *
 * Stated rather than derived, because deriving it from the declared schema would
 * model the wrong gate: after the 2026-07-23 multi-key expand the node gates
 * every BoardCards read that projects `milestone` on `milestone`, so a row with
 * no `milestone` atom is silently absent. That is the mechanism the holed-row
 * case below depends on. See {@link FakeNodeOptions.hashFields}.
 */
const BOARD_CARDS_LIVE_HASH_FIELD = "milestone";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { board: "board-hash", card: "card-hash", board_cards: BC },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "wide",
    title: "My card",
    body: "SHOULD NOT APPEAR ON BOARD CARDS",
    board: "default",
    column: "todo",
    position: "3",
    assignee: "tom",
    tags: ["a"],
    deps: ["other"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-02T00:00:00.000Z",
    ...emptyStructuredFields(),
    surfaces: ["src/**"],
    done_at: "",
    kind: "pr",
    repo: "EdgeVector/fkanban",
    ...partial,
  };
}

/** BoardCards writes only — the Card/index writes are another schema's problem. */
function bcWrites(node: FakeNode) {
  return node.writes.filter((w) => w.schemaHash === BC);
}

describe("upsertBoardCard writes wide, and never reads to decide what to write", () => {
  test("a no-op write issues exactly ONE mutation, byte-identical to the stored row", async () => {
    const node = fakeNode({ hashFields: { [BC]: BOARD_CARDS_LIVE_HASH_FIELD } });
    const c = card();
    await upsertBoardCard(node, cfg, c, null, { skipOrphanPurge: true });
    const stored = node.rowAt(BC, "default", boardCardSk(c.column, c.position, c.slug));
    expect(stored).toBeDefined();
    node.writes.length = 0;

    await upsertBoardCard(node, cfg, c, c, { skipOrphanPurge: true });

    // ONE write. The narrow path's no-op branch issued ZERO, which sounds
    // strictly better and was not: to know it could skip, it had to read the row
    // back, and on a genuine no-op it "found" a change that was not one and
    // wrote anyway in 16 of 16 measured samples — ~2.3s for what the node skips
    // whole-record in ~48ms.
    const writes = bcWrites(node);
    expect(writes).toHaveLength(1);

    // The payload is byte-identical to what is stored, which is the ONLY form
    // the node's whole-record skip recognises. That discount is reachable by
    // SENDING the unchanged row; it is not reachable by reading first.
    expect(writes[0]!.fields).toEqual(stored!.fields);
    expect(writes[0]!.fields).toEqual(boardCardFieldsFromCard(c));

    // And nothing read BoardCards back to decide any of it.
    expect(node.reads.filter((r) => r.schemaHash === BC)).toHaveLength(0);
  });

  test("a field whose STALE value matches the intent IS corrected when the current value differs", async () => {
    // The serious half of the papercut, and the reason this is a correctness
    // fix rather than a perf one. Narrow diff against a lagging index drops any
    // field the stale row already agrees with — so when the row's CURRENT value
    // disagrees, the write cannot correct it and nothing errors.
    const inner = fakeNode({ hashFields: { [BC]: BOARD_CARDS_LIVE_HASH_FIELD } });
    const c = card({ title: "TARGET" });
    const sk = boardCardSk(c.column, c.position, c.slug);

    // What the lagging INDEX still serves: the row as it was, title=TARGET.
    const staleView = { ...boardCardFieldsFromCard(c) };
    // What is actually stored NOW: a later write moved title away from TARGET.
    inner.seed({
      schemaHash: BC,
      keyHash: "default",
      rangeKey: sk,
      fields: { ...boardCardFieldsFromCard(c), title: "WRONG" },
    });

    // Model the lag at its worst: every BoardCards read answers from the stale
    // snapshot. Real traffic was measured fresh in 2-9ms, so this is the
    // pattern's failure mode held open deliberately — the point is that a wide
    // write is correct even when the read WOULD have lied, not that it lies
    // often.
    const node: NodeClient = {
      ...inner,
      async queryAll(req) {
        if (req.schemaHash !== BC) return inner.queryAll(req);
        const fields = Object.fromEntries(
          req.fields.filter((f) => f in staleView).map((f) => [f, staleView[f]]),
        );
        return { ok: true, results: [{ fields, key: { hash: "default", range: sk } }], returned_count: 1, total_count: 1 };
      },
    };

    // Intent: title=TARGET. Equal to the stale value, different from the current
    // one — the exact shape the narrow diff dropped.
    await upsertBoardCard(node, cfg, c, c, { skipOrphanPurge: true });

    expect(inner.rowAt(BC, "default", sk)?.fields.title).toBe("TARGET");
  });

  test("a HOLED row is healed, so wide readers can see it again", async () => {
    // A row missing an atom on a projected field is dropped from every wide
    // read with no error — invisible, not partial. A narrow patch leaves the
    // hole in place, so the row stays invisible after a "successful" write.
    const node = fakeNode({ hashFields: { [BC]: BOARD_CARDS_LIVE_HASH_FIELD } });
    const c = card();
    const sk = boardCardSk(c.column, c.position, c.slug);
    const holed = { ...boardCardFieldsFromCard(c) };
    delete holed.milestone;
    node.seed({ schemaHash: BC, keyHash: "default", rangeKey: sk, fields: holed });

    // Precondition: the hole really does hide the row from a wide read.
    expect((await listAllBoardCards(node, cfg, [{ slug: "default" }])) ?? []).toHaveLength(0);

    await upsertBoardCard(node, cfg, c, c, { skipOrphanPurge: true });

    const rows = (await listAllBoardCards(node, cfg, [{ slug: "default" }])) ?? [];
    expect(rows).toHaveLength(1);
    expect(rows[0]!.slug).toBe("wide");
    expect(node.rowAt(BC, "default", sk)?.fields.milestone).toBeDefined();
  });
});
