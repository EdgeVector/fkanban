// MCP write-tool tests — drive createFkanbanMcpServer over an in-memory
// transport with a real MCP Client and assert every write tool returns
// `structuredContent` matching the underlying command's result object (the
// same shape the CLI emits under `--json`), alongside the human text block.
//
// Backed by an in-memory fake NodeClient (the NodeClient interface is plain),
// so the whole round-trip is exercised with no live node / schema service —
// the same "unit-testable without a live node" approach as the command
// formatters in unit.test.ts. Because the client validates structuredContent
// against each tool's declared outputSchema, a schema/result mismatch fails
// the test here, not just at runtime.

import { beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { ConfigMissingError } from "../src/config.ts";

import {
  createFkanbanMcpServer,
  FKANBAN_MCP_INSTRUCTIONS,
  FKANBAN_READ_TOOLS,
  FKANBAN_WRITE_TOOLS,
  FKANBAN_TOOL_COUNT,
} from "../src/mcp/server.ts";
import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, cardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { listCmd } from "../src/commands/list.ts";
import { searchCmd, searchResult } from "../src/commands/search.ts";
import { showCmd } from "../src/commands/show.ts";
import { boardListCmd } from "../src/commands/board.ts";
import { DEFAULT_SEARCH_LIMIT } from "../src/board.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const validPickupBody = (body = "MCP fixture work.") => `Repo: EdgeVector/fkanban\nBase: main\n\n${body}`;

// In-memory fake node: a (schemaHash → keyHash → fields) store. Mirrors just
// enough of fold_db_node's contract for the write commands — point reads via a
// HashKey filter, exact field filters, full scans without one, and
// create/update/delete upserts.
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

// Seed the default board so add/move resolve a board.
function seedDefaultBoard(node: NodeClient) {
  const now = nowIso();
  return node.createRecord({
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

async function connectServer(server: ReturnType<typeof createFkanbanMcpServer>): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

async function connectedClient(node: NodeClient): Promise<Client> {
  return connectServer(createFkanbanMcpServer({ cfg, node }));
}

// The server must START even when config is missing/invalid: a new dev who
// runs `claude mcp add fkanban …` BEFORE `fkanban init` should connect and get
// an actionable per-tool hint, not an opaque "failed to connect" (the handshake
// used to never run because runMcp bailed out before server.connect). When
// built in the not-yet-configured state, connect + listTools succeed, every
// config-dependent tool short-circuits to a clean `isError` "Run `fkanban init`
// first." result, and `fkanban_doctor` still runs to self-diagnose.
// On connect, an MCP host surfaces the server's `instructions` (from the
// `initialize` result) to the model. fkanban now sends a concise board-level
// orientation so a connecting agent gets the column workflow, the blocking
// rule, and (the token-budget one) the list/search cap + body-preview contract
// in ONE read — instead of reverse-engineering it from 12 per-tool descriptions.
// These assert the client receives that non-empty orientation and that it names
// the token-economy knobs the agent must know to avoid burning context.
describe("MCP server sends board-level instructions on connect", () => {
  test("client.getInstructions() returns the non-empty fkanban orientation", async () => {
    const client = await connectServer(createFkanbanMcpServer({ configError: new ConfigMissingError("/nope") }));
    const instructions = client.getInstructions();
    expect(instructions).toBeDefined();
    expect((instructions ?? "").length).toBeGreaterThan(0);
    expect(instructions).toBe(FKANBAN_MCP_INSTRUCTIONS);
  });

  test("the instructions cover board model, blocking, and the token-economy knobs", async () => {
    const client = await connectServer(createFkanbanMcpServer({ configError: new ConfigMissingError("/nope") }));
    const text = client.getInstructions() ?? "";
    // Board model: the column flow.
    expect(text).toContain("backlog → todo → doing → review → done");
    // Blocking rule mentions the force opt-out.
    expect(text.toLowerCase()).toContain("force");
    expect(text.toLowerCase()).toContain("depend");
    // Token economy: the cap, the widen knobs, the body preview, and the
    // prefer-fkanban_show-for-one-card guidance.
    expect(text).toContain("20");
    expect(text).toContain("full_body");
    expect(text).toContain("fkanban_show");
    // Discovery entry point.
    expect(text).toContain("fkanban_doctor");
  });
});

describe("MCP server starts (degrades, not crashes) when config is unavailable", () => {
  let client: Client;
  const configError = new ConfigMissingError("/nope/config.json");

  beforeEach(async () => {
    client = await connectServer(createFkanbanMcpServer({ configError }));
  });

  test("connect succeeds and listTools returns every registered tool", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(FKANBAN_TOOL_COUNT);
  });

  // The MCP instructions state a tool count and a read/write split. Both are
  // DERIVED from FKANBAN_READ_TOOLS/FKANBAN_WRITE_TOOLS, not hand-written, so
  // this guards against them rotting the moment a tool is added or removed:
  // the declared split must equal the tools actually registered on the server,
  // and their readOnlyHint annotations must line up.
  test("the read/write tool split matches the tools registered on the server", async () => {
    const { tools } = await client.listTools();
    const registered = new Set(tools.map((t) => t.name));
    const declared = new Set<string>([...FKANBAN_READ_TOOLS, ...FKANBAN_WRITE_TOOLS]);
    expect(declared).toEqual(registered);
    expect(FKANBAN_TOOL_COUNT).toBe(tools.length);

    const readOnly = new Set(
      tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name),
    );
    expect(readOnly).toEqual(new Set(FKANBAN_READ_TOOLS));
    for (const w of FKANBAN_WRITE_TOOLS) {
      const tool = tools.find((t) => t.name === w);
      expect(tool?.annotations?.readOnlyHint).not.toBe(true);
    }
  });

  test("the instructions blurb reflects the derived count and split", () => {
    // The count is DERIVED from the tool lists — the string must render exactly
    // whatever FKANBAN_TOOL_COUNT is, with no separately-hardcoded number that
    // could disagree with it. (If a tool is added/removed, both this and the
    // blurb move together.)
    expect(FKANBAN_MCP_INSTRUCTIONS).toContain(`${FKANBAN_TOOL_COUNT} tools`);
    for (const r of FKANBAN_READ_TOOLS) {
      expect(FKANBAN_MCP_INSTRUCTIONS).toContain(r);
    }
    // The write tools appear by short name in the blurb.
    for (const w of FKANBAN_WRITE_TOOLS) {
      expect(FKANBAN_MCP_INSTRUCTIONS).toContain(w.replace(/^fkanban_/, ""));
    }
  });

  test("fkanban_list returns isError with the actionable 'run init' hint", async () => {
    const res = await client.callTool({ name: "fkanban_list", arguments: {} });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Run `fkanban init` first.");
  });

  test("a write tool also short-circuits to the same actionable hint", async () => {
    const res = await client.callTool({ name: "fkanban_add", arguments: { slug: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain(
      "Run `fkanban init` first.",
    );
  });

  test("fkanban_doctor still runs and flags the missing config (does not crash)", async () => {
    // Doctor reads config itself (via FKANBAN_CONFIG / the default path), not the
    // server's state. Point it at a non-existent file so the check is deterministic
    // regardless of any real ~/.fkanban/config.json on the test machine.
    const prev = process.env.FKANBAN_CONFIG;
    process.env.FKANBAN_CONFIG = "/nonexistent/fkanban-doctor-test/config.json";
    try {
      const res = await client.callTool({ name: "fkanban_doctor", arguments: {} });
      // With no config it reports a failing check list (isError true) rather than throwing.
      expect(res.isError).toBe(true);
      const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
      expect(text).toContain("config present");
    } finally {
      if (prev === undefined) delete process.env.FKANBAN_CONFIG;
      else process.env.FKANBAN_CONFIG = prev;
    }
  });
});

describe("MCP write tools return structuredContent", () => {
  let node: NodeClient;
  let client: Client;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
  });

  test("fkanban_board_create echoes { slug, action }", async () => {
    const res = await client.callTool({ name: "fkanban_board_create", arguments: { slug: "sprint" } });
    expect(res.structuredContent).toEqual({ slug: "sprint", action: "created" });
    // Human text block is still present for clients that ignore structuredContent.
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("created board sprint");
  });

  test("fkanban_add echoes { slug, action, board, column }", async () => {
    const res = await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "card-a", column: "todo", body: validPickupBody(), surfaces: ["src/cli.ts"] },
    });
    expect(res.structuredContent).toEqual({ slug: "card-a", action: "created", board: "default", column: "todo" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("created card card-a → default/todo");
    const shown = await client.callTool({ name: "fkanban_show", arguments: { slug: "card-a" } });
    expect((shown.structuredContent as { surfaces: string[] }).surfaces).toEqual(["src/cli.ts"]);

    // A second add for the same slug reports the update transition.
    const upd = await client.callTool({ name: "fkanban_add", arguments: { slug: "card-a", column: "doing" } });
    expect(upd.structuredContent).toEqual({ slug: "card-a", action: "updated", board: "default", column: "doing" });
  });

  test("fkanban_overlap reports matching surface claims", async () => {
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "peer", title: "Peer", column: "doing", body: validPickupBody(), surfaces: ["src/mcp/**"] },
    });
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "candidate", column: "todo", body: validPickupBody(), surfaces: ["src/mcp/server.ts"] },
    });

    const res = await client.callTool({ name: "fkanban_overlap", arguments: { slug: "candidate" } });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain("Surface conflicts for candidate");
    const structured = res.structuredContent as {
      conflicts: Array<{ slug: string; matches: Array<{ candidate: string; other: string }> }>;
    };
    expect(structured.conflicts[0]?.slug).toBe("peer");
    expect(structured.conflicts[0]?.matches).toEqual([{ candidate: "src/mcp/server.ts", other: "src/mcp/**" }]);
  });

  test("fkanban_move echoes { slug, from, to }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-b", column: "todo", body: validPickupBody() } });
    const res = await client.callTool({ name: "fkanban_move", arguments: { slug: "card-b", column: "doing" } });
    expect(res.structuredContent).toEqual({ slug: "card-b", from: "todo", to: "doing" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("moved card-b: todo → doing");
  });

  test("fkanban_dep_add / fkanban_dep_rm echo { slug, dep, action, deps }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "ui", column: "todo", body: validPickupBody() } });
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", column: "todo", body: validPickupBody() } });

    const added = await client.callTool({ name: "fkanban_dep_add", arguments: { slug: "ui", dep: "api" } });
    expect(added.structuredContent).toEqual({ slug: "ui", dep: "api", action: "added", deps: ["api"] });
    expect((added.content as Array<{ type: string; text: string }>)[0]?.text).toBe(
      "ui now depends on api (deps: api)",
    );

    const removed = await client.callTool({ name: "fkanban_dep_rm", arguments: { slug: "ui", dep: "api" } });
    expect(removed.structuredContent).toEqual({ slug: "ui", dep: "api", action: "removed", deps: [] });
    expect((removed.content as Array<{ type: string; text: string }>)[0]?.text).toBe(
      "ui no longer depends on api (deps: none)",
    );
  });

  test("fkanban_add preserves deps unless replace_deps is explicit", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", column: "todo", body: validPickupBody() } });
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "ui", column: "todo", deps: ["api"], body: validPickupBody() },
    });

    const rejected = await client.callTool({ name: "fkanban_add", arguments: { slug: "ui", deps: [] } });
    expect(rejected.isError).toBe(true);
    expect((rejected.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain(
      "would replace its dependency list",
    );

    const cleared = await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "ui", deps: [], replace_deps: true },
    });
    expect(cleared.structuredContent).toEqual({ slug: "ui", action: "updated", board: "default", column: "todo" });
    const shown = await client.callTool({ name: "fkanban_show", arguments: { slug: "ui" } });
    expect((shown.structuredContent as { deps: string[] }).deps).toEqual([]);
  });

  test("dependency write tools reject missing dependency slugs", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "ui", column: "todo", body: validPickupBody() } });

    const addRes = await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "new-ui", column: "todo", body: validPickupBody(), deps: ["missing-api"] },
    });
    expect(addRes.isError).toBe(true);
    expect((addRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain(
      'Dependency card "missing-api" does not exist.',
    );
    expect(await findCard(node, cfg, "new-ui")).toBeNull();

    const depRes = await client.callTool({ name: "fkanban_dep_add", arguments: { slug: "ui", dep: "missing-api" } });
    expect(depRes.isError).toBe(true);
    expect((depRes.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain(
      'Dependency card "missing-api" does not exist.',
    );
    expect((await findCard(node, cfg, "ui"))?.deps).toEqual([]);
  });

  test("fkanban_tag_add / fkanban_tag_rm edit one tag without clobbering the rest", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "tg", column: "todo", tags: ["a", "b"], body: validPickupBody() } });

    // Incremental add unions; the existing tags survive.
    const added = await client.callTool({ name: "fkanban_tag_add", arguments: { slug: "tg", tags: ["c"] } });
    expect(added.structuredContent).toEqual({ slug: "tg", tag: ["c"], action: "added", tags: ["a", "b", "c"] });
    expect((added.content as Array<{ type: string; text: string }>)[0]?.text).toBe("tagged tg c (tags: a, b, c)");

    // Adding a present tag is idempotent (no duplicate).
    const dup = await client.callTool({ name: "fkanban_tag_add", arguments: { slug: "tg", tags: ["a"] } });
    expect(dup.structuredContent).toEqual({ slug: "tg", tag: ["a"], action: "added", tags: ["a", "b", "c"] });

    // Incremental rm drops only the named tag.
    const removed = await client.callTool({ name: "fkanban_tag_rm", arguments: { slug: "tg", tags: ["b"] } });
    expect(removed.structuredContent).toEqual({ slug: "tg", tag: ["b"], action: "removed", tags: ["a", "c"] });
    expect((removed.content as Array<{ type: string; text: string }>)[0]?.text).toBe("untagged tg b (tags: a, c)");
  });

  test("fkanban_tag_add rejects a reserved dep: tag", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "tg2", column: "todo", body: validPickupBody() } });
    const res = await client.callTool({ name: "fkanban_tag_add", arguments: { slug: "tg2", tags: ["dep:foo"] } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain("reserved");
  });

  test("fkanban_rm echoes { slug, orphanedDependents } (empty when nothing depends on it)", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-c", column: "todo", body: validPickupBody() } });
    const res = await client.callTool({ name: "fkanban_rm", arguments: { slug: "card-c" } });
    expect(res.structuredContent).toEqual({ slug: "card-c", orphanedDependents: [] });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("removed card card-c");
  });

  test("fkanban_rm refuses to create a dangling dependency", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "dep-x", column: "todo", body: validPickupBody() } });
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "uses-x", column: "todo", deps: ["dep-x"], body: validPickupBody() },
    });
    const res = await client.callTool({ name: "fkanban_rm", arguments: { slug: "dep-x" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("uses-x");
    expect(text).toContain("still a dependency");
  });

  test("each write tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "fkanban_add",
      "fkanban_move",
      "fkanban_dep_add",
      "fkanban_dep_rm",
      "fkanban_tag_add",
      "fkanban_tag_rm",
      "fkanban_rm",
      "fkanban_board_create",
    ]) {
      expect(byName.get(name)?.outputSchema, `${name} should declare an outputSchema`).toBeDefined();
    }
  });
});

