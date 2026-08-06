// A sparse Card survives a wide read; `cardExists` earns its keep on husks.
//
// Until 2026-08-06 three prose sites in this repo stated, as settled fact, that
// LastDB drops a row when ANY projected field lacks an atom — and `cardExists`
// existed only because of it: project `slug` alone so a merely SPARSE card
// cannot read as absent and get its board membership reaped.
//
// That rule (`any_missing`) is FALSE on the Card schema. Measured on the live
// primary 2026-08-06 with constructed witnesses — a narrow `updateRecord`
// against a non-existent row stores exactly the subset sent, which is the only
// way to build a sparse Card, since `kanban add` writes an atom for every field
// including the empty ones (`scripts/probe-card-projection-sparse.ts`):
//
//   row       atoms   23-field point read   findCard   cardExists
//   full      23/23   RETURNED              found      true
//   sparse     5/23   RETURNED              found      true     <- the case
//   noHash    22/23   dropped               null       false    <- the gate
//   hashOnly   1/23   RETURNED              null       true     <- the husk
//
// 13 projections x 4 rows = 52 judgements: HASH-ELSE-LEAD 52/52, `any_missing`
// 41/52, LEAD 47/52, SOME 44/52. The gate is ONE field — the hash field when
// the projection contains it — and for Card that is `slug`, which every card
// read already projects. `noHash` is the control that proves the gate is real
// rather than "nothing ever drops".
//
// So the failure mode `cardExists` was built to prevent cannot occur, and the
// guard is kept for the shape the table's last row shows instead: since
// `isKeyOnlyRow`, the wide reads drop the post-delete husk and this one cannot
// see it as anything but a live card. `board_cards_heal` therefore SKIPS
// inside the 113–1072ms delete window rather than reaping, and the next run
// reaps. On a branch that deletes data, lagging is the right way to be wrong.
//
// These tests fail if either half is reverted: if a wide Card read starts
// dropping sparse rows, or if `cardExists` is made husk-aware.

import { describe, expect, test } from "bun:test";

import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { cardExists, findCard } from "../src/record.ts";
import { CARD_FIELDS } from "../src/schemas.ts";

const CARD_HASH = "cardhash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD_HASH },
};

/** Card is a HASH schema: one row per partition, gated on `slug`. */
const measured = () => fakeNode({ hashFields: { [CARD_HASH]: "slug" } });

function seed(node: ReturnType<typeof fakeNode>, fields: Record<string, unknown>) {
  node.seed({ schemaHash: CARD_HASH, keyHash: String(fields.slug ?? ""), fields });
}

/** The live witness: 5 of 23 atoms, and NO `assignee` key at all. */
const SPARSE = { slug: "sparse", title: "t", board: "default", column: "todo", position: "m" };
/** Every field but the gate — keyed on its slug, carrying no `slug` atom. */
const NO_HASH = { title: "t", board: "default", column: "todo", position: "m" };

describe("a wide Card read does not drop a sparse row", () => {
  test("findCard finds a card carrying 5 of 23 atoms", async () => {
    const node = measured();
    seed(node, SPARSE);

    const got = await findCard(node, cfg, "sparse");

    expect(got).not.toBeNull();
    expect(got!.slug).toBe("sparse");
    // The absent fields arrive as "" from `rowToCard` — absence is only visible
    // on the raw row, which is why `isKeyOnlyRow` reads rows and not Cards.
    expect(got!.assignee).toBe("");
    expect(got!.title).toBe("t");
  });

  test("the hash field IS the gate — a row missing `slug` is dropped", async () => {
    // The control. Without it the test above passes under a fake that never
    // drops anything, and proves nothing about the projection.
    //
    // Asserted on the RAW query, because that is where the gate lives. Through
    // `findCard` this test passes even with the projection disabled entirely —
    // the row comes back, `rowToCard` maps the absent `slug` to "", and
    // `findCardWithFields` rejects it on the slug match. Green for a reason
    // that has nothing to do with the node. (Measured: mutating the fake to
    // `dropIncompleteRows: false` left the old form 5/5 green.)
    const node = measured();
    node.seed({ schemaHash: CARD_HASH, keyHash: "nohash", fields: NO_HASH });

    const wide = await node.queryAll({
      schemaHash: CARD_HASH,
      fields: [...CARD_FIELDS],
      filter: { HashKey: "nohash" },
    });
    expect(wide.results.length).toBe(0);

    // …and the same row read with a projection the gate is absent from comes
    // back, so this is the gate and not the row being unreadable.
    const ungated = await node.queryAll({
      schemaHash: CARD_HASH,
      fields: ["title", "board"],
      filter: { HashKey: "nohash" },
    });
    expect(ungated.results.length).toBe(1);

    expect(await findCard(node, cfg, "nohash")).toBeNull();
    expect(await cardExists(node, cfg, "nohash")).toBe(false);
  });

  test("every projection width agrees, because they share one gate", async () => {
    const node = measured();
    seed(node, SPARSE);

    for (const fields of [["slug"], ["slug", "title"], ["slug", "assignee"], [...CARD_FIELDS]]) {
      const res = await node.queryAll({ schemaHash: CARD_HASH, fields, filter: { HashKey: "sparse" } });
      expect(`${fields.length}:${res.results.length}`).toBe(`${fields.length}:1`);
    }
  });
});

describe("cardExists and the wide read disagree on exactly one shape: the husk", () => {
  test("a hash-only row is a card to `cardExists` and not one to `findCard`", async () => {
    const node = measured();
    seed(node, { slug: "husk" });

    // `findCard` projects 23 fields, so `isKeyOnlyRow` has evidence and fires.
    expect(await findCard(node, cfg, "husk")).toBeNull();
    // `cardExists` projects the hash field ALONE — a husk and a live card are
    // byte-identical there, so it has no evidence and must not act. This is
    // what keeps `board_cards_heal` from reaping inside the delete window.
    expect(await cardExists(node, cfg, "husk")).toBe(true);
  });

  test("they agree on a live card and on an absent one", async () => {
    const node = measured();
    seed(node, SPARSE);

    expect(await cardExists(node, cfg, "sparse")).toBe(true);
    expect(await findCard(node, cfg, "sparse")).not.toBeNull();

    expect(await cardExists(node, cfg, "never-written")).toBe(false);
    expect(await findCard(node, cfg, "never-written")).toBeNull();
  });
});
