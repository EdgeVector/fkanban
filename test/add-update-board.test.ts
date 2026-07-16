// Regression: `add` doubles as create AND update. Updating a card (e.g. just
// the title/priority) must NOT silently move it to the `default` board OR to a
// different column. The board bug forced `board = opts.board ?? "default"`,
// clobbering a card that lived on a non-default board to `default` (silent
// data-integrity loss), and validated `--column` against the wrong board's
// columns. The column bug let a metadata-only update behave like a fresh create
// instead of preserving the existing card's column. The fix resolves the
// existing card BEFORE the board/column context: `opts.board ?? existing?.board
// ?? "default"` and `opts.column ?? existing?.column ?? firstColumn`. Explicit
// `--board` / `--column` still move the card; the create path is unchanged.
//
// Backed by the same in-memory fake NodeClient used in mcp.test.ts /
// read-board-validation.test.ts — exercises the real addCmd with no live node.

import { beforeEach, describe, expect, test } from "bun:test";
import { PassThrough } from "node:stream";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { markCmd } from "../src/commands/mark.ts";
import { depAddCmd } from "../src/commands/dep.ts";
import { showCmd } from "../src/commands/show.ts";
import { readStdinBodyForAdd } from "../src/cli.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const validPickupBody = "Repo: EdgeVector/fkanban\nBase: main\n\nTest fixture work.";

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

