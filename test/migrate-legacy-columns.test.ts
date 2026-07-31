// Coverage for `fkanban migrate legacy-columns` — the repair for cards left on
// a column the board no longer defines.
//
// Columns became a FIXED set (backlog | todo | doing | done) on 2026-07-16 and
// `ensureColumn` has rejected anything else on the write path since. Cards
// written BEFORE that keep their old value; on the primary, 21 still hold
// `review`. No board view iterates such a column, so those cards are absent
// from `list` and `list --json` while `show <slug>` renders them fine.
//
// These drive the REAL `migrateLegacyColumnsCmd` against the in-memory fake
// NodeClient, seeding cards via a raw `updateRecord` so the write-path column
// validation is bypassed — exactly how the real board reached this state.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, findCard, nowIso, type Card } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { LEGACY_COLUMN_MAP, migrateLegacyColumnsCmd } from "../src/commands/migrate.ts";
import { formatMigrateLegacyColumns } from "../src/format.ts";

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
      ? t.has(filter.HashKey)
        ? [[filter.HashKey, t.get(filter.HashKey)!] as const]
        : []
      : [...t.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value),
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
      tableFor(schemaHash).set(keyHash, { ...tableFor(schemaHash).get(keyHash), ...fields });
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

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

// Seed a card row DIRECTLY, bypassing the add-time column validation — the
// only way to reproduce a pre-2026-07-16 off-column card.
function seedRawCard(node: NodeClient, card: Partial<Card> & { slug: string }): Promise<void> {
  const now = nowIso();
  const full: Card = {
    slug: card.slug,
    title: card.title ?? card.slug,
    body: card.body ?? "",
    board: card.board ?? "default",
    column: card.column ?? "todo",
    position: card.position ?? "m",
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
    kind: card.kind ?? "pr",
    block_status: card.block_status ?? "",
    block_reason: card.block_reason ?? "",
    north_star: card.north_star ?? "",
    pr_url: card.pr_url ?? "",
    branch: card.branch ?? "",
  };
  return node.updateRecord({
    schemaHash: cfg.schemaHashes.card!,
    keyHash: full.slug,
    fields: cardToFields(full),
  });
}

describe("fkanban migrate legacy-columns", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("review maps to doing — in-flight work, never an unverified done", () => {
    expect(LEGACY_COLUMN_MAP.review).toBe("doing");
  });

  test("moves an off-column card onto the fixed set", async () => {
    await seedRawCard(node, { slug: "old-review", column: "review" });
    const res = await migrateLegacyColumnsCmd({ cfg, node });

    expect(res.offColumn).toBe(1);
    expect(res.changed).toBe(1);
    expect(res.unmapped).toBe(0);
    expect(res.cards).toEqual([
      { slug: "old-review", board: "default", from: "review", to: "doing" },
    ]);
    expect((await findCard(node, cfg, "old-review"))?.column).toBe("doing");
  });

  test("a dry run reports the move and writes nothing", async () => {
    await seedRawCard(node, { slug: "old-review", column: "review" });
    const res = await migrateLegacyColumnsCmd({ cfg, node, dryRun: true });

    expect(res.offColumn).toBe(1);
    expect(res.changed).toBe(0);
    expect(res.dryRun).toBe(true);
    expect((await findCard(node, cfg, "old-review"))?.column).toBe("review");
  });

  test("cards already on a real column are left completely alone", async () => {
    await seedRawCard(node, { slug: "fine", column: "todo" });
    const res = await migrateLegacyColumnsCmd({ cfg, node });
    expect(res.offColumn).toBe(0);
    expect(res.cards).toEqual([]);
  });

  test("an unmapped column is reported, not guessed at", async () => {
    await seedRawCard(node, { slug: "weird", column: "triage" });
    const res = await migrateLegacyColumnsCmd({ cfg, node });

    expect(res.offColumn).toBe(1);
    expect(res.changed).toBe(0);
    expect(res.unmapped).toBe(1);
    expect(res.cards[0]?.to).toBeNull();
    // Left untouched on disk — a human decides where "triage" belongs.
    expect((await findCard(node, cfg, "weird"))?.column).toBe("triage");
  });

  test("preserves body, tags and position — only the column changes", async () => {
    await seedRawCard(node, {
      slug: "rich",
      column: "review",
      body: "## GOAL\nkeep me",
      tags: ["area:fkanban"],
      position: "1700000000000",
      repo: "EdgeVector/fkanban",
      north_star: "ns-board-integrity",
    });
    await migrateLegacyColumnsCmd({ cfg, node });

    const after = await findCard(node, cfg, "rich");
    expect(after?.column).toBe("doing");
    expect(after?.body).toBe("## GOAL\nkeep me");
    expect(after?.tags).toEqual(["area:fkanban"]);
    expect(after?.position).toBe("1700000000000");
    expect(after?.repo).toBe("EdgeVector/fkanban");
    expect(after?.north_star).toBe("ns-board-integrity");
  });

  test("--slug limits the migration to the named cards", async () => {
    await seedRawCard(node, { slug: "one", column: "review" });
    await seedRawCard(node, { slug: "two", column: "review" });
    const res = await migrateLegacyColumnsCmd({ cfg, node, slugs: ["one"] });

    expect(res.changed).toBe(1);
    expect((await findCard(node, cfg, "one"))?.column).toBe("doing");
    expect((await findCard(node, cfg, "two"))?.column).toBe("review");
  });

  test("is idempotent — a second run finds nothing to do", async () => {
    await seedRawCard(node, { slug: "old-review", column: "review" });
    await migrateLegacyColumnsCmd({ cfg, node });
    const again = await migrateLegacyColumnsCmd({ cfg, node });
    expect(again.offColumn).toBe(0);
    expect(again.changed).toBe(0);
  });

  test("formats a human report and a --json report", async () => {
    await seedRawCard(node, { slug: "old-review", column: "review" });
    const res = await migrateLegacyColumnsCmd({ cfg, node, dryRun: true });

    const human = formatMigrateLegacyColumns(res);
    expect(human).toContain("DRY RUN, no writes");
    expect(human).toContain("old-review (default) review → doing");

    expect(JSON.parse(formatMigrateLegacyColumns(res, true)).offColumn).toBe(1);
  });
});
