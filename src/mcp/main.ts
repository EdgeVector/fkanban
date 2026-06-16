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

import { startMcpServer } from "./server.ts";

// The `fkanban-mcp` bin delegates to the single `startMcpServer` implementation
// shared with the `fkanban mcp` CLI subcommand, so the two entrypoints can never
// diverge. `startMcpServer` reads config, starts gracefully on a missing/invalid
// config (handshake succeeds, tools degrade per call), and stays alive until the
// stdio transport closes.
export async function runMcp(): Promise<number> {
  await startMcpServer();
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