describe("add update preserves the card's board", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    // A board with a custom column set, to also catch column mis-validation.
    await seedBoard(node, "other", ["icebox", "wip", "shipped"]);
  });

  test("(a) update with NO --board keeps the card on its non-default board", async () => {
    const created = await addCmd({
      cfg,
      node,
      slug: "probe",
      title: "probe v1",
      board: "other",
      column: "wip",
    });
    expect(created).toMatchObject({ action: "created", board: "other", column: "wip" });

    // Edit just the title, no --board — must NOT teleport to "default".
    const updated = await addCmd({ cfg, node, slug: "probe", title: "probe v2 EDITED" });
    expect(updated).toMatchObject({ action: "updated", board: "other", column: "wip" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("other");
    expect(after?.title).toBe("probe v2 EDITED");
    expect(after?.column).toBe("wip");
  });

  test("(a') priority-only update with NO --column keeps the card in its current column", async () => {
    await addCmd({
      cfg,
      node,
      slug: "priority-only",
      title: "Priority only",
      column: "todo",
      body: validPickupBody,
    });

    const updated = await addCmd({ cfg, node, slug: "priority-only", priority: "P2" });
    expect(updated).toMatchObject({ action: "updated", board: "default", column: "todo" });

    const after = await findCard(node, cfg, "priority-only");
    expect(after?.column).toBe("todo");
    expect(after?.tags).toContain("p2");
  });

  test("dep add on a todo card demotes it to backlog (pickup lane stays clean)", async () => {
    await addCmd({
      cfg,
      node,
      slug: "dependency",
      title: "Dependency",
      column: "todo",
      body: validPickupBody,
    });
    await addCmd({
      cfg,
      node,
      slug: "blocked-dependent",
      title: "Blocked dependent",
      column: "todo",
      body: validPickupBody,
    });
    await depAddCmd({ cfg, node, slug: "blocked-dependent", dep: "dependency" });

    const afterDep = await findCard(node, cfg, "blocked-dependent");
    expect(afterDep?.column).toBe("backlog");
    expect(afterDep?.deps).toEqual(["dependency"]);

    const updated = await addCmd({
      cfg,
      node,
      slug: "blocked-dependent",
      northStar: "north-star-test",
    });
    expect(updated).toMatchObject({ action: "updated", board: "default", column: "backlog" });

    const after = await findCard(node, cfg, "blocked-dependent");
    expect(after?.column).toBe("backlog");
    expect(after?.deps).toEqual(["dependency"]);
    expect(after?.north_star).toBe("north-star-test");
  });

  test("add --surfaces writes claims and preserves them when omitted on update", async () => {
    await addCmd({
      cfg,
      node,
      slug: "surface-card",
      title: "Surface card",
      column: "todo",
      body: validPickupBody,
      surfaces: ["src/cli.ts", "src/mcp/**"],
    });
    const created = await findCard(node, cfg, "surface-card");
    expect(created?.surfaces).toEqual(["src/cli.ts", "src/mcp/**"]);

    await addCmd({ cfg, node, slug: "surface-card", title: "Renamed" });
    const updated = await findCard(node, cfg, "surface-card");
    expect(updated?.title).toBe("Renamed");
    expect(updated?.surfaces).toEqual(["src/cli.ts", "src/mcp/**"]);
  });

  test("create derives structured tags from a body Tags header", async () => {
    await addCmd({
      cfg,
      node,
      slug: "body-tags",
      title: "Body tags",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\nTags: cli, metadata pickup cli\n\nTest fixture work.",
    });

    const created = await findCard(node, cfg, "body-tags");
    expect(created?.tags).toEqual(expect.arrayContaining(["cli", "metadata", "pickup"]));
    expect(created?.tags.filter((tag) => tag === "cli")).toHaveLength(1);
  });

  test("explicit --tags wins over a body Tags header", async () => {
    await addCmd({
      cfg,
      node,
      slug: "explicit-tags",
      title: "Explicit tags",
      column: "todo",
      tags: ["explicit"],
      body: "Repo: EdgeVector/fkanban\nBase: main\nTags: body-only\n\nTest fixture work.",
    });

    const created = await findCard(node, cfg, "explicit-tags");
    expect(created?.tags).toContain("explicit");
    expect(created?.tags).not.toContain("body-only");
  });

  test("fenced Tags examples are ignored on create", async () => {
    await addCmd({
      cfg,
      node,
      slug: "fenced-tags",
      title: "Fenced tags",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\n```\nTags: example-only\n```\n\nTest fixture work.",
    });

    const created = await findCard(node, cfg, "fenced-tags");
    expect(created?.tags).not.toContain("example-only");
  });

  test("update with no explicit tags preserves existing structured tags", async () => {
    await addCmd({
      cfg,
      node,
      slug: "preserve-tags",
      title: "Preserve tags",
      column: "todo",
      tags: ["existing"],
      body: validPickupBody,
    });

    await addCmd({
      cfg,
      node,
      slug: "preserve-tags",
      body: "Repo: EdgeVector/fkanban\nBase: main\nTags: replacement\n\nUpdated body.",
    });

    const updated = await findCard(node, cfg, "preserve-tags");
    expect(updated?.tags).toContain("existing");
    expect(updated?.tags).not.toContain("replacement");
  });

  test("add derives structured branch from a body Branch header outside todo", async () => {
    await addCmd({
      cfg,
      node,
      slug: "branch-card",
      title: "Branch card",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\nBranch: kanban/body-branch\n\nTest fixture work.",
    });

    const created = await findCard(node, cfg, "branch-card");
    expect(created?.branch).toBe("kanban/body-branch");
  });

  test("explicit --branch wins over the body Branch header", async () => {
    await addCmd({
      cfg,
      node,
      slug: "explicit-branch-card",
      title: "Explicit branch card",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\nBranch: kanban/body-branch\n\nTest fixture work.",
      branch: "kanban/explicit-branch",
    });

    const created = await findCard(node, cfg, "explicit-branch-card");
    expect(created?.branch).toBe("kanban/explicit-branch");
  });

  test("fenced Branch examples do not populate structured branch", async () => {
    await addCmd({
      cfg,
      node,
      slug: "fenced-branch-card",
      title: "Fenced branch card",
      column: "doing",
      body:
        "Repo: EdgeVector/fkanban\nBase: main\n```text\nBranch: kanban/example-only\n```\n\nTest fixture work.",
    });

    const created = await findCard(node, cfg, "fenced-branch-card");
    expect(created?.branch).toBe("");
  });

  test("body-only updates preserve an existing structured branch", async () => {
    await addCmd({
      cfg,
      node,
      slug: "preserve-branch-card",
      title: "Preserve branch card",
      column: "doing",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nTest fixture work.",
      branch: "kanban/existing-branch",
    });

    await addCmd({
      cfg,
      node,
      slug: "preserve-branch-card",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nUpdated fixture work.",
    });

    const updatedBranch = await findCard(node, cfg, "preserve-branch-card");
    expect(updatedBranch?.branch).toBe("kanban/existing-branch");
  });

  test("add with a DB locator stamps the home DB field and body header", async () => {
    await addCmd({
      cfg,
      node,
      slug: "db-card",
      title: "DB card",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nTest fixture work.",
      dbLocator: "lastdb://org/edgevector/company",
    });

    const created = await findCard(node, cfg, "db-card");
    expect(created?.db).toBe("lastdb://org/edgevector/company");
    expect(created?.body.startsWith("Db: lastdb://org/edgevector/company\n")).toBe(true);

    await addCmd({ cfg, node, slug: "db-card", title: "Renamed", dbLocator: "lastdb://org/edgevector/company" });
    const updated = await findCard(node, cfg, "db-card");
    expect(updated?.title).toBe("Renamed");
    expect(updated?.db).toBe("lastdb://org/edgevector/company");
    expect((updated?.body.match(/^Db:/gm) ?? [])).toHaveLength(1);
  });

  test("add refuses to update a card through the wrong ambient DB", async () => {
    await addCmd({
      cfg,
      node,
      slug: "db-mismatch",
      title: "DB mismatch",
      column: "todo",
      body: validPickupBody,
      dbLocator: "lastdb://personal",
    });

    await expect(
      addCmd({
        cfg,
        node,
        slug: "db-mismatch",
        title: "Wrong DB",
        dbLocator: "lastdb://org/edgevector/company",
      }),
    ).rejects.toMatchObject({ code: "db_locator_mismatch" });
  });

  test("(b) update --column valid on the card's OWN board succeeds", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip", body: validPickupBody });

    // "shipped" is a column on "other" but NOT on the default board. Before the
    // fix this validated against the default board's columns and would throw.
    const updated = await addCmd({ cfg, node, slug: "probe", column: "shipped" });
    expect(updated).toMatchObject({ action: "updated", board: "other", column: "shipped" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("other");
    expect(after?.column).toBe("shipped");
  });

  test("(b') update --column invalid on the card's own board is rejected", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip" });
    // "todo" is a default-board column but not on "other".
    expect(addCmd({ cfg, node, slug: "probe", column: "todo" })).rejects.toBeInstanceOf(FkanbanError);
  });

  test("(c) explicit --board still moves the card (intended)", async () => {
    await addCmd({ cfg, node, slug: "probe", board: "other", column: "wip", body: validPickupBody });

    const moved = await addCmd({ cfg, node, slug: "probe", board: "default", column: "todo" });
    expect(moved).toMatchObject({ action: "updated", board: "default", column: "todo" });

    const after = await findCard(node, cfg, "probe");
    expect(after?.board).toBe("default");
    expect(after?.column).toBe("todo");
  });

  test("(d) create path unchanged: defaults to the default board, then its first column", async () => {
    const created = await addCmd({ cfg, node, slug: "fresh", title: "Fresh" });
    expect(created).toMatchObject({
      action: "created",
      board: "default",
      column: DEFAULT_COLUMNS[0],
    });

    const after = await findCard(node, cfg, "fresh");
    expect(after?.board).toBe("default");
    expect(after?.column).toBe(DEFAULT_COLUMNS[0]);
  });

  test("(d') create with explicit --board honors it", async () => {
    const created = await addCmd({ cfg, node, slug: "fresh2", board: "other", column: "icebox" });
    expect(created).toMatchObject({ action: "created", board: "other", column: "icebox" });
  });

  test("add/show round-trip persists a sanitized dirty Repo header only with explicit force", async () => {
    await expect(addCmd({
      cfg,
      node,
      slug: "dirty-repo",
      title: "Dirty repo",
      column: "todo",
      body: "Repo: EdgeVector/fold  # defaulted — no subsystem tag mapped; correct the Repo: line if wrong\nBase: main\n\nx",
    })).rejects.toBeInstanceOf(FkanbanError);

    await addCmd({
      cfg,
      node,
      slug: "dirty-repo",
      title: "Dirty repo",
      column: "todo",
      body: "Repo: EdgeVector/fold  # defaulted — no subsystem tag mapped; correct the Repo: line if wrong\nBase: main\n\nx",
      force: true,
    });

    const shown = JSON.parse(await showCmd({ cfg, node, slug: "dirty-repo", json: true }));
    expect(shown.body).toBe("Repo: EdgeVector/fold\nBase: main\n\nx");
    expect(shown.repo).toBe("EdgeVector/fold");
    expect(shown.base).toBe("main");
  });
});

