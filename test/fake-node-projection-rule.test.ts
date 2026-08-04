/**
 * The fake's OWN contract.
 *
 * `test/fake-node.ts` decides what 75 test files see when they read, and until
 * 2026-08-04 nothing tested it. That is the wrong thing to leave unguarded: a
 * fake that models the node loosely does not fail, it silently agrees with
 * whatever the code under test does, and every suite built on it goes green
 * while measuring nothing.
 *
 * Each test here is written to FAIL if a specific property is reverted, and
 * says which. Two of them exist because that property WAS reverted-by-default
 * or ignored, and no other test in the repo could tell.
 */
import { describe, expect, test } from "bun:test";
import { fakeNode } from "./fake-node.ts";

const SCHEMA = "schema-hash";

/** A BoardCards-shaped row whose hash field is `milestone` (the live gate). */
function seedRow(node: ReturnType<typeof fakeNode>, fields: Record<string, unknown>) {
  node.seed({ schemaHash: SCHEMA, keyHash: "default", rangeKey: String(fields.sk), fields });
}

const WHOLE = { board: "default", sk: "todo#10#whole", slug: "whole", milestone: "ms-a" };
/** The live board's pre-`milestone` shape — the 2026-07-23 incident row. */
const NO_MILESTONE = { board: "default", sk: "todo#20#sparse", slug: "sparse" };

describe("the fake applies HASH-ELSE-LEAD by default", () => {
  test("a row missing a NON-gate projected field is RETURNED — `any_missing` would drop it", async () => {
    // THIS is the test that fails if the default is reverted to `any_missing`.
    // Nothing else in the suite can see that flip: `any_missing` is strictly
    // more aggressive, so every expectation written against it stays green
    // under it. Only a row the node RETURNS and `any_missing` eats shows the
    // difference, and this is one — `slug` leads and is present, `milestone`
    // is merely absent.
    const node = fakeNode();
    seedRow(node, NO_MILESTONE);

    const res = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["slug", "milestone"],
      filter: { HashKey: "default" },
    });

    expect(res.results.length).toBe(1);
    // Absent is ABSENT — the row comes back WITHOUT the field, not with a null.
    expect(res.results[0]!.fields).toEqual({ slug: "sparse" });
  });

  test("the hash field gates from any position, not just when it leads", async () => {
    const node = fakeNode({ hashFields: { [SCHEMA]: "milestone" } });
    seedRow(node, WHOLE);
    seedRow(node, NO_MILESTONE);

    // `milestone` sits LAST and still decides — this is the shipped list
    // projection's shape, and the reason a sparse row is invisible to it.
    const trailing = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["slug", "board", "milestone"],
      filter: { HashKey: "default" },
    });
    expect(trailing.results.map((r) => r.fields.slug)).toEqual(["whole"]);

    // Same two rows, same gate, leading position — same answer.
    const leading = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["milestone", "slug"],
      filter: { HashKey: "default" },
    });
    expect(leading.results.map((r) => r.fields.slug)).toEqual(["whole"]);
  });

  test("a projection that omits the hash field falls back to gating on the leading one", async () => {
    const node = fakeNode({ hashFields: { [SCHEMA]: "milestone" } });
    seedRow(node, NO_MILESTONE);

    // This is why the spine read works where the wide read cannot: keep
    // `milestone` out of the projection and the sparse row is reachable again.
    const spine = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["board", "sk", "slug"],
      filter: { HashKey: "default" },
    });
    expect(spine.results.map((r) => r.fields.slug)).toEqual(["sparse"]);

    // ...and it is genuinely the LEADING field doing the gating, not "no gate".
    const noLead = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["milestone_absent_lead", "slug"],
      filter: { HashKey: "default" },
    });
    expect(noLead.results.length).toBe(0);
  });
});

describe("`dropIncompleteRows: false` means drop nothing, under EITHER rule", () => {
  test("a row missing the hash gate still comes back when the opt-out is set", async () => {
    // THIS is the test that fails if the `hash_else_lead` branch is moved back
    // ahead of the `dropIncompleteRows` check. That ordering made the opt-out
    // silently ineffective, so three tests that had explicitly opted OUT of the
    // drop rule were still being filtered by it — they were proving the
    // opposite of what they claimed, and only said so when the default moved.
    const node = fakeNode({
      hashFields: { [SCHEMA]: "milestone" },
      dropIncompleteRows: false,
    });
    seedRow(node, NO_MILESTONE);

    const res = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["slug", "milestone"],
      filter: { HashKey: "default" },
    });

    expect(res.results.length).toBe(1);
    expect(res.results[0]!.fields).toEqual({ slug: "sparse" });
  });

  test("the opt-out also disables the historical `any_missing` rule", async () => {
    const node = fakeNode({ projectionRule: "any_missing", dropIncompleteRows: false });
    seedRow(node, NO_MILESTONE);

    const res = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["slug", "milestone"],
      filter: { HashKey: "default" },
    });
    expect(res.results.length).toBe(1);
  });
});

describe("`any_missing` remains available for guards that must hold under a stricter node", () => {
  test("it drops a row the node itself would return", async () => {
    const node = fakeNode({ projectionRule: "any_missing" });
    seedRow(node, NO_MILESTONE);

    const res = await node.queryAll({
      schemaHash: SCHEMA,
      fields: ["slug", "milestone"],
      filter: { HashKey: "default" },
    });

    // The divergence from the node, stated once so it cannot be mistaken for
    // fidelity: hash-else-lead returns this row (first test in this file).
    expect(res.results.length).toBe(0);
  });
});
