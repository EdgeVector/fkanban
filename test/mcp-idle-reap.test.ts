// The MCP idle-reaper: an fkanban MCP server that receives no request for the
// idle window must exit itself. This bounds the leak where a host (observed:
// Codex's app-server) spawns a server, abandons it, but keeps the stdio pipe
// OPEN — so `transport.onclose` (stdin EOF) never fires and the server lingers
// for days. On the next tool call the host respawns one, so the reap is
// transparent.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_MCP_IDLE_TIMEOUT_MS,
  makeIdleReaper,
  mcpIdleTimeoutMs,
} from "../src/mcp/server.ts";

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("mcpIdleTimeoutMs", () => {
  const KEY = "FKANBAN_MCP_IDLE_TIMEOUT_MS";
  function withEnv(val: string | undefined, fn: () => void): void {
    const prev = process.env[KEY];
    if (val === undefined) delete process.env[KEY];
    else process.env[KEY] = val;
    try {
      fn();
    } finally {
      if (prev === undefined) delete process.env[KEY];
      else process.env[KEY] = prev;
    }
  }

  test("defaults to 30 minutes when unset", () => {
    withEnv(undefined, () => {
      expect(mcpIdleTimeoutMs()).toBe(DEFAULT_MCP_IDLE_TIMEOUT_MS);
      expect(DEFAULT_MCP_IDLE_TIMEOUT_MS).toBe(30 * 60 * 1000);
    });
  });

  test("honors a numeric override", () => {
    withEnv("60000", () => expect(mcpIdleTimeoutMs()).toBe(60000));
  });

  test("a non-numeric value falls back to the default", () => {
    withEnv("banana", () => expect(mcpIdleTimeoutMs()).toBe(DEFAULT_MCP_IDLE_TIMEOUT_MS));
  });

  test("0 (or negative) is honored verbatim so the caller can disable", () => {
    withEnv("0", () => expect(mcpIdleTimeoutMs()).toBe(0));
    withEnv("-1", () => expect(mcpIdleTimeoutMs()).toBe(-1));
  });
});

describe("makeIdleReaper", () => {
  test("fires onIdle after the window when never touched", async () => {
    let fired = 0;
    const r = makeIdleReaper({ idleMs: 20, onIdle: () => fired++ });
    expect(r.enabled).toBe(true);
    r.touch(); // start the clock
    await sleep(50);
    expect(fired).toBe(1);
  });

  test("each touch resets the clock — staying active never reaps", async () => {
    let fired = 0;
    const r = makeIdleReaper({ idleMs: 40, onIdle: () => fired++ });
    r.touch();
    for (let i = 0; i < 4; i++) {
      await sleep(20); // < idleMs each time
      r.touch();
    }
    expect(fired).toBe(0); // never went idle long enough
    r.stop();
  });

  test("stop() cancels a pending reap", async () => {
    let fired = 0;
    const r = makeIdleReaper({ idleMs: 20, onIdle: () => fired++ });
    r.touch();
    r.stop();
    await sleep(50);
    expect(fired).toBe(0);
  });

  test("a non-positive idleMs disables the reaper entirely", async () => {
    let fired = 0;
    const r = makeIdleReaper({ idleMs: 0, onIdle: () => fired++ });
    expect(r.enabled).toBe(false);
    r.touch();
    await sleep(30);
    expect(fired).toBe(0);
  });
});
