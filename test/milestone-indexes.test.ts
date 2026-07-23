import { describe, expect, test } from "bun:test";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { milestoneAddCmd, milestoneGapReportResult, milestoneReconcileResult } from "../src/commands/milestone.ts";
import { addCmd } from "../src/commands/add.ts";
import {
  boardToFields,
  listMilestones,
  nowIso,
} from "../src/record.ts";
import { listMilestoneCardsPartition } from "../src/milestone-cards.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_milestones: "boardms-hash",
    milestone_cards: "mscards-hash",
  },
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  // HashRange: key = `${hash}\0${range}`
  const table = (hash: string) => {
    let value = store.get(hash);
    if (!value) {
      value = new Map();
      store.set(hash, value);
    }
    return value;
  };
  const rowKey = (keyHash: string, rangeKey?: string | null) =>
    rangeKey != null && rangeKey !== "" ? `${keyHash}\0${rangeKey}` : keyHash;

  const rows = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const source = table(schemaHash);
    const entries = [...source.entries()];
    if (filter?.HashKey) {
      const hk = filter.HashKey;
      return entries
        .filter(([k]) => k === hk || k.startsWith(`${hk}\0`))
        .map(([k, fields]) => {
          const range = k.includes("\0") ? k.slice(k.indexOf("\0") + 1) : null;
          return { fields, key: { hash: hk, range } };
        });
    }
    // unfiltered
    return entries.map(([k, fields]) => {
      const i = k.indexOf("\0");
      return {
        fields,
        key: i >= 0 ? { hash: k.slice(0, i), range: k.slice(i + 1) } : { hash: k, range: null },
      };
    });
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
    async createRecord({ schemaHash, keyHash, fields, rangeKey }) {
      table(schemaHash).set(rowKey(keyHash, rangeKey), { ...fields });
    },
    async updateRecord({ schemaHash, keyHash, fields, rangeKey }) {
      table(schemaHash).set(rowKey(keyHash, rangeKey), { ...fields });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      table(schemaHash).delete(rowKey(keyHash, rangeKey));
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

describe("milestone HashRange indexes", () => {
  test("dual-write BoardMilestones on milestone add; list uses partition not scan", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-a",
      title: "Outcome A",
      state: "active",
      northStar: "north-star-x",
      driver: "last-stack-milestone-driver",
    });

    const part = await listBoardMilestonesPartition(node, cfg, "default");
    expect(part?.map((m) => m.slug)).toEqual(["ms-a"]);
    expect(part?.[0]?.north_star).toBe("north-star-x");

    const listed = await listMilestones(node, cfg);
    expect(listed.find((m) => m.slug === "ms-a")?.title).toBe("Outcome A");
  });

  test("dual-write MilestoneCards on card add; reconcile uses partition", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-b",
      title: "Outcome B",
      state: "active",
      northStar: "ns-b",
      driver: "driver",
    });
    await addCmd({
      cfg,
      node,
      slug: "pr-b",
      title: "PR B",
      milestone: "ms-b",
      northStar: "ns-b",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork.\n\n## END STATE\nDone.\n",
    });

    const kids = await listMilestoneCardsPartition(node, cfg, "ms-b");
    expect(kids?.map((c) => c.slug)).toEqual(["pr-b"]);
    expect(kids?.[0]?.body).toBe(""); // thin index

    const rec = await milestoneReconcileResult({ cfg, node, slug: "ms-b" });
    expect(rec.children.map((c) => c.slug)).toContain("pr-b");
    expect(rec.ready.map((c) => c.slug)).toContain("pr-b");
  });

  test("gap-report sees north_star via BoardMilestones dual-write", async () => {
    const node = fakeNode();
    await seedBoard(node);
    await milestoneAddCmd({
      cfg,
      node,
      slug: "ms-empty",
      title: "Empty",
      state: "planned",
      northStar: "ns-c",
      driver: "driver",
    });
    const { report } = await milestoneGapReportResult({ cfg, node });
    const entry = report.milestones.find((m) => m.slug === "ms-empty");
    expect(entry?.north_star).toBe("ns-c");
    expect(entry?.status).toBe("idle_empty");
    expect(entry?.action).toBe("decompose");
  });
});
