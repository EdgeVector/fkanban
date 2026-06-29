// Owner-session attestation tests: mint over a Unix-domain control socket,
// exchange for a session token, attach X-Folddb-Session to every node request,
// and re-pair once on a 403 transport_not_attested. The full-surface socket can
// serve the exchange directly; narrower sockets retain the TCP exchange fallback.

import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attestOwnerSession, FkanbanError, newNodeClient } from "../src/client.ts";

type Stoppable = { stop: (closeActive?: boolean) => void };
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

function track(srv: Stoppable): void {
  cleanups.push(() => srv.stop(true));
}

function socketPath(): string {
  return join(tmpdir(), `fkanban-attest-${process.pid}-${Math.random().toString(36).slice(2)}.sock`);
}

describe("attestOwnerSession", () => {
  test("mints over the UDS socket, exchanges over TCP, returns the token", async () => {
    const sock = socketPath();
    const uds = Bun.serve({
      unix: sock,
      fetch(req) {
        expect(new URL(req.url).pathname).toBe("/control/browser-pairing-code");
        return Response.json({ pairing_code: "code-xyz" });
      },
    });
    track(uds);

    let exchangedCode: string | undefined;
    const tcp = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        expect(url.pathname).toBe("/api/session/browser-pair");
        const body = (await req.json()) as Record<string, unknown>;
        exchangedCode = body.code as string;
        return Response.json({ session_token: "tok-123" });
      },
    });
    track(tcp);

    const token = await attestOwnerSession(`http://127.0.0.1:${tcp.port}`, sock);
    expect(token).toBe("tok-123");
    expect(exchangedCode).toBe("code-xyz");
  });

  test("full-surface socket exchanges the pairing code over UDS without TCP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fkanban-attest-full-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const sock = join(dir, "folddb-full.sock");
    const seen: string[] = [];
    let exchangedCode: string | undefined;
    const uds = Bun.serve({
      unix: sock,
      async fetch(req) {
        const path = new URL(req.url).pathname;
        seen.push(path);
        if (path === "/control/browser-pairing-code") {
          return Response.json({ pairing_code: "code-full" });
        }
        if (path === "/api/session/browser-pair") {
          const body = (await req.json()) as Record<string, unknown>;
          exchangedCode = body.code as string;
          return Response.json({ session_token: "tok-full" });
        }
        return Response.json({ error: "unexpected_path", path }, { status: 500 });
      },
    });
    track(uds);

    const token = await attestOwnerSession("http://127.0.0.1:1", sock);
    expect(token).toBe("tok-full");
    expect(exchangedCode).toBe("code-full");
    expect(seen).toEqual(["/control/browser-pairing-code", "/api/session/browser-pair"]);
  });

  test("returns null when the socket does not exist (device-trust fallback)", async () => {
    const tcp = Bun.serve({ port: 0, fetch: () => Response.json({ session_token: "nope" }) });
    track(tcp);
    const token = await attestOwnerSession(`http://127.0.0.1:${tcp.port}`, socketPath());
    expect(token).toBeNull();
  });

  test("returns null when the exchange is refused", async () => {
    const sock = socketPath();
    const uds = Bun.serve({ unix: sock, fetch: () => Response.json({ pairing_code: "c" }) });
    track(uds);
    const tcp = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "bad_code" }, { status: 400 }),
    });
    track(tcp);
    const token = await attestOwnerSession(`http://127.0.0.1:${tcp.port}`, sock);
    expect(token).toBeNull();
  });
});

