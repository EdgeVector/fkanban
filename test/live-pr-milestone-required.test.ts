import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { assertLivePrMilestone, boardToFields, nowIso } from "../src/record.ts";
import { FkanbanError } from "../src/client.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
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

describe("assertLivePrMilestone", () => {
  test("requires milestone for Kind:pr in todo/doing (pickup lane)", () => {
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" }, false, {
        enforce: true,
      })
    ).toThrow(FkanbanError);
    try {
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "doing", milestone: "" }, false, {
        enforce: true,
      });
    } catch (err) {
      expect(err).toMatchObject({ code: "live_pr_milestone_required" });
    }
    // backlog is allowed without milestone (hygiene flags; not hard-reject)
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "backlog", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "doing", milestone: "ms-a" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    // enforce flag off → no-op (unit-test default)
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" })
    ).not.toThrow();
  });

  test("allows non-pr, done column, backlog, and --force", () => {
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "validation", column: "todo", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "done", milestone: "" }, false, {
        enforce: true,
      })
    ).not.toThrow();
    expect(() =>
      assertLivePrMilestone({ slug: "x", kind: "pr", column: "todo", milestone: "" }, true, {
        enforce: true,
      })
    ).not.toThrow();
  });

  test("rejects abandoned milestones", () => {
    try {
      assertLivePrMilestone(
        { slug: "x", kind: "pr", column: "todo", milestone: "old" },
        false,
        { milestoneState: "abandoned", enforce: true },
      );
      throw new Error("expected throw");
    } catch (err) {
      expect(err).toMatchObject({ code: "live_pr_milestone_abandoned" });
    }
  });

  test("add/move enforce live Kind:pr milestone with force escape", async () => {
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
    await expect(
      addCmd({
        cfg,
        node,
        slug: "no-ms-pr",
        title: "No MS",
        kind: "pr",
        column: "todo",
        repo: "EdgeVector/fkanban",
        base: "main",
        body: "## GOAL\nok\n## END STATE\nok\n",
      }),
    ).rejects.toMatchObject({ code: "live_pr_milestone_required" });

    await addCmd({
      cfg,
      node,
      slug: "with-ms-pr",
      title: "With MS",
      kind: "pr",
      column: "todo",
      milestone: "ms-live",
      northStar: "ns-a",
      repo: "EdgeVector/fkanban",
      base: "main",
      body: "## GOAL\nok\n## END STATE\nok\n",
    });

    await addCmd({
      cfg,
      node,
      slug: "force-pr",
      title: "Forced",
      kind: "pr",
      column: "backlog",
      repo: "EdgeVector/fkanban",
      base: "main",
      force: true,
      body: "## GOAL\nok\n## END STATE\nok\n",
    });
    await expect(moveCmd({
      cfg,
      node,
      slug: "force-pr",
      column: "todo",
    })).rejects.toMatchObject({ code: "live_pr_milestone_required" });
    await moveCmd({ cfg, node, slug: "force-pr", column: "todo", force: true });
  });
});
