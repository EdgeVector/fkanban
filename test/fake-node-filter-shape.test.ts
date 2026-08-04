/**
 * The fake's OWN contract, part two: what it does with a filter it cannot honour.
 *
 * The node's wire types are `deny_unknown_fields` — a misspelled or extra key
 * is a 400. The fake was the opposite: any shape it did not recognise fell
 * through to field equality, compared an object against a stored string, and
 * returned ZERO ROWS. That is the single worst answer available here, because
 * zero rows is the shape of a passing assertion for most of what this suite
 * checks ("the terminal column was excluded", "the orphan is gone", "nothing
 * leaked"). A malformed filter did not fail a test — it satisfied one.
 *
 * Each test below is written to FAIL if the guard is reverted, and says how.
 * Every one of them passes trivially without the guard being CORRECT, so note
 * what is actually asserted: not "an error happened" but "an error happened
 * INSTEAD OF the empty result that would have been mistaken for success".
 */
import { describe, expect, test } from "bun:test";
import { fakeNode } from "./fake-node.ts";
import type { QueryFilter } from "../src/client.ts";

const SCHEMA = "schema-hash";

function seeded() {
  const node = fakeNode();
  node.seed({
    schemaHash: SCHEMA,
    keyHash: "default",
    rangeKey: "todo#10#card",
    fields: { board: "default", sk: "todo#10#card", slug: "card", milestone: "ms-a" },
  });
  return node;
}

const read = (node: ReturnType<typeof fakeNode>, filter: unknown) =>
  node.queryAll({ schemaHash: SCHEMA, fields: ["slug"], filter: filter as QueryFilter });

describe("the fake refuses filters it would misread", () => {
  test("an unknown key-shaped filter THROWS where it used to return zero rows", async () => {
    // Reverting the guard makes this resolve to `{rows: []}` — and a caller
    // asserting "no rows came back" would have called that a pass.
    const node = seeded();
    await expect(read(node, { HashRangeSuffix: { hash: "default", suffix: "#card" } })).rejects.toThrow(
      /unknown key-shaped filter "HashRangeSuffix"/,
    );
  });

  test("it throws on an EMPTY table too — the case the check exists for", async () => {
    // The placement test. Validating inside the row loop passes every other
    // test in this file while leaving the guard dead exactly here: with no
    // rows seeded, the loop body never runs, and the correct answer and the
    // wrong answer are both zero rows. This is the one assertion that
    // distinguishes them, and it fails if the check moves into the loop.
    const node = fakeNode();
    await expect(read(node, { HashRangeSuffix: { hash: "default", suffix: "x" } })).rejects.toThrow(
      /unsupported query filter/,
    );
  });

  test("a KNOWN shape with a misspelled member throws instead of matching nothing", async () => {
    // `prefix` -> `pfx`. Before the guard this was indistinguishable from an
    // unknown shape: the typed read produced `undefined` and every row
    // compared unequal.
    const node = seeded();
    await expect(read(node, { HashRangePrefix: { hash: "default", pfx: "todo#" } })).rejects.toThrow(
      /HashRangePrefix requires a string "prefix"/,
    );
  });

  test("a known shape with an EXTRA member throws — the node would 400 on it", async () => {
    const node = seeded();
    await expect(
      read(node, { HashRangeKey: { hash: "default", range: "todo#10#card", limit: "5" } }),
    ).rejects.toThrow(/HashRangeKey has no member "limit"/);
  });

  test("a key shape carrying a sibling field constraint throws — the over-returning failure", async () => {
    // The mirror image of the others, and the reason `keys.length > 1` is
    // checked rather than tolerated: `matchesFilter` answers on the key shape
    // alone, so the sibling `column` would be silently IGNORED and the read
    // would return MORE rows than asked for, not fewer. Reverting the guard
    // makes this resolve with the seeded row present despite `column: "done"`
    // excluding it.
    const node = seeded();
    await expect(read(node, { HashKey: "default", column: "done" })).rejects.toThrow(
      /must be the only key/,
    );
  });

  test("a non-string value under a lowercase key throws", async () => {
    // Stored field values are always strings (`QueryFilter = Record<string,
    // string>`), so an object here can never equal one and EVERY row drops.
    const node = seeded();
    await expect(read(node, { slug: { eq: "card" } })).rejects.toThrow(
      /field "slug" compares against a object/,
    );
  });
});

describe("the guard does not reject filters the node accepts", () => {
  // Without these, "throw on everything" would pass the suite above — and the
  // fake would be useless in a different direction. All five shapes fkanban
  // actually sends must still round-trip.
  test("HashKey", async () => {
    expect((await read(seeded(), { HashKey: "default" })).results).toHaveLength(1);
    expect((await read(seeded(), { HashKey: "other" })).results).toHaveLength(0);
  });

  test("HashRangePrefix", async () => {
    const hit = await read(seeded(), { HashRangePrefix: { hash: "default", prefix: "todo#" } });
    expect(hit.results).toHaveLength(1);
    const miss = await read(seeded(), { HashRangePrefix: { hash: "default", prefix: "done#" } });
    expect(miss.results).toHaveLength(0);
  });

  test("HashRangeKey", async () => {
    const hit = await read(seeded(), { HashRangeKey: { hash: "default", range: "todo#10#card" } });
    expect(hit.results).toHaveLength(1);
  });

  test("HashRangeRange", async () => {
    const hit = await read(seeded(), { HashRangeRange: { hash: "default", start: "todo#", end: "todo$" } });
    expect(hit.results).toHaveLength(1);
  });

  test("plain field equality, including a multi-field conjunction", async () => {
    expect((await read(seeded(), { slug: "card" })).results).toHaveLength(1);
    expect((await read(seeded(), { slug: "card", milestone: "ms-a" })).results).toHaveLength(1);
    expect((await read(seeded(), { slug: "card", milestone: "ms-b" })).results).toHaveLength(0);
  });

  test("no filter at all", async () => {
    expect((await read(seeded(), undefined)).results).toHaveLength(1);
  });
});
