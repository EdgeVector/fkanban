/**
 * Does a doctor report say which build produced it?
 *
 * Measured 2026-08-05 on Tom's primary, same machine, same config, same minute:
 *
 *   kanban doctor   (CLI, re-resolves `current` every exec)  → exit 0, zero ✗
 *   fkanban_doctor  (MCP, spawned on 7577697d)               → ✗ milestone_cards
 *                                                              pin identity, isError
 *
 * Both were right about their own tree. The MCP server was started before the
 * config field that acknowledges that deviation existed, and `host-track
 * refresh` moves a symlink — it cannot move a process that already
 * dereferenced it. The MCP server's own instructions make `fkanban_doctor` an
 * agent's FIRST move on board trouble, so the stalest surface is first in line
 * to be believed, and nothing in its report said which build it came from
 * (`version` is `pkg.version`, "0.1.0" for the life of the repo).
 *
 * These tests assert on what `doctor()` actually PRINTS and on the check
 * status it emits — not on the helper alone. A helper unit test passes just as
 * happily when doctor never calls it, which is the wiring hole this repo has
 * hit in runs (f), (e), and the write-probe branch. The `resolveRunningBuild`
 * cases below cover the decision table; the `doctor()` cases prove it is wired
 * to the surface an operator reads.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { doctor, reportRunningBuild, runningSourceRoot } from "../src/commands/doctor.ts";
import { resolveRunningBuild } from "../src/host_track.ts";

const REPO_ROOT = fileURLToPath(import.meta.url).replace(/\/test\/[^/]+$/, "");

const tmps: string[] = [];
const strays: string[] = [];

afterEach(() => {
  while (tmps.length > 0) rmSync(tmps.pop()!, { recursive: true, force: true });
  while (strays.length > 0) rmSync(strays.pop()!, { force: true });
  delete process.env.FKANBAN_HOST_TRACK_DIR;
});

/**
 * A host-track install root of the shape `bin/host-track-refresh` produces:
 * `versions/<oid>` directories plus a `current` symlink at whichever one is
 * installed. Real directories and a real symlink — the code under test asks
 * the filesystem, so a mock here would only prove the mock.
 */
function fixtureRoot(builds: string[], currentBuild: string | null): string {
  const root = mkdtempSync(join(tmpdir(), "fkanban-host-track-"));
  tmps.push(root);
  for (const b of builds) mkdirSync(join(root, "versions", b), { recursive: true });
  if (currentBuild) symlinkSync(join(root, "versions", currentBuild), join(root, "current"));
  return root;
}

describe("resolveRunningBuild", () => {
  test("running the directory `current` points at is `current`", () => {
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const got = resolveRunningBuild(join(root, "versions", "bbb222"));

    expect(got.status).toBe("current");
    expect(got.build).toBe("bbb222");
    expect(got.currentBuild).toBe("bbb222");
  });

  test("running a version directory `current` has moved off is `superseded`", () => {
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const got = resolveRunningBuild(join(root, "versions", "aaa111"));

    expect(got.status).toBe("superseded");
    expect(got.build).toBe("aaa111");
    expect(got.currentBuild).toBe("bbb222");
  });

  test("containment alone does NOT imply current — the distinction this check exists for", () => {
    // The pre-existing `in_host_track` test is satisfied by BOTH directories.
    // If that were sufficient, there would be nothing to add.
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const stale = resolveRunningBuild(join(root, "versions", "aaa111"));
    const fresh = resolveRunningBuild(join(root, "versions", "bbb222"));

    expect(stale.installRoot).toBe(fresh.installRoot);
    expect(stale.installRoot).not.toBeNull();
    expect(stale.status).not.toBe(fresh.status);
  });

  test("a source tree outside every host-track root is `unmanaged`, not stale", () => {
    const root = fixtureRoot(["aaa111"], "aaa111");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const elsewhere = mkdtempSync(join(tmpdir(), "fkanban-worktree-"));
    tmps.push(elsewhere);
    const got = resolveRunningBuild(elsewhere);

    expect(got.status).toBe("unmanaged");
    expect(got.installRoot).toBeNull();
  });

  test("an unresolvable `current` is `indeterminate`, never `current`", () => {
    // Unknown must fail toward "check this", not toward "you're up to date".
    const root = fixtureRoot(["aaa111"], null);
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const got = resolveRunningBuild(join(root, "versions", "aaa111"));

    expect(got.status).toBe("indeterminate");
  });
});

