// Compound prevention for the NS/MS backfill body-clobber incidents
// (papercut-fkanban-53-card-bodies-clobbered-by-a-stray-script /
//  papercut-kanban-card-body-overwritten-by-ns-ms-backfill-script):
//
// 1. A card with a substantive ## GOAL / ## END STATE brief stays byte-identical
//    after a metadata-only update path (`set` and body-omitted `add`).
// 2. A raw-script `--body` write against that card is rejected without force.
// 3. `ensureDbHeader` must not invent a body from ambient LASTDB_DB alone
//    (that turned metadata-only `add` into a destructive replace).

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { ensureDbHeader } from "../src/cli.ts";
import { addCmd } from "../src/commands/add.ts";
import { setCmd } from "../src/commands/set.ts";
import {
  boardToFields,
  findCard,
  nowIso,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const substantiveBody = [
  "Repo: EdgeVector/fkanban",
  "Base: main",
  "Kind: pr",
  "",
  "## GOAL",
  "Keep the real brief intact through metadata stamps.",
  "",
  "## END STATE",
  "Body is byte-identical after north_star/milestone-style updates; script body is refused.",
].join("\n");

const scriptBody = [
  "#!/usr/bin/env python3",
  "import json, subprocess, time, sys",
  "from collections import defaultdict",
  "",
  "ASSIGN = {",
  '    "victim": ("north-star-example", "milestone-example"),',
  "}",
  "",
  "def run(*args):",
  "    return subprocess.check_output(args, text=True)",
  "",
].join("\n");

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns,
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("compound: metadata-only path preserves body; script body is refused", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("set --north-star leaves the brief byte-identical", async () => {
    await addCmd({
      cfg,
      node,
      slug: "compound-set-ns",
      title: "Compound set",
      column: "todo",
      body: substantiveBody,
    });

    await setCmd({
      cfg,
      node,
      slug: "compound-set-ns",
      northStar: "north-star-example-ns",
      title: "Compound set (retitled)",
    });

    const card = await findCard(node, cfg, "compound-set-ns");
    expect(card?.body).toBe(substantiveBody);
    expect(card?.north_star).toBe("north-star-example-ns");
    expect(card?.title).toBe("Compound set (retitled)");
  });

  test("add without body (metadata-only) leaves the brief byte-identical", async () => {
    await addCmd({
      cfg,
      node,
      slug: "compound-add-meta",
      title: "Compound add meta",
      column: "todo",
      body: substantiveBody,
    });

    await addCmd({
      cfg,
      node,
      slug: "compound-add-meta",
      northStar: "north-star-via-add",
      // body intentionally omitted
    });

    const card = await findCard(node, cfg, "compound-add-meta");
    expect(card?.body).toBe(substantiveBody);
    expect(card?.north_star).toBe("north-star-via-add");
  });

  test("add --body with raw-script signature is rejected without force", async () => {
    await addCmd({
      cfg,
      node,
      slug: "compound-script-reject",
      title: "Compound script reject",
      column: "todo",
      body: substantiveBody,
    });

    await expect(
      addCmd({ cfg, node, slug: "compound-script-reject", body: scriptBody }),
    ).rejects.toMatchObject({ code: "body_source_tripwire" });

    expect((await findCard(node, cfg, "compound-script-reject"))?.body).toBe(substantiveBody);
  });

  test("set refuses missing cards and empty field sets", async () => {
    await expect(
      setCmd({ cfg, node, slug: "does-not-exist", northStar: "x" }),
    ).rejects.toMatchObject({ code: "card_not_found" });

    await addCmd({
      cfg,
      node,
      slug: "compound-empty-set",
      title: "Empty set",
      column: "todo",
      body: substantiveBody,
    });

    await expect(setCmd({ cfg, node, slug: "compound-empty-set" })).rejects.toMatchObject({
      code: "set_no_fields",
    });
  });
});

describe("ensureDbHeader never invents a body from ambient --db alone", () => {
  test("undefined body stays undefined when a locator is present", () => {
    expect(ensureDbHeader(undefined, "lastdb://personal")).toBeUndefined();
  });

  test("existing body still receives the Db header", () => {
    const stamped = ensureDbHeader(substantiveBody, "lastdb://personal");
    expect(stamped).toContain("Db: lastdb://personal");
    expect(stamped).toContain("## GOAL");
  });
});
