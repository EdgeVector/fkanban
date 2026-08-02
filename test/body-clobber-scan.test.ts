import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { groomBodyClobberScanResult } from "../src/commands/groom.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
};

const validPickupBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nKeep a normal work brief.\n\n## END STATE\nDone.";

async function seedBoard(node: ReturnType<typeof fakeNode>): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

describe("groom body-clobber-scan", () => {
  test("reports script-clobbered bodies without mutating cards", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await addCmd({ cfg, node, slug: "normal-card", column: "todo", body: validPickupBody });
    await addCmd({
      cfg,
      node,
      slug: "clobbered-card",
      title: "Clobbered card",
      column: "backlog",
      body: [
        "import json, subprocess, time, sys",
        "from collections import defaultdict",
        "",
        "ASSIGN = {",
        "    \"victim\": (\"north-star\", \"milestone\"),",
        "}",
        "",
        "def run(*args):",
        "    return subprocess.check_output(args, text=True)",
      ].join("\n"),
      force: true,
    });
    const writesBefore = node.writes.length;

    const { report, text } = await groomBodyClobberScanResult({ cfg, node });

    expect(report).toMatchObject({
      scanned: 2,
      candidates: 1,
      changed: 0,
      dryRun: true,
    });
    expect(report.cards.map((card) => card.slug)).toEqual(["clobbered-card"]);
    expect(text).toContain("DRY RUN, no writes");
    expect(node.writes).toHaveLength(writesBefore);
  });
});
