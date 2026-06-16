#!/usr/bin/env bun
// fkanban MCP server entrypoint — speaks the Model Context Protocol over
// stdio. Register with Claude Code:
//   claude mcp add fkanban bun /path/to/fkanban/src/mcp/main.ts
// or, after install, via the `fkanban-mcp` bin:
//   claude mcp add fkanban fkanban-mcp
//
// Reads ~/.fkanban/config.json (same as the CLI). The server starts
// UNCONDITIONALLY: even on a missing or invalid config it completes the MCP
// handshake and lists its tools, so the client connects instead of seeing an
// opaque "failed to connect". When config is unavailable, each config-dependent
// tool short-circuits to a clean `isError` result with the actionable
// "Run `fkanban init` first." hint, and `fkanban_doctor` still runs so an agent
// can self-diagnose. This matches the install→use order in the README, where a
// new dev may `claude mcp add fkanban …` BEFORE `fkanban init`.

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

import { readConfig, resolveSocketPath, ConfigMissingError, ConfigInvalidError } from "../config.ts";
import { newNodeClient } from "../client.ts";
import { createFkanbanMcpServer } from "./server.ts";

export async function runMcp(): Promise<number> {
  let cfg;
  try {
    cfg = readConfig();
  } catch (err) {
    if (err instanceof ConfigMissingError || err instanceof ConfigInvalidError) {
      // Start in the not-yet-configured state instead of bailing out: the
      // handshake + listTools must succeed so the client connects, then tools
      // degrade gracefully to a "Run `fkanban init` first." error per call.
      const server = createFkanbanMcpServer({ configError: err });
      const transport = new StdioServerTransport();
      await server.connect(transport);
      return 0;
    }
    throw err;
  }

  const node = newNodeClient({ baseUrl: cfg.nodeUrl, userHash: cfg.userHash, socketPath: resolveSocketPath(cfg) });
  const server = createFkanbanMcpServer({ cfg, node });
  const transport = new StdioServerTransport();
  await server.connect(transport);
  return 0;
}

if (import.meta.main) {
  runMcp().then(
    (code) => {
      if (code !== 0) process.exit(code);
    },
    (err) => {
      console.error(err);
      process.exit(1);
    },
  );
}