describe("MCP read tools return structuredContent matching the CLI --json shape", () => {
  let node: NodeClient;
  let client: Client;

  // Seed a small board: two cards on `default` (one depends on the other and
  // on a dangling slug, exercising blocked/missingDeps), plus a second board.
  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
    await client.callTool({ name: "fkanban_board_create", arguments: { slug: "sprint", title: "Sprint" } });
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", title: "API", column: "todo", body: validPickupBody() } });
    await client.callTool({
      name: "fkanban_add",
      // `ui` is deliberately a BLOCKED card sitting in `doing` (api is still in
      // todo) — the soft-block now refuses that placement, so `force` is needed
      // to construct the fixture state these read-tool tests assert against.
      arguments: { slug: "ui", title: "UI work", body: "search me", column: "doing", deps: ["api"], force: true },
    });
    // New write APIs reject missing deps. Seed one directly so read tools still
    // cover old rows written before that hardening.
    const ui = await findCard(node, cfg, "ui");
    expect(ui).not.toBeNull();
    await node.updateRecord({
      schemaHash: cfg.schemaHashes.card!,
      keyHash: "ui",
      fields: cardToFields({ ...ui!, deps: ["api", "ghost"] }),
    });
  });

  test("fkanban_list returns { cards } deep-equal to `list --json` (with blocked status, validated against outputSchema)", async () => {
    const res = await client.callTool({ name: "fkanban_list", arguments: {} });
    const cliCards = JSON.parse(await listCmd({ cfg, node, json: true }));
    expect(res.structuredContent).toBeDefined();
    // The client validates structuredContent against the widened outputSchema —
    // an enriched-card-shape mismatch would fail this callTool, not just assert.
    // The structured array now carries a truncation signal; the small fixture is
    // under the default cap, so `truncated` is false and `cards` is the full set.
    // Each card also now ships a single-line body PREVIEW + `bodyTruncated`. The
    // fixture bodies are short (never truncated), but `api` sits in `todo` and so
    // carries an auto-stamped multi-line `Repo:`/`Base:` header — the preview
    // flattens whitespace to one line, so flatten the expected bodies to match.
    const cliCardsPreviewed = cliCards.map((c: Record<string, unknown>) => ({
      ...c,
      body: (c.body as string).replace(/\s+/g, " ").trim(),
      bodyTruncated: false,
    }));
    expect(res.structuredContent).toEqual({ cards: cliCardsPreviewed, total: cliCards.length, truncated: false });
    // Each list card now carries the same resolved dep status `show` returns:
    // `ui` is blocked by the unfinished `api` and reports the dangling `ghost`;
    // missing deps are blocking too, but `blockedBy` already includes `api`.
    const cards = (res.structuredContent as { cards: Array<Record<string, unknown>> }).cards;
    for (const c of cards) {
      expect(c).toHaveProperty("blocked");
      expect(c).toHaveProperty("blockedBy");
      expect(c).toHaveProperty("missingDeps");
    }
    const ui = cards.find((c) => c.slug === "ui");
    expect(ui).toMatchObject({ blocked: true, blockedBy: ["api", "ghost"], missingDeps: ["ghost"] });
    const api = cards.find((c) => c.slug === "api");
    expect(api).toMatchObject({ blocked: false, blockedBy: [], missingDeps: [] });
    // Human text block is preserved for non-structured clients.
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text.length).toBeGreaterThan(0);
  });

  test("fkanban_search returns { cards } deep-equal to `search --json`", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "search me" } });
    const cliCards = JSON.parse(await searchCmd({ cfg, node, query: "search me", json: true }));
    // One match, under the default cap → full set + `truncated:false`. Body is
    // previewed (short fixture body → unchanged, bodyTruncated:false).
    const cliCardsPreviewed = cliCards.map((c: Record<string, unknown>) => ({ ...c, bodyTruncated: false }));
    expect(res.structuredContent).toEqual({ cards: cliCardsPreviewed, total: cliCards.length, truncated: false });
    expect((cliCards as Array<{ slug: string }>).map((c) => c.slug)).toEqual(["ui"]);
  });

  test("searchResult rejects a whitespace-only query (missing_arg) instead of dumping the board", async () => {
    // A zero-effective-term query is a usage error, not a match-all wildcard —
    // guarding at the single entry point fixes both the CLI and the MCP tool.
    for (const q of ["", "   ", "\t\n "]) {
      let err: unknown;
      try {
        await searchResult({ cfg, node, query: q });
      } catch (e) {
        err = e;
      }
      expect(err, `query ${JSON.stringify(q)} should throw`).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("missing_arg");
      expect((err as FkanbanError).message).toContain("usage: fkanban search");
    }
  });

  test("fkanban_search reports a clean isError on a whitespace-only query, not a board dump", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "   " } });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Missing search query");
    // It must NOT have returned the board.
    expect(res.structuredContent).toBeUndefined();
  });

  test("fkanban_show returns the card detail deep-equal to `show --json` (blocked/missingDeps surfaced)", async () => {
    const res = await client.callTool({ name: "fkanban_show", arguments: { slug: "ui" } });
    const cliCard = JSON.parse(await showCmd({ cfg, node, slug: "ui", json: true }));
    expect(res.structuredContent).toEqual(cliCard);
    // A dangling dep is reported and blocks alongside the unfinished real dep.
    expect(res.structuredContent).toMatchObject({ blocked: true, blockedBy: ["api", "ghost"], missingDeps: ["ghost"] });
  });

  test("fkanban_board_list returns { boards } deep-equal to `board list --json`", async () => {
    const res = await client.callTool({ name: "fkanban_board_list", arguments: {} });
    const cliBoards = JSON.parse(await boardListCmd({ cfg, node, json: true }));
    expect(res.structuredContent).toEqual({ boards: cliBoards });
    expect((cliBoards as Array<{ slug: string }>).map((b) => b.slug).sort()).toEqual(["default", "sprint"]);
  });

  test("each read tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of ["fkanban_list", "fkanban_search", "fkanban_show", "fkanban_board_list"]) {
      expect(byName.get(name)?.outputSchema, `${name} should declare an outputSchema`).toBeDefined();
    }
  });

  test("a read-tool error is still an isError text result (unchanged)", async () => {
    const res = await client.callTool({ name: "fkanban_show", arguments: { slug: "does-not-exist" } });
    expect(res.isError).toBe(true);
    expect(res.structuredContent).toBeUndefined();
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toContain("error:");
  });
});

