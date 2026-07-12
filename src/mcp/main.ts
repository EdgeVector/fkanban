#!/usr/bin/env bun
// kanban MCP server entrypoint — speaks the Model Context Protocol over
// stdio. Register with Claude Code (the `--` separates the `claude mcp add`
// flags from the command it should run):
//   claude mcp add fkanban -- bun /path/to/kanban/src/mcp/main.ts
// or, with the global `kanban` shim on PATH, via the `kanban mcp` subcommand:
//   claude mcp add fkanban -- kanban mcp
//
// Reads ~/.kanban/config.json (same as the CLI, with old-path fallback). The server starts
// UNCONDITIONALLY: even on a missing or invalid config it completes the MCP
// handshake and lists its tools, so the client connects instead of seeing an
// opaque "failed to connect". When config is unavailable, each config-dependent
// tool short-circuits to a clean `isError` result with the actionable
// "Run `kanban init` first." hint, and `fkanban_doctor` still runs so an agent
// can self-diagnose. This matches the install→use order in the README, where a
// new dev may `claude mcp add fkanban …` BEFORE `kanban init`.

import { startMcpServer } from "./server.ts";

// The `kanban-mcp` and `fkanban-mcp` bins delegate to the single `startMcpServer` implementation
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
