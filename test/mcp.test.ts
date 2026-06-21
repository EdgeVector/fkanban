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

import { createFkanbanMcpServer } from "../src/mcp/server.ts";
import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, nowIso } from "../src/record.ts";
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

// In-memory fake node: a (schemaHash → keyHash → fields) store. Mirrors just
// enough of fold_db_node's contract for the write commands — point reads via a
// HashKey filter, full scans without one, and create/update/delete upserts.
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
    const entries = filter ? (t.has(filter.HashKey) ? [[filter.HashKey, t.get(filter.HashKey)!] as const] : []) : [...t.entries()];
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
describe("MCP server starts (degrades, not crashes) when config is unavailable", () => {
  let client: Client;
  const configError = new ConfigMissingError("/nope/config.json");

  beforeEach(async () => {
    client = await connectServer(createFkanbanMcpServer({ configError }));
  });

  test("connect succeeds and listTools returns all 12 tools", async () => {
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(12);
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
    const res = await client.callTool({ name: "fkanban_add", arguments: { slug: "card-a", column: "todo" } });
    expect(res.structuredContent).toEqual({ slug: "card-a", action: "created", board: "default", column: "todo" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("created card card-a → default/todo");

    // A second add for the same slug reports the update transition.
    const upd = await client.callTool({ name: "fkanban_add", arguments: { slug: "card-a", column: "doing" } });
    expect(upd.structuredContent).toEqual({ slug: "card-a", action: "updated", board: "default", column: "doing" });
  });

  test("fkanban_move echoes { slug, from, to }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-b", column: "todo" } });
    const res = await client.callTool({ name: "fkanban_move", arguments: { slug: "card-b", column: "doing" } });
    expect(res.structuredContent).toEqual({ slug: "card-b", from: "todo", to: "doing" });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("moved card-b: todo → doing");
  });

  test("fkanban_dep_add / fkanban_dep_rm echo { slug, dep, action, deps }", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "ui", column: "todo" } });
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", column: "todo" } });

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

  test("fkanban_rm echoes { slug, orphanedDependents } (empty when nothing depends on it)", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "card-c", column: "todo" } });
    const res = await client.callTool({ name: "fkanban_rm", arguments: { slug: "card-c" } });
    expect(res.structuredContent).toEqual({ slug: "card-c", orphanedDependents: [] });
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text).toBe("removed card card-c");
  });

  test("fkanban_rm reports cards left with a dangling dependency", async () => {
    await client.callTool({ name: "fkanban_add", arguments: { slug: "dep-x", column: "todo" } });
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "uses-x", column: "todo", deps: ["dep-x"] },
    });
    const res = await client.callTool({ name: "fkanban_rm", arguments: { slug: "dep-x" } });
    expect(res.structuredContent).toEqual({ slug: "dep-x", orphanedDependents: ["uses-x"] });
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("removed card dep-x");
    expect(text).toContain("uses-x");
    expect(text).toContain("dangling");
  });

  test("each write tool advertises an outputSchema", async () => {
    const { tools } = await client.listTools();
    const byName = new Map(tools.map((t) => [t.name, t]));
    for (const name of [
      "fkanban_add",
      "fkanban_move",
      "fkanban_dep_add",
      "fkanban_dep_rm",
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
    await client.callTool({ name: "fkanban_add", arguments: { slug: "api", title: "API", column: "todo" } });
    await client.callTool({
      name: "fkanban_add",
      // `ui` is deliberately a BLOCKED card sitting in `doing` (api is still in
      // todo) — the soft-block now refuses that placement, so `force` is needed
      // to construct the fixture state these read-tool tests assert against.
      arguments: { slug: "ui", title: "UI work", body: "search me", column: "doing", deps: ["api", "ghost"], force: true },
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
    // Each card also now ships a single-line body PREVIEW + `bodyTruncated`; the
    // fixture bodies are short so they're previewed unchanged with bodyTruncated:false.
    const cliCardsPreviewed = cliCards.map((c: Record<string, unknown>) => ({ ...c, bodyTruncated: false }));
    expect(res.structuredContent).toEqual({ cards: cliCardsPreviewed, total: cliCards.length, truncated: false });
    // Each list card now carries the same resolved dep status `show` returns:
    // `ui` is blocked by the unfinished `api` and reports the dangling `ghost`
    // as a missing (non-blocking) dep; `api` itself is unblocked.
    const cards = (res.structuredContent as { cards: Array<Record<string, unknown>> }).cards;
    for (const c of cards) {
      expect(c).toHaveProperty("blocked");
      expect(c).toHaveProperty("blockedBy");
      expect(c).toHaveProperty("missingDeps");
    }
    const ui = cards.find((c) => c.slug === "ui");
    expect(ui).toMatchObject({ blocked: true, blockedBy: ["api"], missingDeps: ["ghost"] });
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
    // A dangling dep is reported but does NOT block; an unfinished real dep does.
    expect(res.structuredContent).toMatchObject({ blocked: true, blockedBy: ["api"], missingDeps: ["ghost"] });
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
        arguments: { slug: `card-${idx}`, title: `Card ${idx}`, body: "needle in the body", column: "todo" },
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
  const BIG_BODY = "needle " + "x".repeat(4000);
  const PREVIEW_LEN = 200;

  beforeEach(async () => {
    node = fakeNode();
    await seedDefaultBoard(node);
    client = await connectedClient(node);
    await client.callTool({
      name: "fkanban_add",
      arguments: { slug: "huge", title: "Huge card", body: BIG_BODY, column: "todo" },
    });
  });

  function cardsOf(res: unknown): Array<{ slug: string; body: string; bodyTruncated: boolean }> {
    return (res as { structuredContent: { cards: Array<{ slug: string; body: string; bodyTruncated: boolean }> } })
      .structuredContent.cards;
  }

  test("fkanban_list previews the body by default (≤200 chars, bodyTruncated:true) and shrinks the payload ~8x+", async () => {
    const def = await client.callTool({ name: "fkanban_list", arguments: { column: "todo" } });
    const full = await client.callTool({ name: "fkanban_list", arguments: { column: "todo", full_body: true } });
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
      arguments: { slug: "multiline", title: "ML", body: "line one\n\nline two\tline three", column: "todo" },
    });
    const res = await client.callTool({ name: "fkanban_list", arguments: { column: "todo" } });
    const ml = cardsOf(res).find((c) => c.slug === "multiline")!;
    expect(ml.body).toBe("line one line two line three");
    expect(ml.body).not.toContain("\n");
    expect(ml.bodyTruncated).toBe(false);
  });
});
