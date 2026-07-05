// Regression (fkanban-overlap-block-false-positive-dep-serialized): the pickup
// area-overlap checker must not fire between cards a `deps` edge already
// serializes, and an explicit `--block-status none` must survive the same write.
//
// These drive the REAL `addCmd` (the CLI's create/update entry) against the
// in-memory fake NodeClient used across the add/mcp tests — so they reproduce
// the papercut end-to-end through the command path, not just the pure helper.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  findCard,
  normalizeBlockStatus,
  nowIso,
  PICKUP_AREA_BLOCK_PREFIX,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";

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
    nodeTransport: () => ({ transport: "tcp" as const }),
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
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("two todo cards citing the same fbrain slug, B deps on A → neither is overlap-blocked", async () => {
    await addCmd({
      cfg,
      node,
      slug: "ddn-step-a",
      title: "Delete dev node — step A",
      column: "todo",
      body: sharedAreaBody(),
    });
    await addCmd({
      cfg,
      node,
      slug: "ddn-step-b",
      title: "Delete dev node — step B",
      column: "todo",
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