describe("add stdin body replacement", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  async function readPipe(body: string, delayMs = 0): Promise<string> {
    const stream = new PassThrough();
    setTimeout(() => stream.end(body), delayMs);
    const read = await readStdinBodyForAdd(stream as unknown as NodeJS.ReadStream, {} as NodeJS.ProcessEnv);
    expect(read).toBe(body);
    return read!;
  }

  test("create-via-stdin persists the piped body exactly", async () => {
    const body = await readPipe("Repo: EdgeVector/fkanban\nBase: main\n\nCreated from stdin.\n", 25);
    const created = await addCmd({ cfg, node, slug: "stdin-create", column: "todo", body });
    expect(created).toMatchObject({ action: "created" });
    expect((await findCard(node, cfg, "stdin-create"))?.body).toBe(body);
  });

  test("update-via-stdin replaces the existing body exactly", async () => {
    await addCmd({
      cfg,
      node,
      slug: "stdin-update",
      column: "todo",
      body: "Repo: EdgeVector/fkanban\nBase: main\n\nOld body.\n",
    });

    const body = await readPipe("Repo: EdgeVector/fkanban\nBase: main\n\nUpdated from stdin.\n\n", 350);
    const updated = await addCmd({ cfg, node, slug: "stdin-update", body });
    expect(updated).toMatchObject({ action: "updated" });
    expect((await findCard(node, cfg, "stdin-update"))?.body).toBe(body);
  });

  test("silent never-EOF stdin is rejected instead of treated as an empty body", async () => {
    const stream = new PassThrough();
    try {
      await expect(
        readStdinBodyForAdd(
          stream as unknown as NodeJS.ReadStream,
          { FKANBAN_STDIN_IDLE_MS: "20" } as NodeJS.ProcessEnv,
        ),
      ).rejects.toMatchObject({ code: "stdin_body_unavailable" });
    } finally {
      stream.destroy();
    }
  });
});

