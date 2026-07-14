// Regression (fkanban-overlap-block-false-positive-dep-serialized): the pickup
// area-overlap checker must not fire between cards a `deps` edge already
// serializes, and an explicit `--block-status none` must survive the same write.
//
// These drive the REAL `addCmd` (the CLI's create/update entry) against the
// in-memory fake NodeClient used across the add/mcp tests — so they reproduce
// the papercut end-to-end through the command path, not just the pure helper.

import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError, type NodeClient, type QueryFilter, type QueryResponse, type QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  findCard,
  normalizeBlockStatus,
  nowIso,
  PICKUP_AREA_ACTIVE_COLUMNS,
  PICKUP_AREA_BLOCK_PREFIX,
  PICKUP_AREA_PEER_FIELDS,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function fakeNode(opts: { rejectColumnFilter?: boolean } = {}): NodeClient & {
  cardQueries: Array<{ fields: string[]; filter?: QueryFilter }>;
} {
  const store = new Map<string, Map<string, Record<string, unknown>>>();
  const cardQueries: Array<{ fields: string[]; filter?: QueryFilter }> = [];
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter, wantedFields?: string[]): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : [])
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({
      fields: wantedFields
        ? Object.fromEntries(wantedFields.filter((field) => field in fields).map((field) => [field, fields[field]]))
        : fields,
      key: { hash, range: null },
    }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    cardQueries,
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
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      if (schemaHash === cfg.schemaHashes.card!) cardQueries.push({ fields, filter });
      if (schemaHash === cfg.schemaHashes.card! && opts.rejectColumnFilter && filter?.column !== undefined) {
        throw new FkanbanError({
          code: "node_http_400",
          message: "Node /api/query returned HTTP 400: unsupported field filter.",
        });
      }
      const results = rowsFor(schemaHash, filter, fields);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

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

// A body that cites a shared fbrain slug AND names a shared command, so the
// area-tag derivation gives both cards `area:fbrain-list`.
function sharedAreaBody(): string {
  return "Repo: EdgeVector/fbrain\nBase: main\n\nSee fbrain note delete-the-dev-node. Uses `fbrain list`.";
}

describe("pickup overlap: dep serialization + explicit clear (addCmd e2e)", () => {
  let node: ReturnType<typeof fakeNode>;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("two cards citing the same fbrain slug, B deps on A in backlog → neither is overlap-blocked", async () => {
    await addCmd({
      cfg,
      node,
      slug: "ddn-step-a",
      title: "Delete dev node — step A",
      column: "todo",
      body: sharedAreaBody(),
    });
    // Dependent stays in backlog until A is done (default/todo is dep-gated).
    await addCmd({
      cfg,
      node,
      slug: "ddn-step-b",
      title: "Delete dev node — step B",
      column: "backlog",
      body: sharedAreaBody(),
      deps: ["ddn-step-a"], // the dep edge already serializes pickup
    });

    const a = await findCard(node, cfg, "ddn-step-a");
    const b = await findCard(node, cfg, "ddn-step-b");

    // Both derived the shared area tag (so absent the fix this WOULD block).
    expect(a?.tags).toContain("area:fbrain-list");
    expect(b?.tags).toContain("area:fbrain-list");

    // ...but the dep edge suppresses the false-positive overlap block on both.
    expect(normalizeBlockStatus(a!.block_status)).toBe("none");
    expect(normalizeBlockStatus(b!.block_status)).toBe("none");
    expect(a?.block_reason ?? "").not.toContain(PICKUP_AREA_BLOCK_PREFIX);
    expect(b?.block_reason ?? "").not.toContain(PICKUP_AREA_BLOCK_PREFIX);
    expect(b?.column).toBe("backlog");
  });

  test("same-feature forge CI cards are overlap-held without explicit area tags", async () => {
    await addCmd({
      cfg,
      node,
      slug: "fold-cloud-proxy-subscription-status-test-compile-break",
      title: "Fix subscription status compile break",
      column: "doing",
      repo: "EdgeVector/fold",
      base: "main",
      body:
        "Repo: EdgeVector/fold\nBase: main\n\nFix `cargo test --workspace --all-targets` so the forge check can go green.",
    });
    await addCmd({
      cfg,
      node,
      slug: "fold-ci-on-forge-required-checks",
      title: "Require forge required checks",
      column: "todo",
      repo: "EdgeVector/fold",
      base: "main",
      body: "Repo: EdgeVector/fold\nBase: main\n\nRequire `.forgejo/workflows/ci.yml` before merge.",
    });

    const second = await findCard(node, cfg, "fold-ci-on-forge-required-checks");
    expect(second?.tags).toContain("area:forge-ci");
    expect(second?.block_status).toBe("needs_human");
    expect(second?.block_reason).toContain(PICKUP_AREA_BLOCK_PREFIX);
    expect(second?.block_reason).toContain("fold-cloud-proxy-subscription-status-test-compile-break");
  });

  test("todo add scopes pickup-area peer reads to active columns and minimal fields", async () => {
    await addCmd({
      cfg,
      node,
      slug: "backlog-fbrain-list",
      title: "Backlog fbrain list work",
      column: "backlog",
      body: sharedAreaBody(),
    });
    await addCmd({
      cfg,
      node,
      slug: "done-fbrain-list",
      title: "Done fbrain list work",
      column: "done",
      body: sharedAreaBody(),
    });
    await addCmd({
      cfg,
      node,
      slug: "active-fbrain-list",
      title: "Active fbrain list work",
      column: "doing",
      body: sharedAreaBody(),
    });

    node.cardQueries.length = 0;
    await addCmd({
      cfg,
      node,
      slug: "todo-fbrain-list",
      title: "Todo fbrain list work",
      column: "todo",
      body: sharedAreaBody(),
    });

    const peerQueries = node.cardQueries.filter((q) => q.filter?.column !== undefined);
    expect(peerQueries.map((q) => q.filter!.column)).toEqual([...PICKUP_AREA_ACTIVE_COLUMNS]);
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(false);
    for (const q of peerQueries) {
      expect(q.fields).toEqual([...PICKUP_AREA_PEER_FIELDS]);
    }

    const todo = await findCard(node, cfg, "todo-fbrain-list");
    expect(todo?.block_status).toBe("needs_human");
    expect(todo?.block_reason).toContain(PICKUP_AREA_BLOCK_PREFIX);
    expect(todo?.block_reason).toContain("active-fbrain-list");
  });

  test("unsupported pickup column filters do not fall back to an unfiltered card scan", async () => {
    node = fakeNode({ rejectColumnFilter: true });
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    await addCmd({
      cfg,
      node,
      slug: "active-fbrain-list",
      title: "Active fbrain list work",
      column: "doing",
      body: sharedAreaBody(),
    });

    node.cardQueries.length = 0;
    await addCmd({
      cfg,
      node,
      slug: "todo-fbrain-list",
      title: "Todo fbrain list work",
      column: "todo",
      body: sharedAreaBody(),
    });

    expect(node.cardQueries.some((q) => q.filter?.column !== undefined)).toBe(true);
    expect(node.cardQueries.some((q) => q.filter === undefined)).toBe(false);
    const todo = await findCard(node, cfg, "todo-fbrain-list");
    expect(normalizeBlockStatus(todo!.block_status)).toBe("none");
  });

  test("add and move apply the same pickup-area overlap gate for todo-bound cards", async () => {
    await addCmd({
      cfg,
      node,
      slug: "active-fbrain-list",
      title: "Active fbrain list work",
      column: "doing",
      body: sharedAreaBody(),
    });

    await addCmd({
      cfg,
      node,
      slug: "todo-via-add",
      title: "Candidate fbrain list work",
      column: "todo",
      body: sharedAreaBody(),
    });
    await addCmd({
      cfg,
      node,
      slug: "todo-via-move",
      title: "Candidate fbrain list work",
      column: "backlog",
      body: sharedAreaBody(),
    });
    await moveCmd({ cfg, node, slug: "todo-via-move", column: "todo" });

    const viaAdd = await findCard(node, cfg, "todo-via-add");
    const viaMove = await findCard(node, cfg, "todo-via-move");
    for (const card of [viaAdd, viaMove]) {
      expect(card?.tags).toContain("area:fbrain-list");
      expect(card?.block_status).toBe("needs_human");
      expect(card?.block_reason).toContain(PICKUP_AREA_BLOCK_PREFIX);
      expect(card?.block_reason).toContain("active-fbrain-list");
    }
  });

  test("`add <slug> --block-status none` clears a hook-set overlap block and it stays cleared", async () => {
    // An unrelated ACTIVE card in the same repo+area, with NO dep edge, so the
    // hook legitimately blocks the second card on overlap.
    await addCmd({
      cfg,
      node,
      slug: "active-fbrain-list",
      title: "Active fbrain list work",
      column: "doing",
      body: sharedAreaBody(),
    });
    await addCmd({
      cfg,
      node,
      slug: "held-fbrain-list",
      title: "Held fbrain list work",
      column: "todo",
      body: sharedAreaBody(),
    });

    // Precondition: the hook set the overlap block (this is the papercut state).
    const before = await findCard(node, cfg, "held-fbrain-list");
    expect(before?.block_status).toBe("needs_human");
    expect(before?.block_reason).toContain(PICKUP_AREA_BLOCK_PREFIX);

    // The explicit human clear on this same write must be authoritative — even
    // though the body still cites the shared fbrain slug/command.
    await addCmd({
      cfg,
      node,
      slug: "held-fbrain-list",
      blockStatus: "none",
    });

    const after = await findCard(node, cfg, "held-fbrain-list");
    expect(normalizeBlockStatus(after!.block_status)).toBe("none");
    // The area tag is still present (tags are still derived) — only the block cleared.
    expect(after?.tags).toContain("area:fbrain-list");
  });
});
