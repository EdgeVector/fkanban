// Regression test for the `fkanban mcp` CLI subcommand entrypoint
// (src/cli.ts → startMcpServer in src/mcp/server.ts).
//
// The in-memory tests in mcp.test.ts drive `createFkanbanMcpServer` directly,
// which doesn't exercise the part that actually broke: `startMcpServer` calling
// `readConfig()` and bailing out BEFORE the handshake on a missing/invalid
// config (PR #29 only fixed `runMcp` in main.ts, leaving the CLI subcommand
// path dead). So here we spawn the REAL CLI subcommand over a real
// StdioClientTransport with a bogus FKANBAN_CONFIG and assert the server still
// connects, lists all 12 tools, and degrades each config-dependent tool to a
// clean per-call `isError` "Run `fkanban init` first." — matching the
// `fkanban-mcp` bin.
//
// StdioClientTransport does NOT forward the parent process env unless you pass
// `env` explicitly, so we pass `{ ...process.env, FKANBAN_CONFIG }`.

import { afterEach, describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, "../src/cli.ts");
const bun = process.execPath; // the `bun` binary running this test

// A path that does not exist, so `readConfig()` throws ConfigMissingError.
const BOGUS_CONFIG = "/nonexistent/fkanban-cli-mcp-test/config.json";

async function connectViaCliSubcommand(): Promise<{ client: Client; close: () => Promise<void> }> {
  const transport = new StdioClientTransport({
    command: bun,
    args: [cliPath, "mcp"],
    env: { ...(process.env as Record<string, string>), FKANBAN_CONFIG: BOGUS_CONFIG },
  });
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(transport);
  return { client, close: () => client.close() };
}

describe("`fkanban mcp` CLI subcommand starts gracefully on a missing config", () => {
  let close: (() => Promise<void>) | undefined;

  afterEach(async () => {
    if (close) await close();
    close = undefined;
  });

  test("connect succeeds and listTools returns all 15 tools", async () => {
    const { client, close: c } = await connectViaCliSubcommand();
    close = c;
    const { tools } = await client.listTools();
    expect(tools).toHaveLength(15);
  });

  test("fkanban_list returns isError with the actionable 'run init' hint", async () => {
    const { client, close: c } = await connectViaCliSubcommand();
    close = c;
    const res = await client.callTool({ name: "fkanban_list", arguments: {} });
    expect(res.isError).toBe(true);
    const text = (res.content as Array<{ type: string; text: string }>)[0]?.text ?? "";
    expect(text).toContain("Run `fkanban init` first.");
  });

  test("a write tool also short-circuits to the same actionable hint", async () => {
    const { client, close: c } = await connectViaCliSubcommand();
    close = c;
    const res = await client.callTool({ name: "fkanban_add", arguments: { slug: "x" } });
    expect(res.isError).toBe(true);
    expect((res.content as Array<{ type: string; text: string }>)[0]?.text ?? "").toContain(
      "Run `fkanban init` first.",
    );
  });
});