// The agent-facing structured `cards` array is the token-budget risk: on a real
// board (160+ cards, each with its full body) an uncapped `fkanban_search`/
// `fkanban_list` dumps ~160K tokens and evicts the caller's context. These tests
// pin the default cap (DEFAULT_SEARCH_LIMIT=20), the `limit`/`all` opt-out, and
// the `total`/`truncated` signal — on a board seeded with MORE than the cap.
describe("MCP read tools cap the structured card array by default", () => {
  let node: NodeClient;
  let client: Client;
  const N = 30; // > DEFAULT_SEARCH_LIMIT (20)

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
    // Seed N cards in `todo`, each whose body contains the term "needle" so a
    // single search matches all of them.
    for (let i = 0; i < N; i++) {
      const idx = String(i).padStart(3, "0");
      await client.callTool({
        name: "fkanban_add",
        arguments: { slug: `card-${idx}`, title: `Card ${idx}`, body: validPickupBody("needle in the body"), column: "todo" },
      });
    }
  });

  function struct(res: unknown): { cards: unknown[]; total: number; truncated: boolean } {
    return (res as { structuredContent: { cards: unknown[]; total: number; truncated: boolean } }).structuredContent;
  }

  test("fkanban_search caps at DEFAULT_SEARCH_LIMIT (20) with truncated:true and the true total", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "needle" } });
    const s = struct(res);
    expect(s.cards.length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(s.total).toBe(N);
    expect(s.truncated).toBe(true);
  });

  test("fkanban_search honors an explicit limit", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "needle", limit: 5 } });
    const s = struct(res);
    expect(s.cards.length).toBe(5);
    expect(s.total).toBe(N);
    expect(s.truncated).toBe(true);
  });

  test("fkanban_search all:true returns the complete set, untruncated", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "needle", all: true } });
    const s = struct(res);
    expect(s.cards.length).toBe(N);
    expect(s.total).toBe(N);
    expect(s.truncated).toBe(false);
  });

  test("fkanban_search limit:0 is an opt-out equivalent to all:true", async () => {
    const res = await client.callTool({ name: "fkanban_search", arguments: { query: "needle", limit: 0 } });
    const s = struct(res);
    expect(s.cards.length).toBe(N);
    expect(s.truncated).toBe(false);
  });

  test("fkanban_list caps at DEFAULT_SEARCH_LIMIT (20) with truncated:true and the true total", async () => {
    const res = await client.callTool({ name: "fkanban_list", arguments: { column: "todo" } });
    const s = struct(res);
    expect(s.cards.length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(s.total).toBe(N);
    expect(s.truncated).toBe(true);
  });

  test("fkanban_list honors limit and all:true (opt-out)", async () => {
    const five = struct(await client.callTool({ name: "fkanban_list", arguments: { column: "todo", limit: 5 } }));
    expect(five.cards.length).toBe(5);
    expect(five.truncated).toBe(true);

    const all = struct(await client.callTool({ name: "fkanban_list", arguments: { column: "todo", all: true } }));
    expect(all.cards.length).toBe(N);
    expect(all.total).toBe(N);
    expect(all.truncated).toBe(false);
  });

  test("the capped fkanban_list keeps position order (first 20 of the sorted set)", async () => {
    const capped = struct(await client.callTool({ name: "fkanban_list", arguments: { column: "todo" } }));
    const full = struct(await client.callTool({ name: "fkanban_list", arguments: { column: "todo", all: true } }));
    const cappedSlugs = (capped.cards as Array<{ slug: string }>).map((c) => c.slug);
    const fullSlugs = (full.cards as Array<{ slug: string }>).map((c) => c.slug);
    // The cap is a prefix of the full ordered list — no reordering.
    expect(cappedSlugs).toEqual(fullSlugs.slice(0, DEFAULT_SEARCH_LIMIT));
  });
});

