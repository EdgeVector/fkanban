// Where is THIS process's code installed from, and is it the build that's
// currently installed?
//
// One source of truth for both readers of that question — `kanban which` (which
// reports the install root) and `kanban doctor` (which must qualify its own
// verdicts). They used to be the same question asked once, by `which`, and only
// about *containment*: "is my source under a host-track root?". Containment is
// satisfied forever by any version directory that was ever installed, so it
// cannot distinguish the current build from a superseded one.
//
// ## Why the distinction is load-bearing rather than cosmetic
//
// The host-track shim (`~/.local/bin/kanban`) resolves `<root>/current` with
// `cd -P` at EXEC time and hands bun the PHYSICAL path it resolved to:
//
//     exec bun ~/.host-track/apps/fkanban/versions/<oid>/src/cli.ts …
//
// For a one-shot CLI invocation that is exactly right — every run re-resolves
// `current`, so the CLI is never stale. For `kanban mcp`, which runs for the
// life of an agent session, it means the process keeps serving the version
// directory it was started on. `host-track refresh` moves a symlink; it cannot
// move a process that already dereferenced it. One MCP server runs per agent
// session, so several vintages are routinely live at once.
//
// Measured on this machine 2026-08-05: with four MCP servers spawned on
// `7577697d` and `current` moved to `fc384019`, `kanban doctor` (CLI) exited 0
// with zero `✗` while `fkanban_doctor` (MCP) returned `✗ milestone_cards pin
// identity` and set `isError` — same machine, same config, same minute. The
// stale server predated the config field that acknowledges that deviation, so
// it reported an acknowledged deviation as a failure. The MCP server's own
// instructions make `fkanban_doctor` an agent's FIRST move on any board
// trouble, which puts the stalest surface first in line to be believed.
//
// See brain
// `papercut-kanban-mcp-server-pins-a-version-path-at-spawn-so-refresh-never-reaches-it`.

import * as fs from "node:fs";
import { isAbsolute, relative } from "node:path";

