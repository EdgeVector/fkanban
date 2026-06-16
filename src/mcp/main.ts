#!/usr/bin/env bun
// fkanban MCP server entrypoint — speaks the Model Context Protocol over
// stdio. Register with Claude Code:
//   claude mcp add fkanban bun /path/to/fkanban/src/mcp/main.ts
// or, after install, via the `fkanban-mcp` bin:
//   claude mcp add fkanban fkanban-mcp
//
// Reads ~/.fkanban/config.json (same as the CLI). On a missing or invalid
// config it prints a single clean `fkanban mcp: <message>` line and exits
// non-zero so the error surfaces in the MCP client logs without a stack trace.

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
      console.error(`fkanban mcp: ${err.message}`);
      return 1;
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