// An empty/whitespace-only REQUIRED string arg used to bypass each handler's
// try/catch: the args were declared `z.string().min(1)`, so the MCP SDK rejected
// them in pre-handler validation and dumped a raw `MCP error -32602: Input
// validation error … too_small` Zod blob — the one place fkanban's voiced error
// surface broke. The required strings are now declared without `.min(1)` and each
// handler calls `requireArg` at the top of its `try`, so an empty value becomes
// the same voiced `error:`/`hint:` result every domain error returns. These tests
// pin that voiced result (and that it's NOT a `-32602` dump) for every tool that
// takes a required string arg.
describe("MCP tools voice an empty required string arg (no raw -32602 Zod dump)", () => {
  let node: NodeClient;
  let client: Client;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    // Seed two real cards so dep tools' SECOND arg is what's empty, not a
    // missing-card domain error masking the empty-arg path.
    client = await connectedClient(node);
    await client.callTool({ name: "fkanban_add", arguments: { slug: "real-a", column: "todo", body: validPickupBody() } });
    await client.callTool({ name: "fkanban_add", arguments: { slug: "real-b", column: "todo", body: validPickupBody() } });
  });

  function textOf(res: unknown): string {
    const content = (res as { content?: unknown }).content;
    return (content as Array<{ type: string; text: string }>)[0]?.text ?? "";
  }

  // For each tool, the EMPTY-arg arguments and the substring its voiced message
  // must contain. `""` and a whitespace-only value both count as empty.
  const cases: Array<{ tool: string; args: Record<string, unknown>; expect: string }> = [
    { tool: "fkanban_search", args: { query: "" }, expect: "Missing search query" },
    { tool: "fkanban_show", args: { slug: "  " }, expect: "Missing card slug" },
    { tool: "fkanban_add", args: { slug: "" }, expect: "Missing card slug" },
    { tool: "fkanban_move", args: { slug: "", column: "doing" }, expect: "Missing card slug" },
    { tool: "fkanban_move", args: { slug: "real-a", column: "" }, expect: "Missing target column" },
    { tool: "fkanban_dep_add", args: { slug: "real-a", dep: "" }, expect: "Missing dependency slug" },
    { tool: "fkanban_dep_add", args: { slug: "", dep: "real-b" }, expect: "Missing dependent card slug" },
    { tool: "fkanban_dep_rm", args: { slug: "real-a", dep: "  " }, expect: "Missing dependency slug" },
    { tool: "fkanban_rm", args: { slug: "" }, expect: "Missing card slug" },
    { tool: "fkanban_board_create", args: { slug: "\t" }, expect: "Missing board slug" },
    { tool: "fkanban_board_rm", args: { slug: "" }, expect: "Missing board slug" },
  ];

  for (const c of cases) {
    test(`${c.tool} ${JSON.stringify(c.args)} → voiced isError, not -32602`, async () => {
      const res = await client.callTool({ name: c.tool, arguments: c.args });
      expect(res.isError).toBe(true);
      const text = textOf(res);
      expect(text.startsWith("error: ")).toBe(true);
      expect(text).toContain(c.expect);
      expect(text).toContain("hint:");
      // It must NOT be the raw SDK Zod dump.
      expect(text).not.toContain("-32602");
      expect(text).not.toContain("too_small");
      // A voiced error short-circuits before any work — no structuredContent.
      expect(res.structuredContent).toBeUndefined();
    });
  }

  test("a VALID required arg still works unchanged (no false positives)", async () => {
    const search = await client.callTool({ name: "fkanban_search", arguments: { query: "real" } });
    expect(search.isError).toBeFalsy();
    expect(search.structuredContent).toBeDefined();

    const show = await client.callTool({ name: "fkanban_show", arguments: { slug: "real-a" } });
    expect(show.isError).toBeFalsy();
    expect((show.structuredContent as { slug: string }).slug).toBe("real-a");
  });
});

