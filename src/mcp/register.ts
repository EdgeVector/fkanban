// One source of truth for the MCP-registration surface that both `kanban init`
// (Next-steps block) and `kanban doctor` (entrypoint check) print, so the two
// can never drift. There are three ways this CLI can be registered, and which
// one is honest depends on how the code asking the question was PACKAGED:
//
//   - shim on PATH:     claude mcp add fkanban -- kanban mcp
//   - compiled artifact: claude mcp add fkanban -- <execPath> mcp
//   - source checkout:  claude mcp add fkanban -- bun <repoRoot>/src/mcp/main.ts
//
// and a matching entrypoint that `claude mcp add` would target:
//   - shim on PATH:      that same shim bin — the one the `--` form invokes
//   - compiled artifact: the executable itself — it IS the entrypoint
//   - source checkout:   <repoRoot>/src/mcp/main.ts
//
// "Can never drift" is a claim about ALL of these, so every exported function
// reads its answer off ONE `resolveRegistration()` call rather than
// re-deriving it. Resolving the entrypoint independently is what let a
// 192-commit-stale `kanban-mcp` collect a doctor ✓ — see the note on
// `mcpEntrypointPath()`.
//
// ## Why there is a compiled branch at all
//
// This module used to have two, and derived the repo root from its own module
// URL:
//
//   fileURLToPath(import.meta.url).replace(/\/src\/mcp\/register\.ts$/, "")
//
// which is correct for a source install and meaningless for the artifact that
// actually ships. `scripts/build-artifact.sh` has produced `bun build
// --compile` executables since 2026-07-22; inside one, every module URL
// resolves into the executable's embedded filesystem, the regex does not
// match, and the root becomes `/$bunfs/root/kanban` — a path in no filesystem.
// Measured 2026-08-06 on the shipped shape, with no shim on PATH:
//
//   claude mcp add fkanban -- bun /$bunfs/root/kanban/src/mcp/main.ts
//
// a registration line that cannot work, printed by the two surfaces whose
// entire job is to tell you how to register (`init`'s Next steps and
// `doctor`'s entrypoint check) — i.e. exactly when the reader is least able to
// tell the command is impossible. The no-shim branch is not a fresh-install
// curiosity here: sandboxed Bash on this machine loses `$PATH`, so
// `resolveKanbanShim()` comes back empty inside routine runs on a machine
// where the shim is installed and fine.
//
// Under the artifact the honest answer is not `bun <file>` at all — the binary
// is the CLI, and `<execPath> mcp` is the same `mcp` subcommand the shim form
// invokes.

import { fileURLToPath } from "node:url";
import { resolveKanbanShim } from "../commands/doctor.ts";
import { isOnDisk, resolveRunningBuild } from "../host_track.ts";

// This file lives at <repoRoot>/src/mcp/register.ts — when there is a repo. The
// caller must treat the result as a candidate, not a fact: see `moduleRepoRoot`
// use in `resolveRegistration()`.
function moduleRepoRoot(): string {
  const here = fileURLToPath(import.meta.url);
  return here.replace(/\/src\/mcp\/register\.ts$/, "");
}

/**
 * The path to REGISTER for a compiled executable — which is not always the path
 * it is running from.
 *
 * `process.execPath` is fully resolved: symlinks and all. Under a host-track
 * install that means `<root>/versions/<oid>/dist/kanban`, never the
 * `<root>/current/dist/kanban` symlink the user actually invoked. Registering
 * the resolved form would pin the MCP server to one version directory and
 * guarantee it goes stale at the next upgrade — which is the precise failure
 * this module already carries a long note about, where a `kanban-mcp` frozen
 * against a superseded tree kept a doctor ✓ for 192 commits. A registration
 * that silently stops tracking `current` is that bug, re-created by the surface
 * meant to prevent it.
 *
 * So when the running build IS `current`, name the stable path. Only then: a
 * SUPERSEDED binary must keep naming itself, because `current` is a different
 * file, and quietly registering something other than what is running is the
 * same dishonesty pointed the other way. `resolveRunningBuild` makes that
 * distinction already — asked here rather than re-derived, for the usual
 * reason.
 */
function upgradeStablePath(moduleRoot: string, execPath: string): string {
  const running = resolveRunningBuild(moduleRoot, execPath);
  if (running.status !== "current" || !running.installRoot || !running.runningRoot) return execPath;
  if (!execPath.startsWith(`${running.runningRoot}/`)) return execPath;

  const suffix = execPath.slice(running.runningRoot.length + 1);
  const stable = `${running.installRoot}/current/${suffix}`;
  // `current` is a symlink, so this is the same inode by construction — but
  // confirm rather than assume, and fall back to the path we know executes.
  return isOnDisk(stable) ? stable : execPath;
}