describe("newNodeClient attestation wiring", () => {
  test("attaches X-Folddb-Session to node requests once paired", async () => {
    const sock = socketPath();
    // Socket-first (this card): the UDS now serves BOTH the control-plane mint
    // AND the data-plane (query), since a present socket is the default
    // transport for `service: node`. The session header must still be threaded
    // onto the data-plane requests, now arriving over the socket.
    const seenSessionHeaders: Array<string | null> = [];
    const uds = Bun.serve({
      unix: sock,
      fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/control/browser-pairing-code") {
          return Response.json({ pairing_code: "pc" });
        }
        seenSessionHeaders.push(req.headers.get("X-Folddb-Session"));
        return Response.json({ ok: true, results: [], has_more: false });
      },
    });
    track(uds);

    // The pairing-code EXCHANGE still happens over TCP (attestation design,
    // unchanged by socket-first) — only the data plane moved to the socket.
    const tcp = Bun.serve({
      port: 0,
      fetch: () => Response.json({ session_token: "sess-1" }),
    });
    track(tcp);

    const node = newNodeClient({
      baseUrl: `http://127.0.0.1:${tcp.port}`,
      userHash: "uh",
      socketPath: sock,
    });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    // Both queries (over the socket) carried the session token; mint once.
    expect(seenSessionHeaders).toEqual(["sess-1", "sess-1"]);
  });

  test("re-pairs once on 403 transport_not_attested and retries", async () => {
    const sock = socketPath();
    let mintCount = 0;
    // Socket-first: the UDS serves the mint AND the data-plane mutation. The
    // first mutation (over the socket) returns a stale-session 403; the client
    // re-mints over the socket and retries — also over the socket — carrying
    // the fresh token.
    let mutationCalls = 0;
    const uds = Bun.serve({
      unix: sock,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/control/browser-pairing-code") {
          mintCount++;
          return Response.json({ pairing_code: `pc-${mintCount}` });
        }
        if (url.pathname === "/api/mutation") {
          mutationCalls++;
          // First attempt: pretend the in-memory session is stale.
          if (mutationCalls === 1) {
            return Response.json({ error: "transport_not_attested" }, { status: 403 });
          }
          // Retry must carry the freshly re-minted session token.
          expect(req.headers.get("X-Folddb-Session")).toBe("sess-from-pc-2");
          return Response.json({ ok: true });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });
    track(uds);

    // The pairing-code EXCHANGE still goes over TCP (unchanged by socket-first).
    const tcp = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/session/browser-pair") {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ session_token: `sess-from-${body.code as string}` });
        }
        return Response.json({ error: "unexpected" }, { status: 500 });
      },
    });
    track(tcp);

    const node = newNodeClient({
      baseUrl: `http://127.0.0.1:${tcp.port}`,
      userHash: "uh",
      socketPath: sock,
    });
    // Should succeed after the one transparent re-pair + retry.
    await node.createRecord({ schemaHash: "s", fields: { a: 1 }, keyHash: "k" });
    expect(mutationCalls).toBe(2);
    expect(mintCount).toBe(2);
  });

  test("actionable error (not raw 403) when an owner verb 403s un-attested", async () => {
    // App-isolation node: the socket path doesn't exist, so attestation can't
    // mint, and the owner verb keeps returning transport_not_attested.
    const tcp = Bun.serve({
      port: 0,
      fetch: () => Response.json({ error: "transport_not_attested" }, { status: 403 }),
    });
    track(tcp);

    const missingSock = socketPath();
    const node = newNodeClient({
      baseUrl: `http://127.0.0.1:${tcp.port}`,
      userHash: "uh",
      socketPath: missingSock,
    });

    let caught: unknown;
    try {
      await node.loadSchemas();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(FkanbanError);
    const fk = caught as FkanbanError;
    expect(fk.code).toBe("node_attestation_unavailable");
    // The raw folddb token must NOT leak in the message.
    expect(fk.message).not.toContain("transport_not_attested");
    // Names the socket it tried and that no socket exists.
    expect(fk.message).toContain(missingSock);
    expect(fk.message.toLowerCase()).toContain("app-isolation");
    // Hint names both remedies.
    expect(fk.hint).toContain("--node-socket-path");
    expect(fk.hint).toContain("FOLDDB_SOCKET_PATH");
  });

  test("emits a non-verbose warn when the control socket is missing", async () => {
    const tcp = Bun.serve({
      port: 0,
      fetch: () => Response.json({ ok: true, results: [], has_more: false }),
    });
    track(tcp);

    const missingSock = socketPath();
    const warnings: string[] = [];
    const node = newNodeClient({
      baseUrl: `http://127.0.0.1:${tcp.port}`,
      userHash: "uh",
      socketPath: missingSock,
      warn: (m) => warnings.push(m),
    });
    // Two calls: the skip warning must fire exactly once, not per request.
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    expect(warnings.length).toBe(1);
    expect(warnings[0]).toContain(missingSock);
    expect(warnings[0]).toContain("--node-socket-path");
    expect(warnings[0]).toContain("proceeding");
  });

  test("no socket → no token → no session header (unattested, unchanged behavior)", async () => {
    let sessionHeader: string | null = "unset";
    const tcp = Bun.serve({
      port: 0,
      fetch(req) {
        sessionHeader = req.headers.get("X-Folddb-Session");
        return Response.json({ ok: true, results: [], has_more: false });
      },
    });
    track(tcp);
    const node = newNodeClient({ baseUrl: `http://127.0.0.1:${tcp.port}`, userHash: "uh" });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    expect(sessionHeader).toBeNull();
  });
});