// After #70's COUNT cap, the per-card `body` is the bulk of a list/search
// payload (87% of a default page on the live board). The agent-facing
// multi-card read tools now ship a short single-line body PREVIEW + a
// `bodyTruncated` flag by default, with a `full_body:true` opt-in that restores
// complete bodies; `fkanban_show` always returns the full body. These tests pin
// that behavior on a card whose body is multiple KB.
describe("MCP read tools preview card bodies by default, full under full_body / fkanban_show", () => {
  let node: NodeClient;
  let client: Client;
  // A multi-KB body, on one line and well over the ~200-char preview cap.
  // Large enough that the body dominates the per-card metadata (which grew when
  // cards gained the structured pickup fields), so the >8x preview-shrink
  // contract holds with margin rather than being sensitive to field count.
  const BIG_BODY = "needle " + "x".repeat(8000);
  const PREVIEW_LEN = 200;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
    // Seed in a working column (`doing`): these tests are about body PREVIEW, not
    // repo derivation, and working columns skip the Repo:/Base: auto-stamp — so the
    // body stays exactly BIG_BODY and the preview assertions test only previewing.
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "huge", title: "Huge card", body: BIG_BODY, column: "doing" },
    });
  });

  function cardsOf(res: unknown): Array<{ slug: string; body: string; bodyTruncated: boolean }> {
    return (res as { structuredContent: { cards: Array<{ slug: string; body: string; bodyTruncated: boolean }> } })
      .structuredContent.cards;
  }

  test("fkanban_list previews the body by default (≤200 chars, bodyTruncated:true) and shrinks the payload ~8x+", async () => {
    const def = await client.callTool({ name: "fkanban_list", arguments: { column: "doing" } });
    const full = await client.callTool({ name: "fkanban_list", arguments: { column: "doing", full_body: true } });
    const huge = cardsOf(def).find((c) => c.slug === "huge")!;
    expect(huge.body.length).toBe(PREVIEW_LEN);
    expect(huge.bodyTruncated).toBe(true);
    expect(huge.body.startsWith("needle")).toBe(true);

    const hugeFull = cardsOf(full).find((c) => c.slug === "huge")!;
    expect(hugeFull.body).toBe(BIG_BODY);
    expect(hugeFull.bodyTruncated).toBe(false);

    // The default payload must be dramatically smaller than full bodies.
    const defSize = JSON.stringify((def as { structuredContent: unknown }).structuredContent).length;
    const fullSize = JSON.stringify((full as { structuredContent: unknown }).structuredContent).length;
    expect(fullSize / defSize).toBeGreaterThan(8);
  });

  test("fkanban_search previews the body by default and restores it under full_body:true", async () => {
    const def = await client.callTool({ name: "fkanban_search", arguments: { query: "needle" } });
    const full = await client.callTool({ name: "fkanban_search", arguments: { query: "needle", full_body: true } });
    const huge = cardsOf(def).find((c) => c.slug === "huge")!;
    expect(huge.body.length).toBe(PREVIEW_LEN);
    expect(huge.bodyTruncated).toBe(true);

    const hugeFull = cardsOf(full).find((c) => c.slug === "huge")!;
    expect(hugeFull.body).toBe(BIG_BODY);
    expect(hugeFull.bodyTruncated).toBe(false);
  });

  test("fkanban_show still returns the complete body (unchanged, no preview)", async () => {
    const res = await client.callTool({ name: "fkanban_show", arguments: { slug: "huge" } });
    const card = (res.structuredContent ?? {}) as { body: string };
    expect(card.body).toBe(BIG_BODY);
    // show does not declare/emit bodyTruncated — it's the full-read path.
    expect(card).not.toHaveProperty("bodyTruncated");
  });

  test("a multi-line body is flattened to a single line in the preview", async () => {
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "multiline", title: "ML", body: "line one\n\nline two\tline three", column: "doing" },
    });
    const res = await client.callTool({ name: "fkanban_list", arguments: { column: "doing" } });
    const ml = cardsOf(res).find((c) => c.slug === "multiline")!;
    expect(ml.body).toBe("line one line two line three");
    expect(ml.body).not.toContain("\n");
    expect(ml.bodyTruncated).toBe(false);
  });
});
