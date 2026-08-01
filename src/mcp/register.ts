// One source of truth for the MCP-registration surface that both `kanban init`
// (Next-steps block) and `kanban doctor` (entrypoint check) print, so the two
// can never drift. There are two equivalent ways to register the server:
//
//   - shim on PATH:  claude mcp add fkanban -- kanban mcp
//   - otherwise:     claude mcp add fkanban -- bun <repoRoot>/src/mcp/main.ts
//
// and a matching entrypoint that `claude mcp add` would target:
//   - shim on PATH:  that same shim bin — the one the `--` form invokes
//   - otherwise:     <repoRoot>/src/mcp/main.ts
//
// "Can never drift" is a claim about BOTH functions, so each branch of
// `mcpEntrypointPath()` reads its answer off the branch of `mcpAddCommand()`
// that prints the command. Resolving the entrypoint independently is what let
// a 192-commit-stale `kanban-mcp` collect a doctor ✓ — see the note there.

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
//   - shim on PATH → that same shim, because `mcpAddCommand()` emits
//     `-- <shim.name> mcp` and `<shim.name>` is the file that gets executed
//   - otherwise    → this repo's `src/mcp/main.ts`, the file the bun+path form
//     names verbatim
// Returns `null` only if neither resolves. Each result is a real path on disk
// so callers can confirm it exists.
//
// ## Why this must not resolve `kanban-mcp`, even when one is installed
//
// This used to prefer a dedicated `kanban-mcp`/`fkanban-mcp` bin over the CLI
// shim. Nothing ever RUNS that bin: `mcpAddCommand()` emits `<shim.name> mcp`
// in this branch and always has, so the entrypoint doctor verified and the
// entrypoint the register line starts were two different files that only
// happened to serve the same code. The moment they diverge, doctor certifies
// the one nobody runs.
//
// They diverged. `bin/host-track-refresh` bakes an ABSOLUTE `host_track` root
// into each shim it writes, and the shim's only self-check is `[ -f $expected ]`
// — existence, which a stale-but-present checkout satisfies forever. When the
// host-track layout moved to `apps/fkanban/current`, the CLI shim was rewritten
// by last-stack's safe-upgrade installer and `kanban-mcp` was not; it still
// pointed at the pre-migration `~/.host-track/fkanban`, a directory host-track
// no longer tracks and `host-track refresh kanban` therefore never updates
// (its own error message recommends exactly that no-op repair). Measured on
// this machine 2026-08-01: `kanban` served 93efa336 while `kanban-mcp` served
// 48418d0 — **192 commits and 10 days apart** — and doctor printed
// `✓ MCP entrypoint resolves` for the stale one, because `existsSync` cannot
// tell current from abandoned. That tree predates the membership fixes; its
// `deleteCardRecord` never touches MilestoneCards at all, which is the bug
// measured at 66 orphan rows.
//
// The durable repair is to stop having two answers. The entrypoint is, by
// definition, whatever the printed register command executes — so derive it
// from the same branch that prints the command rather than re-resolving it
// independently and hoping the two agree.
export function mcpEntrypointPath(): string | null {
  const shim = resolveKanbanShim();
  // `mcpAddCommand()` → `claude mcp add fkanban -- <shim.name> mcp`, and
  // `shim.path` is where PATH resolves `<shim.name>`. Same file, by construction.
  if (shim) return shim.path;
  return mainEntrypointPath();
}
