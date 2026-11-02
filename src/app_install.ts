// Resolve the running source version against the registry current link.
import * as fs from "node:fs";
import { isAbsolute, relative } from "node:path";

export function realpathOrSelf(path: string): string {
  try {
    return fs.realpathSync.native(path);
  } catch {
    return path;
  }
}

/** Registry root for this app. Version identity distinguishes long-lived MCP processes. */
export function registryInstallRoots(): string[] {
  const root = process.env.LASTDB_APPS_ROOT ?? `${process.env.HOME ?? ""}/.local/share/lastdb-apps`;
  return [realpathOrSelf(`${root}/kanban`)];
}

export function expectedRegistryRoot(): string {
  return registryInstallRoots()[0] ?? "";
}

export function pathWithin(path: string, root: string): boolean {
  if (!path || !root) return false;
  const rel = relative(root, path);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/**
 * The `<root>/versions/<oid>` ancestor of a path — the unit registry installs
 * and that `current` points at — or null when the path has no such ancestor
 * (a legacy flat checkout, a dev worktree).
 *
 * Needed because the two install shapes run from different DEPTHS of the same
 * installed tree: a source pack runs `versions/<oid>/src/cli.ts` (the version
 * directory itself) while the compiled artifact runs `versions/<oid>/dist/kanban`
 * (two levels down). Both must compare equal to `realpath(<root>/current)`,
 * which always names the version directory.
 */
export function versionRootOf(path: string | null): string | null {
  if (!path) return null;
  const m = /^(.*\/versions\/[^/]+)(?:\/.*)?$/.exec(path);
  return m ? m[1]! : null;
}

/**
 * Can this path be resolved to a real location on disk?
 *
 * NOT `existsSync`, and not `statSync` either — measured 2026-08-06, both
 * SUCCEED for a module inside a compiled binary's embedded filesystem
 * (`/$bunfs/root/kanban` stats clean, with `ino=0 dev=0`). An `existsSync`
 * gate here is a no-op that looks like a fix. `realpathSync.native` is the one
 * call that distinguishes them: it throws ENOENT on the embedded path and
 * resolves on a real one.
 *
 * That is also the property the caller actually needs. An install root has to
 * be a real directory that `current` can point at; a path that resolves to
 * nothing cannot be one, whatever the reason.
 *
 * Exported because `src/mcp/register.ts` needs the SAME question answered about
 * its own module URL, and a second copy of this predicate is exactly the drift
 * this module keeps being bitten by. One definition, several readers.
 */
export function isOnDisk(path: string): boolean {
  try {
    fs.realpathSync.native(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The on-disk path identifying the tree THIS process is running from.
 *
 * `sourceRootInput` is the caller's `import.meta.url`-derived root, which is
 * the right answer for a source install and an unusable one for a compiled
 * binary (see the embedded-filesystem note at the top of this file). The test
 * is a property rather than a `/$bunfs/` prefix match: if the module path
 * resolves nowhere on disk it cannot be an install root under any layout, and
 * the executable is the only real artifact left to point at.
 */
export function runningTreePath(sourceRootInput: string, execPath: string = process.execPath): string {
  if (isOnDisk(sourceRootInput)) return realpathOrSelf(sourceRootInput);
  return realpathOrSelf(execPath);
}

export function pathWithinAnyRegistry(path: string): { ok: boolean; root: string } {
  const roots = registryInstallRoots();
  for (const root of roots) {
    if (pathWithin(path, root)) return { ok: true, root };
  }
  return { ok: false, root: expectedRegistryRoot() };
}

/**
 * Which build is running, and is it the installed one?
 *
 *   - `unmanaged` — the source is not under any registry root. A dev
 *     worktree, a fresh clone, `bun run src/cli.ts`. There is no `current` to
 *     be behind, so staleness is not a meaningful question and this never
 *     reports a problem.
 *   - `current`   — running the exact directory `<root>/current` resolves to.
 *   - `superseded` — running a registry version directory that `current` no
 *     longer points at. Only a long-lived process can reach this state (or a
 *     one-shot invocation racing a refresh), and the remedy is to restart it.
 *   - `indeterminate` — under a registry root, but `current` is missing or
 *     unreadable, so the comparison cannot be made. Deliberately NOT folded
 *     into `current`: an unresolvable tip must fail toward "check this",
 *     never toward "you're up to date".
 *
 * `build` / `currentBuild` are the version-directory basenames (the commit oid
 * registry names each install after), or null when the layout has no
 * `versions/<oid>` directory — e.g. the legacy flat checkout, where the root
 * itself is the tree.
 */
export type RunningBuild = {
  status: "current" | "superseded" | "unmanaged" | "indeterminate";
  /**
   * realpath of the installed tree this process is running — the
   * `versions/<oid>` directory when there is one, else the source tree.
   * Named for what it is rather than `sourceRoot`: under the compiled artifact
   * there is no source tree involved, and calling it one is how the previous
   * version of this module came to ask containment about `/$bunfs/root/kanban`.
   */
  runningRoot: string;
  /** the registry app root containing sourceRoot, or null when unmanaged */
  installRoot: string | null;
  /** realpath of `<installRoot>/current`, or null when unresolvable */
  currentRoot: string | null;
  /** version-directory name for sourceRoot (commit oid), or null */
  build: string | null;
  /** version-directory name for currentRoot (commit oid), or null */
  currentBuild: string | null;
};

// The version-directory name registry installs under (`versions/<oid>`), or
// null for any other shape. Read off the path rather than from git, so it works
// in an install that has no `.git`.
function buildIdOf(root: string | null): string | null {
  if (!root) return null;
  const m = /\/versions\/([^/]+)$/.exec(root);
  return m ? m[1]! : null;
}

/**
 * Resolve the running build. `sourceRootInput` is the repo/install root of the
 * code that is executing — callers pass their own `import.meta.url`-derived
 * root so this reports the tree that is actually loaded, not whatever
 * `command -v kanban` would resolve today. When that root is embedded rather
 * than on disk (the compiled artifact), the executable answers instead; both
 * are then normalised to the `versions/<oid>` directory so the comparison
 * against `current` is between like and like.
 *
 * `execPath` is injectable for tests only; production callers must use the
 * default, which is the executable this process was started from.
 */
export function resolveRunningBuild(
  sourceRootInput: string,
  execPath: string = process.execPath,
): RunningBuild {
  const tree = runningTreePath(sourceRootInput, execPath);
  const runningRoot = versionRootOf(tree) ?? tree;
  const match = pathWithinAnyRegistry(runningRoot);
  if (!match.ok) {
    return {
      status: "unmanaged",
      runningRoot,
      installRoot: null,
      currentRoot: null,
      build: buildIdOf(runningRoot),
      currentBuild: null,
    };
  }

  const installRoot = match.root;
  const currentLink = `${installRoot}/current`;
  const currentLinkTarget = fs.existsSync(currentLink) ? realpathOrSelf(currentLink) : null;
  const currentRoot = currentLinkTarget ? versionRootOf(currentLinkTarget) ?? currentLinkTarget : null;
  const build = buildIdOf(runningRoot);
  const currentBuild = buildIdOf(currentRoot);

  // No `current` at all: the legacy flat checkout layout, or a partially
  // installed root. Nothing to compare against — say so rather than implying
  // freshness we did not verify.
  if (!currentRoot) {
    return { status: "indeterminate", runningRoot, installRoot, currentRoot, build, currentBuild };
  }

  const status = currentRoot === runningRoot ? "current" : "superseded";
  return { status, runningRoot, installRoot, currentRoot, build, currentBuild };
}

/** Short display form for a build: the oid, abbreviated, or the raw path. */
export function shortBuild(build: string | null, fallback: string | null): string {
  if (build) return build.length > 12 ? build.slice(0, 12) : build;
  return fallback ?? "unknown";
}
