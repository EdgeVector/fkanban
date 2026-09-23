// papercut-kanban-body-write-resources-pr-url-from-stale-pr-header-20260923
//
// `set --pr-url <new>` then `mark "<line>"` on a card whose body still carries
// an old `PR:` note must keep <new>. Before the fix, the mark (a body write)
// re-sourced pr_url from the old header, and board-closeout then treated the
// live card as owned by a closed PR and rolled it back to todo.

import { expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { markCmd } from "../src/commands/mark.ts";
import { moveCmd } from "../src/commands/move.ts";
import { setCmd } from "../src/commands/set.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const OLD = "http://forge/EdgeVector/last-stack/pulls/132";
const NEW = "http://forge/EdgeVector/last-stack/pulls/137";

test("mark after set --pr-url keeps the newer PR", async () => {
  const node = fakeNode();
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
  const body = [
    "Repo: EdgeVector/last-stack",
    "Base: main",
    "Kind: pr",
    "",
    "## GOAL",
    "Keep the live PR.",
    "",
    "## END STATE",
    "The card points at the live PR.",
    "",
    `PR: ${OLD} closed-not-merged; re-dispatch`,
  ].join("\n");
  await addCmd({ cfg, node, slug: "live-pr", title: "Live PR", column: "backlog", body });
  await moveCmd({ cfg, node, slug: "live-pr", column: "doing", force: true });
  expect((await findCard(node, cfg, "live-pr"))?.pr_url).toBe(OLD);

  await setCmd({ cfg, node, slug: "live-pr", prUrl: NEW });
  expect((await findCard(node, cfg, "live-pr"))?.pr_url).toBe(NEW);

  await markCmd({ cfg, node, slug: "live-pr", line: "PROGRESS: CI green on PR 137" });
  const after = await findCard(node, cfg, "live-pr");
  expect(after?.pr_url).toBe(NEW);
  expect(after?.body.endsWith("PROGRESS: CI green on PR 137")).toBe(true);

  // A move keeps it too (body unchanged).
  await moveCmd({ cfg, node, slug: "live-pr", column: "doing" });
  expect((await findCard(node, cfg, "live-pr"))?.pr_url).toBe(NEW);
});
