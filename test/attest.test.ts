// Owner-session attestation tests: mint over a Unix-domain control socket,
// exchange over TCP for a session token, attach X-Folddb-Session to every node
// request, and re-pair once on a 403 transport_not_attested. The unattested
// fallback (no socket) is covered too — that's the device-trust :9001 path.

import { afterEach, describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { attestOwnerSession, newNodeClient } from "../src/client.ts";

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
    const uds = Bun.serve({ unix: sock, fetch: () => Response.json({ pairing_code: "pc" }) });
    track(uds);

    const seenSessionHeaders: Array<string | null> = [];
    const tcp = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/session/browser-pair") {
          return Response.json({ session_token: "sess-1" });
        }
        seenSessionHeaders.push(req.headers.get("X-Folddb-Session"));
        return Response.json({ ok: true, results: [], has_more: false });
      },
    });
    track(tcp);

    const node = newNodeClient({
      baseUrl: `http://127.0.0.1:${tcp.port}`,
      userHash: "uh",
      socketPath: sock,
    });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    await node.queryAll({ schemaHash: "s", fields: ["slug"] });
    // Both queries carried the session token; mint happened exactly once.
    expect(seenSessionHeaders).toEqual(["sess-1", "sess-1"]);
  });

  test("re-pairs once on 403 transport_not_attested and retries", async () => {
    const sock = socketPath();
    let mintCount = 0;
    const uds = Bun.serve({
      unix: sock,
      fetch() {
        mintCount++;
        return Response.json({ pairing_code: `pc-${mintCount}` });
      },
    });
    track(uds);

    let mutationCalls = 0;
    const tcp = Bun.serve({
      port: 0,
      async fetch(req) {
        const url = new URL(req.url);
        if (url.pathname === "/api/session/browser-pair") {
          const body = (await req.json()) as Record<string, unknown>;
          return Response.json({ session_token: `sess-from-${body.code as string}` });
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