describe("mark command and add --body slug-list tripwire", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("mark appends once and preserves card metadata", async () => {
    const originalBody = "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nKeep this intact.\n\n## STEPS\nAlso intact.";
    await addCmd({
      cfg,
      node,
      slug: "mark-target",
      title: "Mark target",
      column: "todo",
      tags: ["fkanban", "p1"],
      kind: "pr",
      body: originalBody,
    });

    await markCmd({ cfg, node, slug: "mark-target", line: "NEEDS-HUMAN: x" });
    await markCmd({ cfg, node, slug: "mark-target", line: "NEEDS-HUMAN: x" });

    const after = await findCard(node, cfg, "mark-target");
    expect(after?.body.startsWith(originalBody)).toBe(true);
    expect(after?.body.match(/^NEEDS-HUMAN: x$/gm)?.length).toBe(1);
    expect(after?.body).toContain("## GOAL\nKeep this intact.");
    expect(after?.body).toContain("## STEPS\nAlso intact.");
    expect(after?.column).toBe("todo");
    expect(after?.tags).toEqual(["fkanban", "p1"]);
    expect(after?.kind).toBe("pr");
  });

  test("add --body rejects a body made only of existing card slugs", async () => {
    await addCmd({ cfg, node, slug: "slug-one", column: "todo", body: validPickupBody });
    await addCmd({ cfg, node, slug: "slug-two", column: "todo", body: validPickupBody });

    await expect(
      addCmd({ cfg, node, slug: "victim", body: "slug-one\nslug-two" }),
    ).rejects.toMatchObject({ code: "body_slug_list_tripwire" });
  });
});

