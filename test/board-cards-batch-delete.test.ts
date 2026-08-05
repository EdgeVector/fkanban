/**
 * The delete half of a BoardCards write must cost one partition-gate
 * acquisition per CHUNK, not one per row.
 *
 * A BoardCards write gates per `(molecule, hash-half)`, so every row of one
 * board shares one gate — a per-row reap takes the whole board's write gate
 * once per row, behind every other kanban process writing that board. The node
 * always accepted batched deletes; this client only ever sent
 * `mutation_type: "update"` in a batch, so no reap path could reach it.
 *
 * These assert the two halves that can independently be wrong:
 *
 *   1. the reap paths ASK for a batch (fake-node `deleteBatches`)
 *   2. the client SENDS a delete when asked (wire shape, over a stub server)
 *
 * (2) is not ceremony. The defect being fixed was entirely in the wire shape —
 * a batch verb that reached the node, returned 200, and could not express a
 * delete — and a fake that records whatever it is handed cannot see that.
 */
import { describe, expect, test } from "bun:test";
import { fakeNode } from "./fake-node.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_WRITE_BATCH,
  boardCardSk,
  deleteBoardCardRowsBySk,
  purgeOtherBoardCardRows,
} from "../src/board-cards.ts";
import type { Config } from "../src/config.ts";

const BOARD_CARDS = "bc-schema-hash";
const BOARD = "default";

function cfg(): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes: { board_cards: BOARD_CARDS },
  } as unknown as Config;
}

function node() {
  const n = fakeNode({ hashFields: { [BOARD_CARDS]: "board" } });
  return n;
}

function seedRow(n: ReturnType<typeof node>, slug: string, position: number) {
  const sk = boardCardSk("todo", position, slug);
  n.seed({
    schemaHash: BOARD_CARDS,
    keyHash: BOARD,
    rangeKey: sk,
    fields: { board: BOARD, sk, slug, column: "todo", position: String(position) },
  });
  return sk;
}

describe("deleteBoardCardRowsBySk", () => {
  test("reaps a chunk's worth of sks in ONE request, not one per row", async () => {
    const n = node();
    const sks = Array.from({ length: BOARD_CARDS_WRITE_BATCH }, (_, i) => seedRow(n, `card-${i}`, 1000 + i));

    const attempted = await deleteBoardCardRowsBySk(n, cfg(), BOARD, sks);

    expect(attempted).toBe(sks.length);
    // The assertion that fails if this reverts to a per-row loop.
    expect(n.deleteBatches.length).toBe(1);
    expect(n.deleteBatches[0]!.length).toBe(sks.length);
    // ...and the rows are actually gone, not merely "requested".
    for (const sk of sks) {
      expect(n.rowAt(BOARD_CARDS, BOARD, sk)).toBeUndefined();
    }
  });

  test("splits at the chunk bound rather than sending one unbounded request", async () => {
    const n = node();
    const count = BOARD_CARDS_WRITE_BATCH + 5;
    const sks = Array.from({ length: count }, (_, i) => seedRow(n, `card-${i}`, 1000 + i));

    await deleteBoardCardRowsBySk(n, cfg(), BOARD, sks);

    expect(n.deleteBatches.map((b) => b.length)).toEqual([BOARD_CARDS_WRITE_BATCH, 5]);
  });

  test("empty and blank sks cost no request at all", async () => {
    const n = node();
    expect(await deleteBoardCardRowsBySk(n, cfg(), BOARD, [])).toBe(0);
    expect(await deleteBoardCardRowsBySk(n, cfg(), BOARD, ["", ""])).toBe(0);
    expect(n.deleteBatches.length).toBe(0);
    expect(n.writes.length).toBe(0);
  });

  test("a rejected chunk still reaps every row it can, one at a time", async () => {
    const n = node();
    const sks = Array.from({ length: 3 }, (_, i) => seedRow(n, `card-${i}`, 1000 + i));
    // The node names the BATCH, never the item, so the fallback has to ask for
    // each row separately — and swallow the ones that are already gone.
    n.deleteRecords = async () => {
      throw new Error("batch rejected");
    };

    const attempted = await deleteBoardCardRowsBySk(n, cfg(), BOARD, sks);

    expect(attempted).toBe(3);
    for (const sk of sks) {
      expect(n.rowAt(BOARD_CARDS, BOARD, sk)).toBeUndefined();
    }
  });

  test("a client with no batch delete verb still reaps, per row", async () => {
    const n = node();
    const sks = Array.from({ length: 3 }, (_, i) => seedRow(n, `card-${i}`, 1000 + i));
    // The ad-hoc fakes implement only what their subject touches; losing speed
    // is the only acceptable consequence of that.
    delete (n as { deleteRecords?: unknown }).deleteRecords;

    expect(await deleteBoardCardRowsBySk(n, cfg(), BOARD, sks)).toBe(3);
    for (const sk of sks) {
      expect(n.rowAt(BOARD_CARDS, BOARD, sk)).toBeUndefined();
    }
  });
});

