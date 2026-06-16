// One source of truth for the MCP-registration surface that both `fkanban init`
// (Next-steps block) and `fkanban doctor` (entrypoint check) print, so the two
// can never drift. There are two equivalent ways to register the server:
//
//   - shim on PATH:  claude mcp add fkanban -- fkanban mcp
//   - otherwise:     claude mcp add fkanban -- bun <repoRoot>/src/mcp/main.ts
//
// and a matching entrypoint that `claude mcp add` would target:
//   - shim on PATH:  the resolved `fkanban-mcp` (or `fkanban`) bin
//   - otherwise:     <repoRoot>/src/mcp/main.ts

import { fileURLToPath } from "node:url";
import { resolveFkanbanShim } from "../commands/doctor.ts";

// This file lives at <repoRoot>/src/mcp/register.ts.
function repoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return here.replace(/\/src\/mcp\/register\.ts$/, "");
}

// Absolute path to the repo's bundled MCP entrypoint (`src/mcp/main.ts`).
export function mainEntrypointPath(): string {
  return `${repoRoot()}/src/mcp/main.ts`;
}

// The `claude mcp add` line that will actually work for THIS dev: with the
// global `fkanban` shim on PATH use the short form, otherwise point bun at this
// repo's MCP entrypoint (mirrors the two forms in src/mcp/main.ts + README).
export function mcpAddCommand(): string {
  if (resolveFkanbanShim()) {
    return "claude mcp add fkanban -- fkanban mcp";
  }
  return `claude mcp add fkanban -- bun ${mainEntrypointPath()}`;
}

// The MCP entrypoint `claude mcp add` would target, resolved for THIS dev:
//   - shim on PATH → the installed `fkanban-mcp` bin (else the `fkanban` shim
//     itself, which serves `fkanban mcp`)
//   - otherwise    → this repo's `src/mcp/main.ts`
// Returns `null` only if neither resolves. Each result is a real path on disk
// so callers can confirm it exists.
export function mcpEntrypointPath(): string | null {
  if (resolveFkanbanShim()) {
    const mcpBin = resolveBin("fkanban-mcp");
    if (mcpBin) return mcpBin;
    // No dedicated `fkanban-mcp` bin, but the `fkanban` shim is on PATH and
    // serves the same server via `fkanban mcp` — point at it.
    return resolveFkanbanShim();
  }
  return mainEntrypointPath();
}

// Resolve a bin name on PATH, or `null` if it doesn't resolve.
function resolveBin(name: string): string | null {
  try {
    const which = Bun.spawnSync(["sh", "-c", `command -v ${name}`]);
    const out = which.stdout.toString().trim();
    if (which.exitCode === 0 && out) return out;
  } catch {
    // `command -v` unavailable — treat as not found.
  }
  return null;
}