// `add --deps` must reject a dep slug that doesn't resolve to a live card.
// Dependencies are canonical structured edges, not free-text/body hints, so an
// unresolved slug is almost always an agent typo and must not be persisted.
describe("add --deps rejects missing dependency slugs", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("missing dep → rejects and writes nothing", async () => {
    await expect(addCmd({ cfg, node, slug: "dep-a", title: "A", deps: ["does-not-exist"] })).rejects.toMatchObject({
      code: "missing_dependency",
      message: 'Dependency card "does-not-exist" does not exist.',
    });
    expect(await findCard(node, cfg, "dep-a")).toBeNull();
  });

  test("existing dep → accepted", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    await addCmd({ cfg, node, slug: "dep-b", title: "B", deps: ["dep-target"] });
    expect((await findCard(node, cfg, "dep-b"))?.deps).toEqual(["dep-target"]);
  });

  test("mixed deps → rejects on the missing one and writes no partial edge", async () => {
    await addCmd({ cfg, node, slug: "dep-ok", title: "OK" });
    await expect(addCmd({ cfg, node, slug: "dep-c", title: "C", deps: ["dep-ok", "dep-missing"] })).rejects.toMatchObject({
      code: "missing_dependency",
      message: 'Dependency card "dep-missing" does not exist.',
    });
    expect(await findCard(node, cfg, "dep-c")).toBeNull();
  });

  test("no --deps → no dependency validation needed", async () => {
    await addCmd({ cfg, node, slug: "dep-d", title: "D" });
    expect((await findCard(node, cfg, "dep-d"))?.deps).toEqual([]);
  });

  test("generic update without deps preserves an existing dependency edge", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", deps: ["dep-target"] });

    const updated = await addCmd({ cfg, node, slug: "dependent", title: "Dependent v2" });
    expect(updated).toMatchObject({ action: "updated" });
    const after = await findCard(node, cfg, "dependent");
    expect(after?.title).toBe("Dependent v2");
    expect(after?.deps).toEqual(["dep-target"]);
  });

  test("generic update with deps: [] cannot silently clear an existing edge", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", deps: ["dep-target"] });

    await expect(addCmd({ cfg, node, slug: "dependent", deps: [] })).rejects.toMatchObject({
      code: "deps_replace_requires_explicit",
    });
    const after = await findCard(node, cfg, "dependent");
    expect(after?.deps).toEqual(["dep-target"]);
  });

  test("clearing deps requires replaceDeps", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", deps: ["dep-target"] });

    const cleared = await addCmd({ cfg, node, slug: "dependent", deps: [], replaceDeps: true });
    expect(cleared).toMatchObject({ action: "updated" });
    expect((await findCard(node, cfg, "dependent"))?.deps).toEqual([]);
  });

  test("replacing deps requires replaceDeps", async () => {
    await addCmd({ cfg, node, slug: "dep-a", title: "A" });
    await addCmd({ cfg, node, slug: "dep-b", title: "B" });
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", deps: ["dep-a"] });

    await expect(addCmd({ cfg, node, slug: "dependent", deps: ["dep-b"] })).rejects.toMatchObject({
      code: "deps_replace_requires_explicit",
    });
    const replaced = await addCmd({ cfg, node, slug: "dependent", deps: ["dep-b"], replaceDeps: true });
    expect(replaced).toMatchObject({ action: "updated" });
    expect((await findCard(node, cfg, "dependent"))?.deps).toEqual(["dep-b"]);
  });

  test("re-sending the same deps on update is idempotent without replaceDeps", async () => {
    await addCmd({ cfg, node, slug: "dep-target", title: "Target" });
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", deps: ["dep-target"] });

    const updated = await addCmd({ cfg, node, slug: "dependent", title: "Dependent v2", deps: ["dep-target"] });
    expect(updated).toMatchObject({ action: "updated" });
    expect((await findCard(node, cfg, "dependent"))?.deps).toEqual(["dep-target"]);
  });
});

