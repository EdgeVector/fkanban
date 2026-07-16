import { beforeEach, describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { rmCmd } from "../src/commands/rm.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
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

async function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  await node.createRecord({
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

async function expectPolicyReject(p: Promise<unknown>): Promise<FkanbanError> {
  try {
    await p;
  } catch (err) {
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("default_todo_not_pickup_ready");
    return err as FkanbanError;
  }
  throw new Error("expected default/todo policy rejection");
}

const validBody = "Repo: EdgeVector/fkanban\nBase: main\n\nShip a concrete code change.";

describe("board policy invariants", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    await seedBoard(node, "human", [...DEFAULT_COLUMNS]);
  });

  test("default todo accepts pickup-ready PR cards, including tag-derived repo/base", async () => {
    await addCmd({ cfg, node, slug: "explicit-pr", column: "todo", body: validBody });
    const explicit = await findCard(node, cfg, "explicit-pr");
    expect(explicit?.repo).toBe("EdgeVector/fkanban");
    expect(explicit?.base).toBe("main");

    await addCmd({ cfg, node, slug: "tag-derived-pr", column: "todo", tags: ["fkanban"], body: "Use the local subsystem tag." });
    const derived = await findCard(node, cfg, "tag-derived-pr");
    expect(derived?.repo).toBe("EdgeVector/fkanban");
    expect(derived?.base).toBe("main");
    expect(derived?.body.startsWith("Repo: EdgeVector/fkanban\nBase: main\n\n")).toBe(true);
  });

  test("default todo rejects malformed or missing routing unless forced", async () => {
    const missing = await expectPolicyReject(addCmd({ cfg, node, slug: "missing-repo", column: "todo", body: "No route." }));
    expect(missing.message).toContain("Missing Repo");
    expect(await findCard(node, cfg, "missing-repo")).toBeNull();

    const dirty = await expectPolicyReject(
      addCmd({
        cfg,
        node,
        slug: "dirty-repo",
        column: "todo",
        body: "Repo: EdgeVector/fkanban  # stale note\nBase: main\n\nx",
      }),
    );
    expect(dirty.message).toContain("bare owner/name");
    expect(await findCard(node, cfg, "dirty-repo")).toBeNull();

    await addCmd({
      cfg,
      node,
      slug: "forced-dirty-repo",
      column: "todo",
      body: "Repo: EdgeVector/fkanban  # operator accepted cleanup\nBase: main\n\nx",
      force: true,
    });
    expect((await findCard(node, cfg, "forced-dirty-repo"))?.body).toBe("Repo: EdgeVector/fkanban\nBase: main\n\nx");
  });

  test("default todo rejects non-pickup and human-gated cards", async () => {
    for (const kind of ["tracker", "program", "capstone", "validation"]) {
      const err = await expectPolicyReject(addCmd({ cfg, node, slug: `${kind}-card`, column: "todo", kind, body: validBody }));
      expect(err.message).toContain("non-pickup");

      await addCmd({ cfg, node, slug: `${kind}-backlog`, column: "backlog", kind, body: validBody });
      expect((await findCard(node, cfg, `${kind}-backlog`))?.column).toBe("backlog");
    }

    const held = await expectPolicyReject(
      addCmd({ cfg, node, slug: "needs-human", column: "todo", body: validBody, blockStatus: "needs_human" }),
    );
    expect(held.message).toContain("block_status=needs_human");

    await addCmd({
      cfg,
      node,
      slug: "parked-human",
      board: "human",
      column: "todo",
      blockStatus: "needs_human",
      blockReason: "waiting on operator decision",
      body: "Visible parking card.",
    });
    expect((await findCard(node, cfg, "parked-human"))?.board).toBe("human");
  });

  test("explicit --kind pr wins over registry keyword inference in default/todo", async () => {
    // A concrete PR card whose body trips the registry-card keyword classifier
    // (contains "dogfood-registry"). Without --kind it is classified registry
    // and blocked; with an explicit --kind pr the classifier must NOT override
    // the filer's intent, and the card lands in todo.
    const registryKeywordBody =
      "Repo: EdgeVector/fkanban\nBase: main\n\nRotate the dogfood-registry entries via a code change.";

    // Explicit --kind pr → accepted into todo, no --force.
    await addCmd({ cfg, node, slug: "explicit-pr-registry-kw", column: "todo", kind: "pr", body: registryKeywordBody });
    const accepted = await findCard(node, cfg, "explicit-pr-registry-kw");
    expect(accepted?.column).toBe("todo");
    expect(accepted?.kind).toBe("pr");
    // Explicit pr also lets repo/base still derive rather than being skipped.
    expect(accepted?.repo).toBe("EdgeVector/fkanban");
    expect(accepted?.base).toBe("main");

    // Same body WITHOUT --kind → classified registry and blocked; the error must
    // never name the self-contradictory "kind=pr".
    const rejected = await expectPolicyReject(
      addCmd({ cfg, node, slug: "inferred-registry-kw", column: "todo", body: registryKeywordBody }),
    );
    expect(rejected.message).not.toContain("kind=pr");
    expect(rejected.message.toLowerCase()).toContain("registry");
    expect(await findCard(node, cfg, "inferred-registry-kw")).toBeNull();

    // And it is accepted into backlog, stamped kind=registry.
    await addCmd({ cfg, node, slug: "inferred-registry-kw-backlog", column: "backlog", body: registryKeywordBody });
    expect((await findCard(node, cfg, "inferred-registry-kw-backlog"))?.kind).toBe("registry");
  });

  test("move into default todo enforces the same pickup-ready contract", async () => {
    await addCmd({ cfg, node, slug: "parked-malformed", column: "backlog", body: "Not routable yet." });
    await expectPolicyReject(moveCmd({ cfg, node, slug: "parked-malformed", column: "todo" }));
    expect((await findCard(node, cfg, "parked-malformed"))?.column).toBe("backlog");

    await addCmd({ cfg, node, slug: "parked-valid", column: "backlog", body: validBody });
    await moveCmd({ cfg, node, slug: "parked-valid", column: "todo" });
    expect((await findCard(node, cfg, "parked-valid"))?.column).toBe("todo");
  });

  test("cross-board dependencies block working columns until terminal and cannot be tombstoned", async () => {
    await addCmd({
      cfg,
      node,
      slug: "human-approval",
      board: "human",
      column: "todo",
      blockStatus: "needs_human",
      blockReason: "Tom must approve the production action",
      body: "Human gate.",
    });
    // Unfinished deps belong in backlog (default/todo is dep-gated for pickup).
    await addCmd({ cfg, node, slug: "implementation", column: "backlog", body: validBody, deps: ["human-approval"] });

    await expect(moveCmd({ cfg, node, slug: "implementation", column: "todo" })).rejects.toBeInstanceOf(FkanbanError);
    await expect(moveCmd({ cfg, node, slug: "implementation", column: "doing" })).rejects.toBeInstanceOf(FkanbanError);
    await expect(rmCmd({ cfg, node, slug: "human-approval" })).rejects.toBeInstanceOf(FkanbanError);

    await moveCmd({ cfg, node, slug: "human-approval", column: "done" });
    await moveCmd({ cfg, node, slug: "implementation", column: "todo" });
    await moveCmd({ cfg, node, slug: "implementation", column: "doing" });
    expect((await findCard(node, cfg, "implementation"))?.column).toBe("doing");
  });

  test("moving a dependency to done promotes newly unblocked backlog PR dependents to todo", async () => {
    await addCmd({ cfg, node, slug: "api", column: "todo", body: validBody });
    await addCmd({ cfg, node, slug: "ui", column: "backlog", body: validBody, deps: ["api"] });

    const res = await moveCmd({ cfg, node, slug: "api", column: "done" });

    expect(res.promotedDependents).toEqual(["ui"]);
    expect((await findCard(node, cfg, "ui"))?.column).toBe("todo");
  });

  test("auto-promotion leaves still-blocked and non-pickup backlog dependents alone", async () => {
    await addCmd({ cfg, node, slug: "api", column: "todo", body: validBody });
    await addCmd({ cfg, node, slug: "design", column: "todo", body: validBody });
    await addCmd({ cfg, node, slug: "blocked-child", column: "backlog", body: validBody, deps: ["api", "design"] });
    await addCmd({
      cfg,
      node,
      slug: "tracker-child",
      column: "backlog",
      kind: "tracker",
      body: validBody,
      deps: ["api"],
    });
    await addCmd({
      cfg,
      node,
      slug: "held-child",
      column: "backlog",
      blockStatus: "deferred",
      blockReason: "wait for next milestone",
      body: validBody,
      deps: ["api"],
    });

    const res = await moveCmd({ cfg, node, slug: "api", column: "done" });

    expect(res.promotedDependents).toBeUndefined();
    expect((await findCard(node, cfg, "blocked-child"))?.column).toBe("backlog");
    expect((await findCard(node, cfg, "tracker-child"))?.column).toBe("backlog");
    expect((await findCard(node, cfg, "held-child"))?.column).toBe("backlog");
  });
});