describe("reportRunningBuild", () => {
  function collect(sourceRoot: string) {
    const checks: { pass: boolean; label: string; detail?: string }[] = [];
    const infos: { label: string; detail?: string }[] = [];
    reportRunningBuild(
      (pass, label, detail) => checks.push({ pass, label, detail }),
      (label, detail) => infos.push({ label, detail }),
      sourceRoot,
    );
    return { checks, infos };
  }

  test("a superseded build is a FAILING check, not an advisory line", () => {
    // `·` info lines are skimmed past; `✗` sets `isError` on the MCP tool
    // result, which is what makes an agent stop and read.
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const { checks, infos } = collect(join(root, "versions", "aaa111"));

    expect(infos).toHaveLength(0);
    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(false);
  });

  test("the failure names both builds and a remedy the reader can act on", () => {
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const detail = collect(join(root, "versions", "aaa111")).checks[0]!.detail ?? "";

    expect(detail).toContain("aaa111");
    expect(detail).toContain("bbb222");
    // The other verdicts in the report are the actual hazard — say so.
    expect(detail).toContain("superseded build");
    expect(detail).toMatch(/restart/i);
  });

  test("a current build passes without noise", () => {
    const root = fixtureRoot(["aaa111", "bbb222"], "bbb222");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const { checks, infos } = collect(join(root, "versions", "bbb222"));

    expect(checks).toHaveLength(1);
    expect(checks[0]!.pass).toBe(true);
    expect(infos).toHaveLength(0);
  });

  test("a worktree/clone is informational — it has no `current` to be behind", () => {
    const root = fixtureRoot(["aaa111"], "aaa111");
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const elsewhere = mkdtempSync(join(tmpdir(), "fkanban-worktree-"));
    tmps.push(elsewhere);
    const { checks, infos } = collect(elsewhere);

    expect(checks).toHaveLength(0);
    expect(infos).toHaveLength(1);
  });

  test("an unresolvable `current` never reports a green", () => {
    const root = fixtureRoot(["aaa111"], null);
    process.env.FKANBAN_HOST_TRACK_DIR = root;

    const { checks, infos } = collect(join(root, "versions", "aaa111"));

    expect(checks).toHaveLength(0);
    expect(infos).toHaveLength(1);
    expect(infos[0]!.detail ?? "").toMatch(/cannot confirm/i);
  });
});

describe("wiring — doctor() actually runs the check", () => {
  // `doctor()` emits the running-build line before it reads config, so a
  // deliberately absent config path exercises the wiring without a node.
  async function runDoctorHead(): Promise<{
    lines: string[];
    checks: { name: string; status: string; detail?: string }[];
    ok: boolean;
  }> {
    const lines: string[] = [];
    const checks: { name: string; status: string; detail?: string }[] = [];
    const missingConfig = join(mkdtempSync(join(tmpdir(), "fkanban-noconfig-")), "config.json");
    tmps.push(join(missingConfig, ".."));
    const ok = await doctor({
      configPath: missingConfig,
      print: (l) => lines.push(l),
      onCheck: (c) => checks.push(c),
    });
    return { lines, checks, ok };
  }

  test("the running-build check appears in the report doctor prints", async () => {
    const { lines, checks } = await runDoctorHead();

    // In a checkout this is the informational branch; the point of this
    // assertion is that the check RUNS, before config, on the real entrypoint.
    expect(checks.some((c) => c.name.startsWith("running build"))).toBe(true);
    expect(lines.some((l) => l.includes("running build"))).toBe(true);
  });

  test("a superseded running build makes the real doctor() report a ✗", async () => {
    // Make the repo root itself the host-track root, with `current` pointing
    // somewhere else — the one arrangement that puts THIS loaded tree in the
    // superseded state without copying the repo. `resolveRunningBuild` reads
    // the filesystem, so this is the genuine condition, not a stub.
    const other = fixtureRoot(["bbb222"], null);
    const currentLink = join(REPO_ROOT, "current");
    rmSync(currentLink, { force: true });
    symlinkSync(join(other, "versions", "bbb222"), currentLink);
    strays.push(currentLink);
    process.env.FKANBAN_HOST_TRACK_DIR = REPO_ROOT;

    const { lines, checks } = await runDoctorHead();

    const built = checks.find((c) => c.name === "running build is the installed build");
    expect(built?.status).toBe("fail");
    expect(built?.detail ?? "").toContain("bbb222");
    expect(lines.some((l) => l.startsWith("✗ running build is the installed build"))).toBe(true);
  });
});

describe("runningSourceRoot", () => {
  test("resolves the tree that is loaded, not whatever is on PATH", () => {
    // The regex strips `/src/commands/doctor.ts`; if it ever stops matching,
    // every verdict above would silently be about the wrong directory.
    expect(runningSourceRoot()).toBe(REPO_ROOT);
  });
});