type Registration = {
  // How this process is packaged — the branch every field below came from.
  shape: "shim" | "compiled" | "source";
  // The full `claude mcp add …` line that will actually work for THIS dev.
  command: string;
  // The file that command executes. Always a real path on disk, so doctor's
  // existence check is checking the file that will be served.
  entrypoint: string;
  // How to invoke the CLI itself (for init's `list`/`add` hint lines).
  invocation: string;
};

/**
 * Resolve all four answers together, once, from one branch decision.
 *
 * The discriminator is `isOnDisk` from src/host_track.ts — deliberately the
 * same predicate that module uses to identify the running tree, not a copy.
 * NOT `existsSync`, and not `statSync`: measured 2026-08-06, both SUCCEED for a
 * module inside a compiled binary's embedded filesystem (it stats clean, with
 * `ino=0 dev=0`), so a guard built on either is a no-op that looks like a fix.
 */
function resolveRegistration(execPath: string = process.execPath): Registration {
  const shim = resolveKanbanShim();
  if (shim) {
    // `shim.path` is where PATH resolves `<shim.name>`, so the command and the
    // entrypoint name the same file by construction.
    return {
      shape: "shim",
      command: `claude mcp add fkanban -- ${shim.name} mcp`,
      entrypoint: shim.path,
      invocation: shim.name,
    };
  }

  const repoRoot = moduleRepoRoot();
  if (!isOnDisk(repoRoot)) {
    // Compiled artifact: there is no source tree to point `bun` at, and no
    // need for one — this executable serves `mcp` itself.
    const exe = upgradeStablePath(repoRoot, execPath);
    return {
      shape: "compiled",
      command: `claude mcp add fkanban -- ${exe} mcp`,
      entrypoint: exe,
      invocation: exe,
    };
  }

  // Source checkout with no shim yet — the fresh-clone default, before
  // `bun run install-cli`.
  const main = `${repoRoot}/src/mcp/main.ts`;
  return {
    shape: "source",
    command: `claude mcp add fkanban -- bun ${main}`,
    entrypoint: main,
    invocation: "bun run src/cli.ts",
  };
}

// `mainEntrypointPath()` used to live here, returning `<repoRoot>/src/mcp/main.ts`
// unconditionally. It was removed rather than fixed: it had no callers in src,
// test, scripts, bin or docs, and it was a FOURTH answer to the question this
// module exists to answer exactly once — one that stayed wrong under the
// compiled artifact in both PATH conditions, hidden from view only because the
// shim branch of `mcpAddCommand()` never printed it. Ask
// `mcpEntrypointPath()` instead.

// The `claude mcp add` line that will actually work for THIS dev.
export function mcpAddCommand(execPath: string = process.execPath): string {
  return resolveRegistration(execPath).command;
}

// The command prefix that runs kanban for THIS dev: the global `kanban` shim if
// it's on PATH, the executable under the compiled artifact, else `bun run
// src/cli.ts` from the repo. Shares `resolveRegistration()` with
// `mcpAddCommand()` so init's Next-steps `list`/`add` lines (and doctor) print
// commands that actually run — on a shim-less fresh clone, where `command -v
// kanban` is empty until `bun run install-cli`, AND on the shipped binary,
// where `bun run src/cli.ts` names a file that does not exist.
export function fkanbanInvocation(execPath: string = process.execPath): string {
  return resolveRegistration(execPath).invocation;
}

// The MCP entrypoint `claude mcp add` would target, resolved for THIS dev — the
// file the command from `mcpAddCommand()` executes, taken from the same
// resolution rather than derived a second time. Every shape yields a real path
// on disk, so callers can confirm it exists.
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
// from the same resolution that prints the command rather than re-resolving it
// independently and hoping the two agree.
//
// Returns `string | null` for callers written against the older signature; it
// is never null today, because every branch resolves.
export function mcpEntrypointPath(execPath: string = process.execPath): string | null {
  return resolveRegistration(execPath).entrypoint;
}

// The packaging shape the registration surface resolved — exported so tests can
// assert WHICH branch a given process took, rather than inferring it from the
// printed string and re-implementing the branch logic to do so.
export function registrationShape(execPath: string = process.execPath): Registration["shape"] {
  return resolveRegistration(execPath).shape;
}
