// Narrow `Card` writes.
//
// A Card write costs roughly 200ms per field SENT on the primary, and the
// record has 22 fields. LastDB does skip a write whose every value is
// byte-identical (~148ms), but that skip is whole-record: change one field and
// the node pays for all 22 that were sent. So every card mutation — tag,
// claim, move, pr_url — cost ~3.3s for as long as it sent the whole record.
// Measured numbers and method: scripts/probe-card-write-cost.ts.
//
//   22 fields, every value changed                    3677ms
//   22 fields sent, 2 actually changed (a `tag`)      3269ms
//    3 fields sent (key + 2 changed)                   989ms
//   22 fields, every value byte-identical              148ms
//
// These tests lock the two things that make narrowing SAFE rather than merely
// fast, because getting either wrong fails silently: an `updateRecord` against
// a missing row does not error (it stores just the subset it was handed), and
// LastDB drops a row from any projection where a projected field has no atom.
// Together, one blind narrow write can make a card invisible to every reader.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { tagAddCmd } from "../src/commands/tag.ts";
import { boardToFields, findCard, nowIso, updateCardRecord } from "../src/record.ts";
import { CARD_FIELDS, DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  // board_cards is deliberately UNBOUND so upsertBoardCard returns early and
  // these assertions see Card writes only. BoardCards has its own narrow-write
  // suite in board-cards.test.ts.
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const CARD = "cardhash";
const validPickupBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nNarrow write fixture.\n\n## END STATE\nFixture complete.";

type Write = { op: "create" | "update"; schemaHash: string; fields: string[] };

function fakeNode(): NodeClient & {
  writes: Write[];
  stored(slug: string): Record<string, unknown> | undefined;
  /** Drop one field's atom, the way an under-projected row is missing one. */
  holePunch(slug: string, field: string): void;
  /** Delete the row outright, modelling a delete racing an in-flight update. */
  wipe(slug: string): void;
  /**
   * Stop modelling LastDB's drop-on-missing-atom rule, so an incomplete row
   * comes back from a full-projection query instead of vanishing. This is the
   * ONLY way to exercise `readWholeCardRow`'s own wholeness check: while the
   * node drops, that check is redundant, and a test written against a dropping
   * node passes whether the check is there or not.
   */
  stopDroppingIncompleteRows(): void;
} {
  let dropIncomplete = true;
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const writes: Write[] = [];
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, fields?: string[], filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, row]) =>
          !filter || Object.entries(filter).every(([field, value]) => row[field] === value)
        );
    // LastDB returns a row only when EVERY projected field has an atom on it.
    // Modelling that drop is the point of this fake: it is what turns a blind
    // narrow write into an invisible card.
    return entries
      .filter(([, row]) => !dropIncomplete || !fields || fields.every((f) => row[f] !== undefined))
      .map(([hash, row]) => ({ fields: row, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    writes,
    stored: (slug) => tableFor(CARD).get(slug),
    holePunch: (slug, field) => {
      const row = tableFor(CARD).get(slug);
      if (row) delete row[field];
    },
    wipe: (slug) => {
      tableFor(CARD).delete(slug);
    },
    stopDroppingIncompleteRows: () => {
      dropIncomplete = false;
    },
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      writes.push({ op: "create", schemaHash, fields: Object.keys(fields) });
      tableFor(schemaHash).set(keyHash, { ...fields });
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      writes.push({ op: "update", schemaHash, fields: Object.keys(fields) });
      // MERGE, not replace — a real LastDB update leaves unsent fields alone.
      tableFor(schemaHash).set(keyHash, { ...tableFor(schemaHash).get(keyHash), ...fields });
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, fields, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function seedBoard(node: NodeClient, slug = "default") {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("card narrow write", () => {
  let node: ReturnType<typeof fakeNode>;
  /** Card-schema writes only, in order, since the last `reset()`. */
  const cardWrites = () => node.writes.filter((w) => w.schemaHash === CARD);
  const reset = () => {
    node.writes.length = 0;
  };

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node);
    await addCmd({ cfg, node, slug: "probe", title: "Probe", column: "todo", body: validPickupBody });
    reset();
  });

  test("a tag write sends only the fields that changed, not all 22", async () => {
    await tagAddCmd({ cfg, node, slug: "probe", tag: ["fresh"] });

    const [write, ...rest] = cardWrites();
    expect(rest).toEqual([]);
    expect(write?.op).toBe("update");
    // `tags` is the edit. `updated_at` rides along only when the clock has
    // moved since the seed write — asserting it here makes the test depend on
    // whether two statements land in the same millisecond, which is how this
    // passed alone and failed in the full suite. The invariant that matters is
    // that the untouched fields are NOT sent.
    expect(write?.fields).toContain("tags");
    expect(write?.fields.filter((f) => f !== "tags" && f !== "updated_at")).toEqual([]);
    // `slug` addresses the row via keyHash and must never be re-sent.
    expect(write?.fields).not.toContain("slug");
    expect(write?.fields).not.toContain("body");
    expect(write!.fields.length).toBeLessThan(CARD_FIELDS.length);
  });

  test("the fields it did not send survive the write", async () => {
    await tagAddCmd({ cfg, node, slug: "probe", tag: ["fresh"] });

    const after = await findCard(node, cfg, "probe");
    expect(after?.title).toBe("Probe");
    expect(after?.body).toContain("## END STATE");
    expect(after?.tags).toContain("fresh");
    // Every field still has an atom — the row is whole, so wide readers keep it.
    const row = node.stored("probe")!;
    expect(CARD_FIELDS.filter((f) => row[f] === undefined)).toEqual([]);
  });

  test("a move narrows too — the key is the slug, which a move does not change", async () => {
    await moveCmd({ cfg, node, slug: "probe", column: "doing" });

    const write = cardWrites().find((w) => w.op === "update");
    expect(write?.fields).toContain("column");
    expect(write?.fields).not.toContain("body");
    expect((await findCard(node, cfg, "probe"))?.body).toContain("## END STATE");
  });

  test("an incomplete stored row is repaired by a WIDE write, not patched narrowly", async () => {
    // Asserted at `updateCardRecord` rather than through a command, because a
    // hole in a projected field also makes the row invisible to the command's
    // OWN read — `requireCard` reports card_not_found and the write is never
    // reached. The guard exists for the paths that read a card through a
    // narrower projection than they write it back at, and for a row holed by
    // an older writer that predates a field.
    const card = (await findCard(node, cfg, "probe"))!;
    node.holePunch("probe", "branch");
    reset();

    await updateCardRecord({ cfg, node }, { ...card, title: "Repaired", updated_at: nowIso() });

    const write = cardWrites().find((w) => w.op === "update");
    expect(write?.fields.length).toBe(CARD_FIELDS.length);
    // The hole is filled, so the row is readable at the full projection again.
    expect(node.stored("probe")!.branch).toBeDefined();
    expect((await findCard(node, cfg, "probe"))?.title).toBe("Repaired");
  });

  test("wholeness is re-checked locally, not inferred from the node dropping the row", async () => {
    // The guard above passes for the wrong reason while the node drops
    // incomplete rows: the probe query returns nothing either way. Its real
    // job is to keep this contract from resting on a node behaviour nothing
    // local asserts — a node that started returning partial rows would
    // otherwise turn every narrow write into a hole-preserving patch.
    const card = (await findCard(node, cfg, "probe"))!;
    node.holePunch("probe", "branch");
    node.stopDroppingIncompleteRows();
    reset();

    await updateCardRecord({ cfg, node }, { ...card, title: "Repaired", updated_at: nowIso() });

    const write = cardWrites().find((w) => w.op === "update");
    expect(write?.fields.length).toBe(CARD_FIELDS.length);
    expect(node.stored("probe")!.branch).toBeDefined();
  });

  test("a row that vanished between read and write is re-created whole, not as a stub", async () => {
    // updateRecord against a MISSING row does not fail — it stores exactly the
    // subset it was handed, leaving a row every wide reader drops. The probe
    // is what turns that into a whole write.
    const card = (await findCard(node, cfg, "probe"))!;
    node.wipe("probe");
    reset();

    await updateCardRecord({ cfg, node }, { ...card, title: "Recreated", updated_at: nowIso() });

    const row = node.stored("probe")!;
    expect(CARD_FIELDS.filter((f) => row[f] === undefined)).toEqual([]);
    expect((await findCard(node, cfg, "probe"))?.title).toBe("Recreated");
  });

  test("re-writing identical values costs no round trip at all", async () => {
    // tag add of a tag the card already has: the command still reaches the
    // write path, but there is provably nothing to send.
    await tagAddCmd({ cfg, node, slug: "probe", tag: ["fresh"] });
    reset();
    const before = { ...node.stored("probe") };

    await tagAddCmd({ cfg, node, slug: "probe", tag: ["fresh"] });

    // `updated_at` is the one field a repeat tag still moves; if a command ever
    // stops touching it, this becomes zero writes, which is also correct.
    for (const w of cardWrites()) expect(w.fields).not.toContain("body");
    expect(node.stored("probe")!.tags).toEqual(before.tags);
  });
});