describe("purgeOtherBoardCardRows", () => {
  test("batches the orphan reap and keeps keepSk", async () => {
    const n = node();
    const keep = seedRow(n, "dup", 1000);
    const orphans = [1001, 1002, 1003].map((p) => seedRow(n, "dup", p));
    seedRow(n, "other", 2000); // a different slug must survive untouched

    const purged = await purgeOtherBoardCardRows(n, cfg(), BOARD, "dup", keep);

    expect(purged).toBe(orphans.length);
    expect(n.deleteBatches.length).toBe(1);
    expect(n.deleteBatches[0]!.sort()).toEqual([...orphans].sort());
    expect(n.rowAt(BOARD_CARDS, BOARD, keep)).toBeDefined();
    expect(n.rowAt(BOARD_CARDS, BOARD, boardCardSk("todo", 2000, "other"))).toBeDefined();
  });

  test("a slug with nothing to purge issues no delete request", async () => {
    const n = node();
    const keep = seedRow(n, "lonely", 1000);

    expect(await purgeOtherBoardCardRows(n, cfg(), BOARD, "lonely", keep)).toBe(0);
    expect(n.deleteBatches.length).toBe(0);
  });
});

describe("NodeClient.deleteRecords wire shape", () => {
  /**
   * Drive the REAL client against a stub node and read what went on the wire.
   * fold's `Operation` is `deny_unknown_fields`, so a misspelled key is a 400
   * rather than a dropped field — and `mutation_type` is the exact key this
   * client got wrong by only ever sending "update".
   */
  async function captureBatchBody(
    drive: (client: ReturnType<typeof newNodeClient>) => Promise<void>,
  ): Promise<unknown> {
    let captured: unknown = null;
    const server = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/mutations/batch") {
          captured = await req.json();
          return Response.json({ success: true });
        }
        return Response.json({});
      },
    });
    try {
      await drive(newNodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, userHash: "test-user" }));
    } finally {
      await server.stop(true);
    }
    return captured;
  }

  test("sends mutation_type delete, with the key and no fields", async () => {
    const body = await captureBatchBody((client) =>
      client.deleteRecords!([
        { schemaHash: BOARD_CARDS, keyHash: BOARD, rangeKey: "todo#1000#card-a" },
        { schemaHash: BOARD_CARDS, keyHash: BOARD, rangeKey: "todo#1001#card-b" },
      ]),
    );

    expect(body).toEqual([
      {
        type: "mutation",
        schema: BOARD_CARDS,
        fields_and_values: {},
        key_value: { hash: BOARD, range: "todo#1000#card-a" },
        mutation_type: "delete",
      },
      {
        type: "mutation",
        schema: BOARD_CARDS,
        fields_and_values: {},
        key_value: { hash: BOARD, range: "todo#1001#card-b" },
        mutation_type: "delete",
      },
    ]);
  });

  test("still sends mutation_type update for updateRecords", async () => {
    // The two verbs share one envelope builder; this is the assertion that
    // stops a delete-shaped change from quietly retyping every batched WRITE.
    const body = await captureBatchBody((client) =>
      client.updateRecords!([
        { schemaHash: BOARD_CARDS, fields: { slug: "a" }, keyHash: BOARD, rangeKey: "todo#1000#a" },
      ]),
    );

    expect(body).toEqual([
      {
        type: "mutation",
        schema: BOARD_CARDS,
        fields_and_values: { slug: "a" },
        key_value: { hash: BOARD, range: "todo#1000#a" },
        mutation_type: "update",
      },
    ]);
  });

  test("an empty batch is not a request", async () => {
    const body = await captureBatchBody((client) => client.deleteRecords!([]));
    expect(body).toBeNull();
  });

  test("a non-200 from the batch route throws rather than reading as reaped", async () => {
    const server = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "nope" }, { status: 400 }),
    });
    try {
      const client = newNodeClient({ baseUrl: `http://127.0.0.1:${server.port}`, userHash: "test-user" });
      await expect(
        client.deleteRecords!([{ schemaHash: BOARD_CARDS, keyHash: BOARD, rangeKey: "todo#1#a" }]),
      ).rejects.toThrow();
    } finally {
      await server.stop(true);
    }
  });
});