// `add --deps` must refuse to close a dependency cycle, exactly like `dep add`
// (#38). The guard lives in `prepareDeps` (shared by the CLI + the MCP
// `fkanban_add` tool), throws `dep_cycle` BEFORE any write (no partial card),
// and only checks edges that are NEW relative to the card's existing deps.
describe("add --deps rejects a dependency cycle", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  async function expectCycle(promise: Promise<unknown>): Promise<void> {
    await expect(promise).rejects.toMatchObject({ code: "dep_cycle" });
  }

  test("direct mutual edge (a→b then add b --deps a) is rejected, nothing written", async () => {
    // a depends on b.
    await addCmd({ cfg, node, slug: "b", title: "B" });
    await addCmd({ cfg, node, slug: "a", title: "A", deps: ["b"] });
    // Now b --deps a would close a 2-cycle.
    await expectCycle(addCmd({ cfg, node, slug: "b", deps: ["a"] }));
    // No edge written: b still has no deps.
    const after = await findCard(node, cfg, "b");
    expect(after?.deps).toEqual([]);
  });

  test("transitive cycle (a→b→c then add c --deps a) is rejected", async () => {
    await addCmd({ cfg, node, slug: "c", title: "C" });
    await addCmd({ cfg, node, slug: "b", title: "B", deps: ["c"] });
    await addCmd({ cfg, node, slug: "a", title: "A", deps: ["b"] });
    await expectCycle(addCmd({ cfg, node, slug: "c", deps: ["a"] }));
    const after = await findCard(node, cfg, "c");
    expect(after?.deps).toEqual([]);
  });

  test("error message + hint are byte-aligned with `dep add`", async () => {
    await addCmd({ cfg, node, slug: "b", title: "B" });
    await addCmd({ cfg, node, slug: "a", title: "A", deps: ["b"] });
    try {
      await addCmd({ cfg, node, slug: "b", deps: ["a"] });
      throw new Error("expected addCmd to throw a dep_cycle error");
    } catch (err) {
      expect(err).toBeInstanceOf(FkanbanError);
      const e = err as FkanbanError;
      expect(e.code).toBe("dep_cycle");
      expect(e.message).toBe('Adding "b" → "a" would create a dependency cycle.');
      expect(e.hint).toBe("Cycle: a → b → a (no edge written).");
    }
  });

  test("a valid DAG edge is still accepted", async () => {
    await addCmd({ cfg, node, slug: "a", title: "A" });
    await addCmd({ cfg, node, slug: "b", title: "B", deps: ["a"] });
    // c → a and c → b are both fine (no cycle).
    const res = await addCmd({ cfg, node, slug: "c", title: "C", deps: ["a", "b"] });
    expect(res).toMatchObject({ action: "created" });
    const after = await findCard(node, cfg, "c");
    expect(after?.deps).toEqual(["a", "b"]);
  });

  test("re-adding a card with an already-present dep does NOT falsely trip the guard", async () => {
    // a → b exists; b → a is the only cycle edge. Re-`add` a with its EXISTING
    // dep b plus a title change must not re-check b (b→a not present, so a→b is
    // fine anyway) — but more importantly, an already-present edge is skipped.
    await addCmd({ cfg, node, slug: "b", title: "B" });
    await addCmd({ cfg, node, slug: "a", title: "A", deps: ["b"] });
    // Re-add a with the same dep — should succeed (idempotent), no cycle.
    const res = await addCmd({ cfg, node, slug: "a", title: "A v2", deps: ["b"] });
    expect(res).toMatchObject({ action: "updated" });
    const after = await findCard(node, cfg, "a");
    expect(after?.deps).toEqual(["b"]);
  });

  test("cumulative: --deps adds two edges where the SECOND closes a cycle", async () => {
    // x → y exists. add y --deps z,x : z is fine, but x closes y→x→y.
    await addCmd({ cfg, node, slug: "y", title: "Y" });
    await addCmd({ cfg, node, slug: "x", title: "X", deps: ["y"] });
    await addCmd({ cfg, node, slug: "z", title: "Z" });
    await addCmd({ cfg, node, slug: "x", title: "X", deps: ["y"] });
    await expectCycle(addCmd({ cfg, node, slug: "y", deps: ["z", "x"] }));
    // Nothing written — y still has no deps.
    const after = await findCard(node, cfg, "y");
    expect(after?.deps).toEqual([]);
  });
});

