// Columns are FIXED: backlog → todo → doing → done. `board create` rejects any
// other list (including duplicates and custom names) before writing.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { listBoards } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { boardCreateCmd } from "../src/commands/board.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};


describe("board create uses fixed columns only", () => {
  let node: NodeClient;

  beforeEach(() => {
    node = fakeNode();
  });

  test("duplicate names are rejected as invalid_columns (not written)", async () => {
    await expect(
      boardCreateCmd({ cfg, node, slug: "dup", columns: ["todo", "todo", "done"] }),
    ).rejects.toMatchObject({ code: "invalid_columns" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "dup")).toBeUndefined();
  });

  test("arbitrary custom names are rejected", async () => {
    try {
      await boardCreateCmd({ cfg, node, slug: "custom", columns: ["alpha", "beta", "ship"] });
      throw new Error("expected invalid_columns");
    } catch (err) {
      expect(err).toBeInstanceOf(FkanbanError);
      const e = err as FkanbanError;
      expect(e.code).toBe("invalid_columns");
      expect(e.message).toContain("backlog,todo,doing,done");
    }
    expect((await listBoards(node, cfg)).find((b) => b.slug === "custom")).toBeUndefined();
  });

  test("wrong order is rejected", async () => {
    await expect(
      boardCreateCmd({
        cfg,
        node,
        slug: "reordered",
        columns: ["todo", "backlog", "doing", "done"],
      }),
    ).rejects.toMatchObject({ code: "invalid_columns" });
  });

  test("exact fixed list is accepted", async () => {
    const res = await boardCreateCmd({
      cfg,
      node,
      slug: "ok",
      columns: ["backlog", "todo", "doing", "done"],
    });
    expect(res).toMatchObject({ action: "created", slug: "ok" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "ok")?.columns).toEqual([...DEFAULT_COLUMNS]);
  });

  test("no columns supplied → fixed columns", async () => {
    const res = await boardCreateCmd({ cfg, node, slug: "defaulted" });
    expect(res).toMatchObject({ action: "created" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "defaulted")?.columns).toEqual([...DEFAULT_COLUMNS]);
  });

  test("empty column list → fixed columns", async () => {
    const res = await boardCreateCmd({ cfg, node, slug: "empty", columns: [] });
    expect(res).toMatchObject({ action: "created" });
    const boards = await listBoards(node, cfg);
    expect(boards.find((b) => b.slug === "empty")?.columns).toEqual([...DEFAULT_COLUMNS]);
  });

  test("update always rewrites to fixed columns", async () => {
    await boardCreateCmd({ cfg, node, slug: "b1" });
    const res = await boardCreateCmd({ cfg, node, slug: "b1", title: "Renamed" });
    expect(res).toMatchObject({ action: "updated", slug: "b1" });
    const boards = await listBoards(node, cfg);
    const b = boards.find((x) => x.slug === "b1");
    expect(b?.title).toBe("Renamed");
    expect(b?.columns).toEqual([...DEFAULT_COLUMNS]);
  });
});
