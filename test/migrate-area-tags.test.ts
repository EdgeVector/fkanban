// Regression / migration coverage for `fkanban migrate area-tags`
// (fkanban-migrate-stale-bogus-area-tags): a one-time board-wide re-derivation
// of pickup `area:*` tags that strips stale boilerplate tags minted by the
// pre-#130 prose-scraping bug on cards that were never re-written since.
//
// These drive the REAL `migrateAreaTagsCmd` against the in-memory fake
// NodeClient used across the add/mcp/overlap tests. Cards are seeded with
// stale `area:*` tags via a raw `updateRecord` (bypassing the add-time
// self-heal) to simulate the pre-fix board state the migration exists to fix.

import { beforeEach, describe, expect, test } from "bun:test";

import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  findCard,
  nowIso,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { migrateAreaTagsCmd } from "../src/commands/migrate.ts";
import { formatMigrateAreaTags } from "../src/format.ts";

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
  const rowsFor = (schemaHash: string, filter?: { HashKey: string }): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter
      ? t.has(filter.HashKey)
        ? [[filter.HashKey, t.get(filter.HashKey)!] as const]
        : []
      : [...t.entries()];
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

// Seed a card row DIRECTLY (no add-time self-heal), carrying whatever tags the
// test wants — including the stale boilerplate `area:*` tags the migration must
// strip. Returns nothing; read back with findCard.
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
    created_at: card.created_at ?? now,
    updated_at: card.updated_at ?? now,
    done_at: card.done_at ?? "",
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

describe("fkanban migrate area-tags", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("strips a stale boilerplate area tag whose body no longer derives it", async () => {
    // Body cites `fkanban agent` — `agent` is NOT a real fkanban command, so the
    // fixed derivation must NOT re-mint `area:fkanban-agent`. The tag is stale.
    await seedRawCard(node, {
      slug: "stale-card",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nAsk the fkanban agent to pick this up.",
      tags: ["p2", "area:fkanban-agent"],
    });

    const res = await migrateAreaTagsCmd({ cfg, node });
    expect(res.changed).toBe(1);
    expect(res.scanned).toBe(1);

    const after = await findCard(node, cfg, "stale-card");
    expect(after?.tags).not.toContain("area:fkanban-agent");
    // Non-area tags are preserved verbatim.
    expect(after?.tags).toContain("p2");
    // The delta is reported.
    expect(res.cards[0]?.removed).toContain("area:fkanban-agent");
  });

  test("preserves a legitimately-derivable area tag (no spurious rewrite)", async () => {
    // Body actually names `fkanban move` (a real command) → `area:fkanban-move`
    // is legitimately re-derived, so the card is unchanged and not rewritten.
    await seedRawCard(node, {
      slug: "real-card",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nUse `fkanban move` to advance it.",
      tags: ["p1", "area:fkanban-move"],
    });

    const res = await migrateAreaTagsCmd({ cfg, node });
    expect(res.changed).toBe(0);

    const after = await findCard(node, cfg, "real-card");
    expect(after?.tags).toContain("area:fkanban-move");
    expect(after?.tags).toContain("p1");
  });

  test("skips done/terminal-column cards (no pickup impact, don't churn them)", async () => {
    await seedRawCard(node, {
      slug: "done-card",
      column: "done",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nAsk the fkanban agent to pick this up.",
      tags: ["p2", "area:fkanban-agent"],
    });

    const res = await migrateAreaTagsCmd({ cfg, node });
    expect(res.skippedDone).toBe(1);
    expect(res.scanned).toBe(0);
    expect(res.changed).toBe(0);

    // The done card keeps its stale tag untouched — deliberately out of scope.
    const after = await findCard(node, cfg, "done-card");
    expect(after?.tags).toContain("area:fkanban-agent");
  });

  test("does not touch an intentional block hold on a card it retags", async () => {
    await seedRawCard(node, {
      slug: "held-card",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nAsk the fkanban agent to pick this up.",
      tags: ["p2", "area:fkanban-agent"],
      block_status: "design_first",
      block_reason: "waiting on a human design decision",
    });

    const res = await migrateAreaTagsCmd({ cfg, node });
    expect(res.changed).toBe(1);

    const after = await findCard(node, cfg, "held-card");
    // Stale area tag cleared…
    expect(after?.tags).not.toContain("area:fkanban-agent");
    // …but the human's block hold is preserved verbatim (STEP 2 scope guard).
    expect(after?.block_status).toBe("design_first");
    expect(after?.block_reason).toBe("waiting on a human design decision");
  });

  test("--dry-run reports deltas but writes nothing", async () => {
    await seedRawCard(node, {
      slug: "dry-card",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nAsk the fkanban agent to pick this up.",
      tags: ["p2", "area:fkanban-agent"],
    });

    const res = await migrateAreaTagsCmd({ cfg, node, dryRun: true });
    expect(res.dryRun).toBe(true);
    expect(res.changed).toBe(1);
    expect(res.cards[0]?.removed).toContain("area:fkanban-agent");

    // Nothing was written — the stale tag is still there.
    const after = await findCard(node, cfg, "dry-card");
    expect(after?.tags).toContain("area:fkanban-agent");
  });

  test("formatMigrateAreaTags renders a human summary + a JSON envelope", () => {
    const res = {
      scanned: 3,
      changed: 1,
      skippedDone: 2,
      dryRun: false,
      cards: [
        { slug: "c1", board: "default", column: "todo", removed: ["area:fkanban-agent"], added: [] },
      ],
    };
    const human = formatMigrateAreaTags(res, false);
    expect(human).toContain("1 of 3 active cards changed");
    expect(human).toContain("2 done/terminal skipped");
    expect(human).toContain("area:fkanban-agent");

    const json = JSON.parse(formatMigrateAreaTags(res, true));
    expect(json.changed).toBe(1);
    expect(json.cards[0].removed).toEqual(["area:fkanban-agent"]);
  });
});
