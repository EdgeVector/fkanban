// One source of truth for the MCP-registration surface that both `kanban init`
// (Next-steps block) and `kanban doctor` (entrypoint check) print, so the two
// can never drift. There are two equivalent ways to register the server:
//
//   - shim on PATH:  claude mcp add fkanban -- kanban mcp
//   - otherwise:     claude mcp add fkanban -- bun <repoRoot>/src/mcp/main.ts
//
// and a matching entrypoint that `claude mcp add` would target:
//   - shim on PATH:  the resolved `kanban-mcp` (or `kanban`) bin
//   - otherwise:     <repoRoot>/src/mcp/main.ts

import { fileURLToPath } from "node:url";
import { resolveKanbanShim } from "../commands/doctor.ts";

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
// global `kanban` shim on PATH use the short form, otherwise point bun at this
// repo's MCP entrypoint (mirrors the two forms in src/mcp/main.ts + README).
export function mcpAddCommand(): string {
  const shim = resolveKanbanShim();
  if (shim) {
    return `claude mcp add fkanban -- ${shim.name} mcp`;
  }
  return `claude mcp add fkanban -- bun ${mainEntrypointPath()}`;
}

// The command prefix that runs kanban for THIS dev: the global `kanban` shim if
// it's on PATH, otherwise the compatibility `fkanban` shim, else
// `bun run src/cli.ts` from the repo. Mirrors the
// shim-branching in mcpAddCommand() so init's Next-steps `list`/`add` lines (and
// doctor) print commands that actually run on a shim-less fresh clone — where
// `command -v kanban` is empty until `bun run install-cli`.
export function fkanbanInvocation(): string {
  const shim = resolveKanbanShim();
  if (shim?.name) return shim.name;
  return "bun run src/cli.ts";
}

// The MCP entrypoint `claude mcp add` would target, resolved for THIS dev:
//   - shim on PATH → the installed `kanban-mcp` bin (else the `kanban` shim
//     itself, which serves `kanban mcp`)
//   - otherwise    → this repo's `src/mcp/main.ts`
// Returns `null` only if neither resolves. Each result is a real path on disk
// so callers can confirm it exists.
export function mcpEntrypointPath(): string | null {
  const shim = resolveKanbanShim();
  if (shim) {
    const mcpBin = resolveBin("kanban-mcp") ?? resolveBin("fkanban-mcp");
    if (mcpBin) return mcpBin;
    // No dedicated MCP bin, but the CLI shim is on PATH and serves the same
    // server via `<shim> mcp` — point at it.
    return shim.path;
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