export function realpathOrSelf(path: string): string {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * Host-track install roots for fkanban/kanban.
 *
 * Prefer the Kind B local-safe layout used by host-track apps.json after the
 * 2026-07 portal cutover:
 *   ~/.host-track/apps/fkanban/{current,versions/<oid>}
 * Keep accepting the legacy checkout path for older machines:
 *   ~/.host-track/fkanban
 *
 * Override: FKANBAN_HOST_TRACK_DIR (or HOST_TRACK_ROOT for the whole tree root).
 */
export function hostTrackInstallRoots(): string[] {
  const home = process.env.HOME ?? "";
  const roots: string[] = [];
  const seen = new Set<string>();
  const push = (p: string) => {
    if (!p) return;
    const real = fs.existsSync(p) ? realpathOrSelf(p) : p;
    if (seen.has(real)) return;
    seen.add(real);
    roots.push(real);
  };

  const override = process.env.FKANBAN_HOST_TRACK_DIR?.trim();
  if (override) {
    push(override);
    return roots;
  }

  // Broad HOST_TRACK_ROOT (e.g. ~/.host-track) still counts as managed.
  const hostTrackRoot = process.env.HOST_TRACK_ROOT?.trim();
  if (hostTrackRoot) push(hostTrackRoot);

  if (home) {
    // Preferred: local-safe install root (contains current + versions/*)
    push(`${home}/.host-track/apps/fkanban`);
    // Legacy durable checkout (pre apps/ layout)
    push(`${home}/.host-track/fkanban`);
  }
  return roots;
}

/** Preferred/advertised host-track root for which output. */
export function expectedHostTrackRoot(): string {
  const home = process.env.HOME ?? "";
  const roots = hostTrackInstallRoots().filter((r) => fs.existsSync(r));
  if (roots.length > 0) return roots[0]!;
  if (home) return `${home}/.host-track/apps/fkanban`;
  return "";
}

export function pathWithin(path: string, root: string): boolean {
  if (!path || !root) return false;
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

export function pathWithinAnyHostTrack(path: string): { ok: boolean; root: string } {
  const roots = hostTrackInstallRoots();
  for (const root of roots) {
    if (pathWithin(path, root)) return { ok: true, root };
  }
  return { ok: false, root: expectedHostTrackRoot() };
}

/**
 * Which build is running, and is it the installed one?
 *
 *   - `unmanaged` — the source is not under any host-track root. A dev
 *     worktree, a fresh clone, `bun run src/cli.ts`. There is no `current` to
 *     be behind, so staleness is not a meaningful question and this never
 *     reports a problem.
 *   - `current`   — running the exact directory `<root>/current` resolves to.
 *   - `superseded` — running a host-track version directory that `current` no
 *     longer points at. Only a long-lived process can reach this state (or a
 *     one-shot invocation racing a refresh), and the remedy is to restart it.
 *   - `indeterminate` — under a host-track root, but `current` is missing or
 *     unreadable, so the comparison cannot be made. Deliberately NOT folded
 *     into `current`: an unresolvable tip must fail toward "check this",
 *     never toward "you're up to date".
 *
 * `build` / `currentBuild` are the version-directory basenames (the commit oid
 * host-track names each install after), or null when the layout has no
 * `versions/<oid>` directory — e.g. the legacy flat checkout, where the root
 * itself is the tree.
 */
export type RunningBuild = {
  status: "current" | "superseded" | "unmanaged" | "indeterminate";
  /** realpath of the directory this process's source tree lives in */
  sourceRoot: string;
  /** the host-track app root containing sourceRoot, or null when unmanaged */
  installRoot: string | null;
  /** realpath of `<installRoot>/current`, or null when unresolvable */
  currentRoot: string | null;
  /** version-directory name for sourceRoot (commit oid), or null */
  build: string | null;
  /** version-directory name for currentRoot (commit oid), or null */
  currentBuild: string | null;
};

// The version-directory name host-track installs under (`versions/<oid>`), or
// null for any other shape. Read off the path rather than from git, so it works
// in an install that has no `.git`.
function buildIdOf(root: string | null): string | null {
  if (!root) return null;
  const m = /\/versions\/([^/]+)$/.exec(root);
  return m ? m[1]! : null;
}

/**
 * Resolve the running build for a source tree. `sourceRootInput` is the
 * repo/install root of the code that is executing — callers pass their own
 * `import.meta.url`-derived root so this reports the tree that is actually
 * loaded, not whatever `command -v kanban` would resolve today.
 */
export function resolveRunningBuild(sourceRootInput: string): RunningBuild {
  const sourceRoot = realpathOrSelf(sourceRootInput);
  const match = pathWithinAnyHostTrack(sourceRoot);
  if (!match.ok) {
    return {
      status: "unmanaged",
      sourceRoot,
      installRoot: null,
      currentRoot: null,
      build: buildIdOf(sourceRoot),
      currentBuild: null,
    };
  }

  const installRoot = match.root;
  const currentLink = `${installRoot}/current`;
  const currentRoot = fs.existsSync(currentLink) ? realpathOrSelf(currentLink) : null;
  const build = buildIdOf(sourceRoot);
  const currentBuild = buildIdOf(currentRoot);

  // No `current` at all: the legacy flat checkout layout, or a partially
  // installed root. Nothing to compare against — say so rather than implying
  // freshness we did not verify.
  if (!currentRoot) {
    return { status: "indeterminate", sourceRoot, installRoot, currentRoot, build, currentBuild };
  }

  const status = currentRoot === sourceRoot ? "current" : "superseded";
  return { status, sourceRoot, installRoot, currentRoot, build, currentBuild };
}

/** Short display form for a build: the oid, abbreviated, or the raw path. */
export function shortBuild(build: string | null, fallback: string | null): string {
  if (build) return build.length > 12 ? build.slice(0, 12) : build;
  return fallback ?? "unknown";
}
