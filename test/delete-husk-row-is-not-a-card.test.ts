// A row that is only a key is not a card.
//
// Sibling of `scan-ghost-row-false-empty-body.test.ts`, and a DIFFERENT shape.
// A ghost row is keyed differently from its card and carries `slug` + an empty
// `body` — two fields, so the guard here never sees it. A husk is keyed under
// the card's OWN slug and carries the hash field and nothing else. It is what
// the node serves for a delete that has been accepted but not yet fully
// applied.
//
// Measured on the live primary 2026-08-06 with
// `scripts/probe-card-exists-after-delete.ts`. Immediately after `kanban rm`
// ACKed "removed card <slug>", a 23-field HashKey point read returned ONE row:
//
//   {"fields":{"slug":"zz-husk-raw-…"},"key":{"hash":"zz-husk-raw-…"},…}
//
// 10 of 12 deletes reproduced it; the window closed after 113–1072ms. In that
// window `rowToCard` — which maps every absent field to `""` — produced a
// well-formed Card, so `kanban show <deleted-slug>` printed
//
//   zz-husk-…
//   zz-husk-… · /
//   created by: unknown
//
// and **exited 0**. A question about existence got the one answer it must never
// get. The same rows survive PERMANENTLY in unfiltered scans: an unfiltered
// Card scan on the live primary returned 14 rows with a slug and no
// title/board/column, while HashKey point reads for those same slugs correctly
// returned nothing.
//
// The scan branch is the one that also WRITES — it feeds `writeCardListIndex`
// and `seedBoardCards` — so a husk there is not a bad render, it is board
// membership seeded for a card that no longer exists.

import { describe, expect, test } from "bun:test";

import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryRow } from "../src/client.ts";
import {
  boardToFields,
  cardExists,
  cardToFields,
  emptyStructuredFields,
  findCard,
  isKeyOnlyRow,
  listCardsForDisplay,
  nowIso,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function card(slug: string): Card {
  return {
    ...emptyStructuredFields(),
    slug,
    title: `title ${slug}`,
    body: "brief",
    board: "default",
    column: "todo",
    position: "m",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: nowIso(),
    created_by: "test",
    updated_at: nowIso(),
    done_at: "",
  } as Card;
}

const row = (fields: Record<string, unknown>): QueryRow => ({
  fields,
  key: { hash: String(fields.slug ?? ""), range: null },
});

describe("isKeyOnlyRow", () => {
  test("a row carrying only the hash field, under a wide projection, is a husk", () => {
    expect(isKeyOnlyRow(row({ slug: "gone" }), ["slug", "title", "board"])).toBe(true);
  });

  test("a row with no fields at all is a husk", () => {
    expect(isKeyOnlyRow(row({}), ["slug", "title"])).toBe(true);
  });

  test("one non-hash atom is enough to be a card — sparse is not deleted", () => {
    // The conservative direction, and the one that matters: a live card whose
    // only surviving projected atom is `title` must still read as a card.
    expect(isKeyOnlyRow(row({ slug: "sparse", title: "t" }), ["slug", "title", "board"])).toBe(false);
  });

  test("an EMPTY non-hash atom is still an atom", () => {
    // Absence, not emptiness. `kanban add` writes an atom for every field,
    // empty ones included, so `body: ""` is a live card's ordinary shape and a
    // predicate that treated it as missing would delete real cards from reads.
    expect(isKeyOnlyRow(row({ slug: "s", body: "" }), ["slug", "body"])).toBe(false);
  });

  test("under a hash-field-only projection the question is undecidable", () => {
    // A husk and a live card are byte-identical here, so there is no evidence
    // to act on. This is what keeps `cardExists` — which projects the hash
    // field ALONE so a sparse card cannot get its membership reaped — unchanged.
    expect(isKeyOnlyRow(row({ slug: "gone" }), ["slug"])).toBe(false);
  });
});

describe("a delete husk must not read back as a card", () => {
  test("findCard returns null for a key-only row (point read)", async () => {
    const node = fakeNode();
    node.seed({ schemaHash: "cardhash", keyHash: "deleted-card", fields: { slug: "deleted-card" } });

    expect(await findCard(node, cfg, "deleted-card")).toBeNull();
  });

  test("a live card next to a husk still reads back", async () => {
    // Guards against fixing the husk by refusing everything.
    const node = fakeNode();
    node.seed({ schemaHash: "cardhash", keyHash: "alive", fields: cardToFields(card("alive")) });
    node.seed({ schemaHash: "cardhash", keyHash: "dead", fields: { slug: "dead" } });

    expect((await findCard(node, cfg, "alive"))?.title).toBe("title alive");
    expect(await findCard(node, cfg, "dead")).toBeNull();
  });

  test("cardExists still says yes — it projects the key alone and cannot tell", async () => {
    // NOT an oversight, and pinned so a later change cannot quietly "fix" it.
    // `cardExists` is what AUTHORIZES reaping board membership in
    // `board_cards_heal`; making it tombstone-aware would require widening its
    // projection, which hands that path the false negative it exists to avoid.
    const node = fakeNode();
    node.seed({ schemaHash: "cardhash", keyHash: "dead", fields: { slug: "dead" } });

    expect(await cardExists(node, cfg, "dead")).toBe(true);
  });

  test("a husk is dropped from a full scan, and never seeded as membership", async () => {
    // The scan branch does not merely return rows — it seeds BoardCards from
    // them. A husk mapped to an all-"" Card seeds membership (board "" →
    // default board) for a card that no longer exists.
    const node = fakeNode();
    node.seed({ schemaHash: "boardhash", keyHash: "default", fields: boardToFields({
      slug: "default",
      title: "default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: nowIso(),
      updated_at: nowIso(),
    }) });
    node.seed({ schemaHash: "cardhash", keyHash: "alive", fields: cardToFields(card("alive")) });
    node.seed({ schemaHash: "cardhash", keyHash: "dead", fields: { slug: "dead" } });

    const listed = await listCardsForDisplay(node, cfg);
    const slugs = listed.map((c) => c.slug).sort();

    expect(slugs).not.toContain("dead");
    expect(slugs).toContain("alive");

    // And nothing derived from the husk was written anywhere.
    const seededDead = node.writes.filter((w) => JSON.stringify(w.fields).includes("dead"));
    expect(seededDead).toEqual([]);
  });
});
