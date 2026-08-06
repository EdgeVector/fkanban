// Every groom sweep must report the writes it MADE, never the writes it PLANNED.
//
// All three sweeps in `commands/groom.ts` used to state a `changed` count that
// no write ever incremented:
//
//   - `structured-routing` set `changed: repairs.length` regardless of --apply
//   - `stale-blockers`     incremented `changed` in the dry-run branch too
//   - `body-clobber-scan`  spliced the string "0 changed" into its head line,
//                          consulting no field at all
//
// Measured on the live board 2026-08-06 before the fix: `groom stale-blockers
// --json` returned `{"dryRun": true, "changed": 4}` having written nothing, and
// `last-stack-groom-board` copied exactly that number into its durable routine
// memory ("stale-blockers dry-run ... changed=3"). The rendered TEXT carried a
// "— DRY RUN, no writes" suffix, so a human reading the sentence got the truth
// while every --json consumer reading the field alone did not.
//
// The rule is `archive_done`'s: count the actions that occurred, and make the
// KEY NAME change with the meaning (`would_change=` vs `changed=`) so a reader
// cannot mistake a plan for a result.
import { beforeEach, describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  findCard,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import {
  groomBodyClobberScanResult,
  groomStaleBlockersResult,
  groomStructuredRoutingResult,
} from "../src/commands/groom.ts";

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
    let table = store.get(schemaHash);
    if (!table) {
      table = new Map();
      store.set(schemaHash, table);
    }
    return table;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter, wantedFields?: string[]): QueryRow[] => {
    const table = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? (table.has(filter.HashKey) ? [[filter.HashKey, table.get(filter.HashKey)!] as const] : [])
      : [...table.entries()].filter(([, fields]) =>
          !filter || Object.entries(filter).every(([field, value]) => fields[field] === value)
        );
    return entries.map(([hash, fields]) => ({
      fields: wantedFields
        ? Object.fromEntries(wantedFields.filter((field) => field in fields).map((field) => [field, fields[field]]))
        : fields,
      key: { hash, range: null },
    }));
  };
  const notImpl = (method: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${method} not implemented`);
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
    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter, fields);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "Repo: EdgeVector/fold\nBase: main\n\n## GOAL\nfixture\n\n## END STATE\ndone\n",
    board: "default",
    column: "todo",
    position: String(Date.now()),
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    kind: "pr",
    block_status: "none",
    ...partial,
  };
}

async function seedBoard(node: NodeClient, b: Board) {
  await node.createRecord({ schemaHash: cfg.schemaHashes.board!, keyHash: b.slug, fields: boardToFields(b) });
}

async function seedCard(node: NodeClient, c: Card) {
  await node.createRecord({ schemaHash: cfg.schemaHashes.card!, keyHash: c.slug, fields: cardToFields(c) });
}

/** A card `structured-routing` will repair: routable body, empty structured fields. */
function routableCard(slug: string): Card {
  return card({
    slug,
    repo: "",
    base: "",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nShip it.\n\n## END STATE\nDone.\n",
  });
}

/** A card `stale-blockers` will rewrite: malformed Repo header + generated BLOCKED prose. */
function staleBlockerCard(slug: string): Card {
  return card({
    slug,
    body:
      "Repo: EdgeVector/fkanban  # stale inline note\nBase: main\n\n" +
      "BLOCKED: fkanban-pickup cannot resolve Repo header.\nKeep this context.",
  });
}

describe("groom structured-routing counts", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board());
  });

  test("dry run reports changed=0 and would_change=N, and writes nothing", async () => {
    await seedCard(node, routableCard("a"));
    await seedCard(node, routableCard("b"));

    const { report } = await groomStructuredRoutingResult({ cfg, node });

    expect(report.dryRun).toBe(true);
    // The defect: this was `repairs.length`, i.e. 2, with zero writes issued.
    expect(report.changed).toBe(0);
    expect(report.would_change).toBe(2);

    // And the claim is true — the cards really are untouched.
    expect((await findCard(node, cfg, "a"))?.repo).toBe("");
    expect((await findCard(node, cfg, "b"))?.repo).toBe("");
  });

  test("apply reports changed=N counted at the write", async () => {
    await seedCard(node, routableCard("a"));
    await seedCard(node, routableCard("b"));

    const { report } = await groomStructuredRoutingResult({ cfg, node, apply: true });

    expect(report.dryRun).toBe(false);
    expect(report.changed).toBe(2);
    expect(report.would_change).toBe(2);
    expect((await findCard(node, cfg, "a"))?.repo).toBe("EdgeVector/fkanban");
  });

  test("head line names the number would_change on a dry run and changed on apply", async () => {
    await seedCard(node, routableCard("a"));

    const dry = await groomStructuredRoutingResult({ cfg, node });
    expect(dry.text).toContain("would_change=1");
    expect(dry.text).toContain("DRY RUN, no writes");
    // The pre-fix line read "1 changed — DRY RUN, no writes": a count and its own
    // contradiction in one sentence.
    expect(dry.text).not.toContain("changed=1");

    const applied = await groomStructuredRoutingResult({ cfg, node, apply: true });
    expect(applied.text).toContain("changed=1");
    expect(applied.text).not.toContain("would_change");
    expect(applied.text).not.toContain("DRY RUN");
  });
});

describe("groom stale-blockers counts", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, board());
  });

  test("dry run reports changed=0 and would_change=N, and writes nothing", async () => {
    await seedCard(node, staleBlockerCard("routing-fixed"));

    const { report } = await groomStaleBlockersResult({ cfg, node });

    expect(report.dryRun).toBe(true);
    // The live-board shape of the defect: dryRun true alongside changed: 4.
    expect(report.changed).toBe(0);
    expect(report.would_change).toBe(1);

    const after = await findCard(node, cfg, "routing-fixed");
    expect(after?.body).toContain("# stale inline note");
    expect(after?.body).toContain("BLOCKED:");
  });

  test("apply counts the write, not the plan", async () => {
    await seedCard(node, staleBlockerCard("routing-fixed"));

    const { report } = await groomStaleBlockersResult({ cfg, node, apply: true });

    expect(report.dryRun).toBe(false);
    expect(report.changed).toBe(1);
    expect(report.would_change).toBe(1);
    expect((await findCard(node, cfg, "routing-fixed"))?.body).not.toContain("BLOCKED:");
  });

  test("a card is marked 'would change' on a dry run and 'changed' on apply", async () => {
    await seedCard(node, staleBlockerCard("routing-fixed"));

    const dry = await groomStaleBlockersResult({ cfg, node });
    expect(dry.text).toContain("would change");

    const applied = await groomStaleBlockersResult({ cfg, node, apply: true });
    expect(applied.text).not.toContain("would change");
  });
});

describe("groom body-clobber-scan counts", () => {
  test("the head count comes from the report, not from a hard-coded string", async () => {
    const node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({
      slug: "clobbered",
      body: "#!/usr/bin/env bash\nset -euo pipefail\necho generated\n",
    }));

    const { text, report } = await groomBodyClobberScanResult({ cfg, node });

    // A scan that cannot write must say so with a field, so that adding an
    // --apply mode is a type error rather than a silently stale sentence.
    expect(report.changed).toBe(0);
    expect(report.would_change).toBe(0);
    expect(text).toContain("would_change=0");
    // Pre-fix this line was the literal "0 changed - DRY RUN, no writes".
    expect(text).not.toContain("0 changed");
  });
});

describe("the sweeps stay quiet when there is nothing to do", () => {
  // Behaviour pin, not coverage: asserted against the RENDERED TEXT and
  // `candidates` only — both of which mean the same thing before and after this
  // change — so it PASSES against the pre-fix code by design. A converged board
  // must not start reporting phantom work, and a gate that fires on a healthy
  // run is muted within a week. If a later refactor makes this one fail, the
  // regression is "the fix is no longer inert", which is a different bug from
  // the ones the tests above cover.
  test("a clean board reports no candidates and marks no card", async () => {
    const node = fakeNode();
    await seedBoard(node, board());
    await seedCard(node, card({ slug: "healthy", repo: "EdgeVector/fold", base: "main" }));

    const routing = await groomStructuredRoutingResult({ cfg, node });
    expect(routing.report.candidates).toBe(0);
    expect(routing.report.changed).toBe(0);
    expect(routing.text).toContain("0 candidate cards");

    const blockers = await groomStaleBlockersResult({ cfg, node });
    expect(blockers.report.changed).toBe(0);
    expect(blockers.text).not.toContain("would change");
    expect(blockers.text).not.toContain("healthy");
  });
});
