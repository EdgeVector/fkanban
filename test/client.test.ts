// NodeClient wire-level tests against a stub HTTP server — verify the keyed
// point-read filter goes out on the wire and that every request has a deadline.

import { afterAll, describe, expect, test } from "bun:test";

import { FkanbanError, newNodeClient } from "../src/client.ts";
import { findCard } from "../src/record.ts";
import type { Config } from "../src/config.ts";

type SeenRequest = { path: string; body: unknown };

const seen: SeenRequest[] = [];

// Stub node: records every request; /api/query echoes one card row when a
// HashKey filter matches, an empty page otherwise; /slow never answers in time.
const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? await req.json() : undefined;
    seen.push({ path: url.pathname, body });
    if (url.pathname === "/slow/api/query") {
      await new Promise((r) => setTimeout(r, 5_000));
      return Response.json({ ok: true, results: [] });
    }
    // Flush response headers immediately, then stall forever mid-body. This is
    // the cold-schema-init failure mode: the node accepts the request and
    // returns headers fast, then hangs while streaming the body. A fetch-only
    // timeout does NOT cover this — the deadline must also bound the body read.
    if (url.pathname === "/headers-then-stall/api/query") {
      const stream = new ReadableStream({
        start(ctrl) {
          ctrl.enqueue(new TextEncoder().encode('{"ok":true,'));
          // never enqueue the rest, never close → body read hangs
        },
      });
      return new Response(stream, {
        headers: { "Content-Type": "application/json" },
      });
    }
    if (url.pathname === "/api/query") {
      const filter = (body as Record<string, unknown>).filter as { HashKey?: string } | undefined;
      const results =
        filter?.HashKey === "my-card"
          ? [
              {
                fields: {
                  slug: "my-card",
                  title: "My card",
                  body: "spec",
                  board: "default",
                  column: "todo",
                  position: "10",
                  assignee: "",
                  tags: [],
                  created_at: "2026-01-01T00:00:00.000Z",
                  updated_at: "2026-01-01T00:00:00.000Z",
                },
                key: { hash: "my-card", range: null },
              },
            ]
          : [];
      return Response.json({ ok: true, results, has_more: false });
    }
    return Response.json({ error: "unexpected_path" }, { status: 500 });
  },
});

afterAll(() => server.stop(true));

const baseUrl = `http://127.0.0.1:${server.port}`;

const cfg: Config = {
  configVersion: 1,
  nodeUrl: baseUrl,
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

describe("queryAll filter", () => {
  test("passes a HashKey filter through to the /api/query body", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const res = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug"],
      filter: { HashKey: "my-card" },
    });
    expect(res.results).toHaveLength(1);
    const last = seen.at(-1)!;
    expect(last.path).toBe("/api/query");
    expect((last.body as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
  });

  test("omits the filter key entirely when none is given", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    await node.queryAll({ schemaHash: "cardhash", fields: ["slug"] });
    const last = seen.at(-1)!;
    expect("filter" in (last.body as Record<string, unknown>)).toBe(false);
  });
});

describe("findCard", () => {
  test("is a single keyed query, not a scan", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const before = seen.length;
    const card = await findCard(node, cfg, "my-card");
    expect(card?.slug).toBe("my-card");
    expect(seen.length).toBe(before + 1);
    expect((seen.at(-1)!.body as Record<string, unknown>).filter).toEqual({ HashKey: "my-card" });
  });

  test("returns null when the key has no record", async () => {
    const node = newNodeClient({ baseUrl, userHash: "test-user" });
    const card = await findCard(node, cfg, "no-such-card");
    expect(card).toBeNull();
  });
});

describe("request deadline", () => {
  test("a hung node surfaces as service_timeout instead of hanging the CLI", async () => {
    const node = newNodeClient({ baseUrl: `${baseUrl}/slow`, userHash: "test-user", timeoutMs: 100 });
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_timeout");
    expect((err as FkanbanError).hint).toContain("re-running the command is safe");
  });

  test("a node that returns headers then stalls mid-body still times out (not just the fetch)", async () => {
    const node = newNodeClient({
      baseUrl: `${baseUrl}/headers-then-stall`,
      userHash: "test-user",
      timeoutMs: 100,
    });
    const start = Date.now();
    const err = await node
      .queryAll({ schemaHash: "cardhash", fields: ["slug"] })
      .then(() => null)
      .catch((e: unknown) => e);
    // It must abort at the deadline, not hang on the unbounded body read.
    expect(Date.now() - start).toBeLessThan(3_000);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("service_timeout");
    expect((err as FkanbanError).hint).toContain("re-running the command is safe");
  });
});