// `add` doubles as a column-changing command (create+update), so it must
// enforce the SAME dependency soft-block `move` does: a card blocked by an
// unfinished dep cannot be placed into a working column (doing/review/done)
// OR default/todo (the pickup claim lane) unless `--force`. The guard throws
// `card_blocked` BEFORE any write (no partial state) with the message/hint
// byte-aligned with move's. Backlog placements remain allowed.
describe("add enforces the dependency soft-block into working columns", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  // Seed `dep` (todo, not done) and `blk` (backlog) depending on it — blk is blocked.
  async function seedBlocked(): Promise<void> {
    await addCmd({ cfg, node, slug: "dep", title: "Dep", column: "todo", body: validPickupBody });
    await addCmd({
      cfg,
      node,
      slug: "blk",
      title: "Blocked",
      column: "backlog",
      body: validPickupBody,
      deps: ["dep"],
    });
  }

  test("update a blocked card into `doing` is refused (card_blocked, no write)", async () => {
    await seedBlocked();
    await expect(addCmd({ cfg, node, slug: "blk", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    // Card did not move.
    const after = await findCard(node, cfg, "blk");
    expect(after?.column).toBe("backlog");
  });

  test("error message + hint are byte-aligned with `move`", async () => {
    await seedBlocked();
    try {
      await addCmd({ cfg, node, slug: "blk", column: "doing" });
      throw new Error("expected addCmd to throw a card_blocked error");
    } catch (err) {
      expect(err).toBeInstanceOf(FkanbanError);
      const e = err as FkanbanError;
      expect(e.code).toBe("card_blocked");
      expect(e.message).toBe('Card "blk" is blocked by "dep" (not yet done).');
      expect(e.hint).toBe(
        "Finish its dependencies first (move them to their board's final column), keep the dependent in default/backlog until then, or pass --force to override.",
      );
    }
  });

  test("--force overrides the block and the update lands", async () => {
    await seedBlocked();
    const res = await addCmd({ cfg, node, slug: "blk", column: "doing", force: true });
    expect(res).toMatchObject({ action: "updated", column: "doing" });
    const after = await findCard(node, cfg, "blk");
    expect(after?.column).toBe("doing");
  });

  test("an UNblocked card moves into `doing` via add (no guard fires)", async () => {
    await addCmd({ cfg, node, slug: "dep", title: "Dep", column: "done", body: validPickupBody });
    await addCmd({ cfg, node, slug: "ok", title: "OK", column: "todo", body: validPickupBody, deps: ["dep"] });
    // dep is done → ok is unblocked.
    const res = await addCmd({ cfg, node, slug: "ok", column: "doing" });
    expect(res).toMatchObject({ action: "updated", column: "doing" });
  });

  test("creating a blocked card directly INTO a working column is refused", async () => {
    await addCmd({ cfg, node, slug: "dep", title: "Dep", column: "todo", body: validPickupBody });
    await expect(
      addCmd({ cfg, node, slug: "born-doing", title: "Born", column: "doing", deps: ["dep"] }),
    ).rejects.toMatchObject({ code: "card_blocked" });
    // Nothing written.
    expect(await findCard(node, cfg, "born-doing")).toBeNull();
  });

  test("creating a blocked card into `doing` succeeds with --force", async () => {
    await addCmd({ cfg, node, slug: "dep", title: "Dep", column: "todo", body: validPickupBody });
    const res = await addCmd({
      cfg,
      node,
      slug: "born-forced",
      column: "doing",
      deps: ["dep"],
      force: true,
    });
    expect(res).toMatchObject({ action: "created", column: "doing" });
  });

  test("placing a blocked card into `review` and `done` is also refused", async () => {
    await seedBlocked();
    for (const col of ["review", "done"]) {
      await expect(addCmd({ cfg, node, slug: "blk", column: col })).rejects.toMatchObject({
        code: "card_blocked",
      });
    }
    const after = await findCard(node, cfg, "blk");
    expect(after?.column).toBe("backlog");
  });

  test("a blocked card stays addable to backlog but not default/todo", async () => {
    await seedBlocked();
    // blk is already in backlog — re-add stays allowed even though blocked.
    const res = await addCmd({ cfg, node, slug: "blk", column: "backlog" });
    expect(res).toMatchObject({ action: "updated", column: "backlog" });
    // Promoting to todo while still blocked is refused (pickup lane).
    await expect(addCmd({ cfg, node, slug: "blk", column: "todo" })).rejects.toMatchObject({
      code: "card_blocked",
    });
    const after = await findCard(node, cfg, "blk");
    expect(after?.column).toBe("backlog");
  });

  test("a legacy dangling dep blocks placement into a working column", async () => {
    await addCmd({ cfg, node, slug: "fwd", title: "Fwd", column: "todo", body: validPickupBody });
    const card = await findCard(node, cfg, "fwd");
    expect(card).not.toBeNull();
    await node.updateRecord({
      schemaHash: cfg.schemaHashes.card!,
      keyHash: "fwd",
      fields: cardToFields({ ...card!, deps: ["never-exists"] }),
    });
    await expect(addCmd({ cfg, node, slug: "fwd", column: "doing" })).rejects.toMatchObject({
      code: "card_blocked",
      message: 'Card "fwd" is blocked by "never-exists" (not yet done).',
    });
  });
});
