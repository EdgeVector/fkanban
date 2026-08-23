// A card write must land the fields its command MEANT to change, and nothing
// else. That is the difference between last-writer-wins per FIELD (two agents
// editing one card both keep their edit) and last-writer-wins per RECORD (the
// second writer silently reverts the first, because it carries a stale copy of
// every field it never touched).
//
// The board runs concurrent writers by construction — `kanban-pickup`,
// `kanban-watch`, `board-closeout-sweep`, `groom` and a human all mutate one
// card — and the read-back is what the next reader sees. This is the concurrent
// -update leg of `scripts/kanban-stress.sh`, pinned deterministically: the race
// is resolved by ORDERING the two writes here, so a failure is a defect and not
// a flake.

import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { fakeNode } from "./fake-node.ts";
import {
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  updateCardRecord,
  writeCardPatch,
  type Card,
} from "../src/record.ts";
import { CARD_FIELDS } from "../src/schemas.ts";

const CARD_HASH = "cardhash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD_HASH },
};

function seedCard(node: ReturnType<typeof fakeNode>, over: Partial<Card> = {}): Card {
  const now = nowIso();
  const card: Card = {
    slug: "c1",
    title: "original title",
    body: "brief",
    board: "default",
    column: "todo",
    position: "100",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    created_by: "test",
    updated_at: now,
    ...emptyStructuredFields(),
    ...over,
  };
  node.seed({ schemaHash: CARD_HASH, keyHash: card.slug, fields: cardToFields(card) });
  return card;
}

const BOARD_CARDS_HASH = "boardcardshash";

const cfgWithBoardCards: Config = {
  ...cfg,
  schemaHashes: { ...cfg.schemaHashes, board_cards: BOARD_CARDS_HASH },
};

function newNode() {
  return fakeNode({ hashFields: { [CARD_HASH]: "slug" } });
}

describe("concurrent updates to one card", () => {
  test("a writer that only renames does not revert a peer's column move", async () => {
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };

    // Writer B reads the card FIRST and then goes away to do its own work —
    // exactly what `add`/`mark`/`tag` do between resolving the card and writing.
    const snapshotB = (await findCard(node, cfg, "c1"))!;

    // Writer A lands a complete write in the meantime.
    const snapshotA = (await findCard(node, cfg, "c1"))!;
    await writeCardPatch(opts, snapshotA, { column: "doing", assignee: "agent-a" });

    // Writer B now writes the ONE field it came to change.
    await updateCardRecord(
      opts,
      { ...snapshotB, title: "renamed by B", updated_at: nowIso() },
      undefined,
      snapshotB,
    );

    const after = (await findCard(node, cfg, "c1"))!;
    expect(after.title).toBe("renamed by B");
    // B never named `column` or `assignee`. Carrying its stale copy of them
    // into the write is what silently undoes A.
    expect(after.column).toBe("doing");
    expect(after.assignee).toBe("agent-a");
  });

  test("the write sends only the fields the command changed", async () => {
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };
    const snapshot = (await findCard(node, cfg, "c1"))!;
    node.writes.length = 0;

    await updateCardRecord(
      opts,
      { ...snapshot, title: "renamed", updated_at: "2026-01-01T00:00:00.000Z" },
      undefined,
      snapshot,
    );

    const cardWrites = node.writes.filter((w) => w.schemaHash === CARD_HASH && w.op === "update");
    expect(cardWrites).toHaveLength(1);
    expect(Object.keys(cardWrites[0]!.fields ?? {}).sort()).toEqual(["title", "updated_at"]);
  });

  test("the membership write carries current truth, not the caller's snapshot", async () => {
    // Narrowing the Card write is only half of it. BoardCards is dual-written
    // from shared field molecules, so a WIDE membership payload built from a
    // stale snapshot reaches the Card record through those shared tips.
    //
    // Measured 2026-08-23 against a real node: a Card write of `{assignee}`
    // sets `Card.assignee` to `agent-a`, and a later `upsertBoardCard` carrying
    // the pre-edit snapshot puts it back to `""` — with no Card write between
    // them. Here the assertion is on the payload, which is the thing this code
    // controls: the row must state the peer's value, not the snapshot's.
    const node = newNode();
    seedCard(node);
    const opts = { cfg: cfgWithBoardCards, node };

    const snapshotB = (await findCard(node, cfgWithBoardCards, "c1"))!;
    const snapshotA = (await findCard(node, cfgWithBoardCards, "c1"))!;
    await writeCardPatch(opts, snapshotA, { assignee: "agent-a" });
    node.writes.length = 0;

    await updateCardRecord(
      opts,
      { ...snapshotB, title: "renamed by B", updated_at: nowIso() },
      undefined,
      snapshotB,
    );

    const membership = node.writes.filter((w) => w.schemaHash === BOARD_CARDS_HASH);
    expect(membership.length).toBeGreaterThan(0);
    for (const write of membership) {
      expect(write.fields?.assignee).toBe("agent-a");
      expect(write.fields?.title).toBe("renamed by B");
    }
  });

  test("without a baseline the write still heals every field it carries", async () => {
    // `previous` is optional on `updateCardRecord`. A caller that cannot state
    // its baseline gets the old whole-record semantics rather than a write that
    // silently drops fields.
    const node = newNode();
    seedCard(node);
    const opts = { cfg, node };
    const snapshot = (await findCard(node, cfg, "c1"))!;
    node.writes.length = 0;

    await updateCardRecord(opts, { ...snapshot, title: "renamed", column: "doing" });

    const after = (await findCard(node, cfg, "c1"))!;
    expect(after.title).toBe("renamed");
    expect(after.column).toBe("doing");
    // Every stored field is still present — no narrow write left a hole.
    const row = node.rowAt(CARD_HASH, "c1")!;
    for (const field of CARD_FIELDS) {
      expect(field in row.fields).toBe(true);
    }
  });
});
