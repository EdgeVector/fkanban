// Lane guards must fire on lane ENTRY, not on every write to a card already in
// the lane. On 2026-07-30 restoring briefs the board had wiped was rejected with
// "cannot enter todo" for cards already sitting in todo, and `mark` — the
// anti-clobber append that exists for damaged cards — was unusable because it
// routes through `add` and has no --force to offer.
// See incident-kanban-card-briefs-lost-20260730.

import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { addCmd } from "../src/commands/add.ts";
import { markCmd } from "../src/commands/mark.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", milestone: "milestonehash" },
  enforceLivePrMilestone: true,
};

const BRIEF = "## GOAL\nship the thing\n## END STATE\nthe thing is shipped\n";
const RESTORED = "## GOAL\nrestored from backup\n## END STATE\nbrief is back on the card\n";

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const table = (hash: string) => {
    let value = store.get(hash);
    if (!value) {
      value = new Map();
      store.set(hash, value);
    }
    return value;
  };
  const rows = (hash: string, filter?: QueryFilter): QueryRow[] => {
    const source = table(hash);
    const entries = filter?.HashKey
      ? (source.has(filter.HashKey) ? [[filter.HashKey, source.get(filter.HashKey)!] as const] : [])
      : [...source.entries()];
    return entries.map(([key, fields]) => ({ fields, key: { hash: key, range: null } }));
  };
  const notImplemented = async (): Promise<never> => {
    throw new Error("not implemented");
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImplemented,
    bootstrap: notImplemented,
    loadSchemas: notImplemented,
    listSchemas: notImplemented,
    async createRecord({ schemaHash, keyHash, fields }) {
      table(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, keyHash, fields }) {
      table(schemaHash).set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      table(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rows(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImplemented,
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

async function seedBoard(node: NodeClient): Promise<void> {
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

// A Kind:pr card parked in default/todo with NO milestone — the shape the live
// board is full of, and the shape whose brief could not be restored.
async function seedMilestonelessTodoCard(node: NodeClient, slug: string, body = BRIEF): Promise<void> {
  await addCmd({
    cfg,
    node,
    slug,
    title: slug,
    kind: "pr",
    column: "todo",
    repo: "EdgeVector/fkanban",
    base: "main",
    body,
    force: true, // only the CREATE is forced; the updates under test are not
  });
}

describe("add update on a card already in the lane", () => {
  test("restores a brief in place on a milestone-less todo card", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedMilestonelessTodoCard(node, "wiped-card");

    const result = await addCmd({ cfg, node, slug: "wiped-card", body: RESTORED });

    expect(result.action).toBe("updated");
    expect(result.column).toBe("todo");
    const card = await findCard(node, cfg, "wiped-card");
    expect(card?.body).toBe(RESTORED);
    expect(card?.column).toBe("todo");
  });

  test("mark appends to a milestone-less todo card without --force", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedMilestonelessTodoCard(node, "marked-card");

    await markCmd({ cfg, node, slug: "marked-card", line: "HANDOFF: picked up by agent" });

    const card = await findCard(node, cfg, "marked-card");
    expect(card?.body).toContain("HANDOFF: picked up by agent");
    expect(card?.body).toContain("ship the thing");
    expect(card?.column).toBe("todo");
  });

  test("still refuses the same card when the write MOVES it", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedMilestonelessTodoCard(node, "moving-card");

    await expect(
      addCmd({ cfg, node, slug: "moving-card", body: RESTORED, column: "doing" }),
    ).rejects.toMatchObject({ code: "live_pr_milestone_required" });
  });

  test("still refuses an in-place write that INTRODUCES the violation", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-live",
      title: "Live",
      state: "active",
      northStar: "ns-a",
    });
    await addCmd({
      cfg,
      node,
      slug: "linked-card",
      title: "Linked",
      kind: "pr",
      column: "todo",
      milestone: "ms-live",
      northStar: "ns-a",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: BRIEF,
    });
    // The create path stamps Repo:/Base: headers into the stored body, so the
    // rejection is checked against what is actually on the card.
    const before = (await findCard(node, cfg, "linked-card"))!.body;

    // Clearing the milestone leaves the card where it is, but this write is the
    // one that breaks the invariant — it must not ride the repair exemption.
    await expect(
      addCmd({ cfg, node, slug: "linked-card", body: RESTORED, milestone: "" }),
    ).rejects.toMatchObject({ code: "live_pr_milestone_required" });

    const card = await findCard(node, cfg, "linked-card");
    expect(card?.body).toBe(before);
    expect(card?.milestone).toBe("ms-live");
  });

  test("in-place repair is exempt but a body WIPE is still refused", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await seedMilestonelessTodoCard(node, "wipe-target");
    const before = (await findCard(node, cfg, "wipe-target"))!.body;

    // assertBodyReplaceSafe is not a lane guard and keeps protecting the brief.
    await expect(
      addCmd({ cfg, node, slug: "wipe-target", body: "" }),
    ).rejects.toMatchObject({ code: "destructive_body_replace" });

    const card = await findCard(node, cfg, "wipe-target");
    expect(card?.body).toBe(before);
  });
});
