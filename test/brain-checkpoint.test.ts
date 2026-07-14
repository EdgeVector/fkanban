import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { rmCmd } from "../src/commands/rm.ts";
import {
  checkpointCardCompletion,
  ORPHAN_COMPLETION_LEDGER,
  setBrainCheckpointClientForTest,
} from "../src/brain_checkpoint.ts";
import {
  boardToFields,
  cardToFields,
  findCard,
  nowIso,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function fakeNode(): NodeClient {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({ fields, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      tableFor(schemaHash).set(keyHash, fields);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      tableFor(schemaHash).delete(keyHash);
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function seedBoard(node: NodeClient, slug = "default", columns: string[] = [...DEFAULT_COLUMNS]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

function seedCard(node: NodeClient, card: Partial<Card> & Pick<Card, "slug" | "column">) {
  const now = nowIso();
  const full: Card = {
    slug: card.slug,
    title: card.title ?? card.slug,
    body: card.body ?? "",
    board: card.board ?? "default",
    column: card.column,
    position: card.position ?? "10",
    assignee: card.assignee ?? "",
    tags: card.tags ?? [],
    deps: card.deps ?? [],
    surfaces: card.surfaces ?? [],
    created_at: card.created_at ?? now,
    updated_at: card.updated_at ?? now,
    done_at: card.done_at ?? "",
    db: card.db ?? "",
    repo: card.repo ?? "",
    base: card.base ?? "",
    kind: card.kind ?? "",
    block_status: card.block_status ?? "",
    block_reason: card.block_reason ?? "",
    north_star: card.north_star ?? "",
    pr_url: card.pr_url ?? "",
    branch: card.branch ?? "",
  };
  return node.createRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: full.slug,
    fields: cardToFields(full),
  });
}

function fakeBrain(seed: Record<string, { type?: string; body: string }> = {}) {
  const records = new Map(Object.entries(seed));
  const puts: string[] = [];
  const appends: Array<{ slug: string; chunk: string; type?: string }> = [];
  return {
    records,
    puts,
    appends,
    client: {
      async get(slug: string) {
        const record = records.get(slug);
        return record ? { slug, ...record } : null;
      },
      async put(record: { slug: string; type: string; body: string }) {
        puts.push(record.slug);
        records.set(record.slug, { type: record.type, body: record.body });
      },
      async append(slug: string, chunk: string, type?: string) {
        appends.push({ slug, chunk, type });
        const current = records.get(slug) ?? { type, body: "" };
        records.set(slug, { ...current, body: current.body + chunk });
      },
    },
  };
}

let restoreBrainClient = () => {};

afterEach(() => {
  restoreBrainClient();
  restoreBrainClient = () => {};
});

describe("F-Brain completion checkpoints", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node);
  });

  test("moving a card to done appends a checkpoint to its explicit North Star", async () => {
    const brain = fakeBrain({ "north-star-x": { type: "project", body: "# North Star X\n" } });
    restoreBrainClient = setBrainCheckpointClientForTest(brain.client);

    await addCmd({
      cfg,
      node,
      slug: "ship-x",
      title: "Ship X",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\nNorth Star: north-star-x\nPR: https://example.invalid/pr/1\n",
    });

    await moveCmd({ cfg, node, slug: "ship-x", column: "done" });

    const body = brain.records.get("north-star-x")?.body ?? "";
    expect(body).toContain("<!-- fkanban-completion-checkpoint:ship-x -->");
    expect(body).toContain("Repo/base/kind: EdgeVector/fkanban / main");
    expect(body).toContain("PR/proof: https://example.invalid/pr/1");
    expect(body).toContain("Candidate complete: no remaining live non-terminal F-Kanban execution cards");
    expect((await findCard(node, cfg, "ship-x"))?.done_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  test("active-programs can resolve an owner when the card has no North Star header", async () => {
    const brain = fakeBrain({
      "active-programs": {
        type: "project",
        body: "## Program A\n**program-slug:** `[[program-a]]`\n\ncards: active-owned-card\n",
      },
      "program-a": { type: "project", body: "# Program A\n" },
    });
    restoreBrainClient = setBrainCheckpointClientForTest(brain.client);

    await addCmd({
      cfg,
      node,
      slug: "active-owned-card",
      title: "Active owned",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n",
    });

    await moveCmd({ cfg, node, slug: "active-owned-card", column: "done" });

    const body = brain.records.get("program-a")?.body ?? "";
    expect(body).toContain("<!-- fkanban-completion-checkpoint:active-owned-card -->");
    expect(brain.appends.at(-1)?.slug).toBe("program-a");
  });

  test("delete backstop writes an orphan checkpoint for old done cards before tombstone", async () => {
    const brain = fakeBrain();
    restoreBrainClient = setBrainCheckpointClientForTest(brain.client);
    await seedCard(node, {
      slug: "legacy-done",
      title: "Legacy done",
      column: "done",
      done_at: "2026-07-01T00:00:00.000Z",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
    });

    await rmCmd({ cfg, node, slug: "legacy-done" });

    const body = brain.records.get(ORPHAN_COMPLETION_LEDGER)?.body ?? "";
    expect(brain.puts).toContain(ORPHAN_COMPLETION_LEDGER);
    expect(body).toContain("<!-- fkanban-completion-checkpoint:legacy-done -->");
    expect(await findCard(node, cfg, "legacy-done")).toBeNull();
  });

  test("move to done still persists when F-Brain is unconfigured/unreachable", async () => {
    // Simulate a fresh machine / CI / isolated $HOME: the spawned `fbrain` CLI
    // rejects because there is no ~/.fbrain/config.json. The checkpoint must
    // degrade to a warning, and the column write must still land.
    const failingClient = {
      async get() {
        throw new Error("Config not found at /tmp/isolated/.fbrain/config.json.\n  hint: Run `fbrain init` to create it.");
      },
      async put(): Promise<void> {
        throw new Error("Config not found at /tmp/isolated/.fbrain/config.json.");
      },
      async append(): Promise<void> {
        throw new Error("Config not found at /tmp/isolated/.fbrain/config.json.");
      },
    };
    restoreBrainClient = setBrainCheckpointClientForTest(failingClient);
    await seedCard(node, {
      slug: "isolated-home-card",
      title: "Isolated home card",
      column: "review",
      repo: "EdgeVector/fkanban",
      base: "main",
    });

    const warnings: string[] = [];
    const res = await checkpointCardCompletion({
      cfg,
      node,
      card: { ...(await findCard(node, cfg, "isolated-home-card"))!, column: "done" },
      boardColumns: [...DEFAULT_COLUMNS],
      reason: "done-transition",
      warn: (m) => warnings.push(m),
    });
    expect(res.action).toBe("skipped");
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain("Config not found");
    expect(warnings[0]).not.toContain("\n"); // one-line, not a raw stack

    // And the end-to-end move actually persists the column despite the failure.
    const moved = await moveCmd({ cfg, node, slug: "isolated-home-card", column: "done" });
    expect(moved.to).toBe("done");
    expect((await findCard(node, cfg, "isolated-home-card"))?.column).toBe("done");
  });
});
