// `groom parity-check` is the read-only entrypoint a routine can run — the
// thing that was missing while doctor's parity checks were the only detector
// for a row silently dropped from every product read, and nothing ran doctor.
//
// Two properties decide whether it survives contact with a live board:
//
//   1. It must go RED on real drift. A gate that cannot fail is not a gate.
//   2. It must NOT go red on ordinary churn. `rank` is write-new-sk +
//      delete-old-sk and the pickup/groom routines write continuously, so a
//      check that pages on concurrent traffic gets muted within a week — and
//      then the one detector for silent row loss is unstaffed again, which is
//      exactly the state this command was written to fix.
//
// It must also never write. Doctor write-probes five schemas; that is why this
// is a separate entrypoint rather than a doctor flag, and the mutation-count
// assertion below is the part of that promise a test can hold.
import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { parityCheckResult } from "../src/commands/parity_check.ts";
import { boardCardSk } from "../src/board-cards.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "bchash" },
};

const BOARD = "default";
const SK_STAYS = boardCardSk("todo", "1", "stays");
const SK_LEAVES = boardCardSk("todo", "2", "leaves");

// `any_missing` — the fake's default — drops a row when ANY projected field
// lacks an atom, so every wide read here would return zero rows and each test
// would pass for the wrong reason. `hash_else_lead` is the measured rule.
function board(): FakeNode {
  const node = fakeNode({
    projectionRule: "hash_else_lead",
    hashFields: { bchash: "board", boardhash: "slug" },
  });
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    rangeKey: null,
    fields: {
      slug: BOARD,
      title: "Default",
      body: "",
      columns: "backlog,todo,doing,done",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  return node;
}

function seedCard(node: FakeNode, sk: string, slug: string, fields: Record<string, unknown> = {}) {
  node.seed({
    schemaHash: "bchash",
    keyHash: BOARD,
    rangeKey: sk,
    fields: { board: BOARD, sk, slug, title: slug, column: "todo", position: "1", ...fields },
  });
}

describe("groom parity-check", () => {
  test("a clean board is green, and says how much it actually checked", async () => {
    const node = board();
    seedCard(node, SK_STAYS, "stays");
    seedCard(node, SK_LEAVES, "leaves");

    const report = await parityCheckResult({ cfg, node });

    expect(report.ok).toBe(true);
    expect(report.drift).toEqual([]);
    expect(report.rows_checked).toBeGreaterThan(0);
  });

  // Property 1: it can fail.
  test("a row the board cannot serve turns it RED and names the slug", async () => {
    const node = board();
    seedCard(node, SK_STAYS, "stays");
    // No `board` atom: addressable, returned under every other lead, invisible
    // to the wide read this index's hash field gates. Its identity comes off
    // the RANGE KEY, not the payload copy — the sweep exists precisely because
    // a row that lost atoms may have lost `slug` too.
    const SK_ORPHAN = boardCardSk("todo", "2", "orphan");
    node.seed({
      schemaHash: "bchash",
      keyHash: BOARD,
      rangeKey: SK_ORPHAN,
      fields: { sk: SK_ORPHAN, slug: "orphan", title: "orphan", column: "todo" },
    });

    const report = await parityCheckResult({ cfg, node });

    expect(report.ok).toBe(false);
    const bc = report.drift.find((r) => r.index === "BoardCards");
    expect(bc?.drift).toEqual(["orphan"]);
    expect(bc?.confirmed).toBe(true);
  });

  // Property 2: it does not cry wolf. This is the one that decides whether the
  // routine survives its first week.
  test("a row deleted mid-check is churn — reported, but exit stays green", async () => {
    const node = board();
    seedCard(node, SK_STAYS, "stays");
    seedCard(node, SK_LEAVES, "leaves");

    // Delete on the first wide read of the partition, i.e. between the sweep
    // and the read it is compared against — the live race, deterministically.
    let deleted = false;
    const inner = node.queryAll.bind(node);
    node.queryAll = async (req) => {
      // The wide read is the multi-field one; the sweep asks for a single lead.
      // Delete BEFORE it runs, so the row is in the sweep and not in the read
      // it is compared against — the exact shape of a row the gate denied.
      if (!deleted && req.schemaHash === "bchash" && req.fields.length > 3) {
        deleted = true;
        await node.deleteRecord({ schemaHash: "bchash", keyHash: BOARD, rangeKey: SK_LEAVES });
      }
      return await inner(req);
    };

    const report = await parityCheckResult({ cfg, node });

    expect(report.drift).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.churn.flatMap((r) => r.moved)).toEqual(["leaves"]);
  });

  test("it never writes — that is the whole reason it is not a doctor flag", async () => {
    const node = board();
    seedCard(node, SK_STAYS, "stays");
    seedCard(node, SK_LEAVES, "leaves");

    await parityCheckResult({ cfg, node });

    expect(node.writes).toEqual([]);
  });
});
