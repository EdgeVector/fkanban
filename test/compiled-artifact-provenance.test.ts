/**
 * Does the SHIPPED artifact know where it is installed?
 *
 * Every other test in this repo runs the source tree under `bun test`. What
 * host-track installs is the output of `scripts/build-artifact.sh` — a
 * `bun build --compile` executable — and the two disagree about the one input
 * the provenance checks are built on. Inside a compiled binary every module's
 * `import.meta.url` resolves into the executable's embedded filesystem
 * (`/$bunfs/root/kanban`), so `src/host_track.ts`, which asked containment
 * about exactly that path, answered `unmanaged` for a correctly installed CLI.
 *
 * Measured 2026-08-06 on Tom's primary, hours after host-track flipped this app
 * to the artifact install — same binary, same second:
 *
 *   kanban which --check          → exit 1, "fkanban is not running from …"
 *   kanban which kanban --check   → exit 0, under_host_track: true
 *
 * Two arms of one command, asked about the same file on disk, disagreeing. And
 * because `unmanaged` is the "nothing to compare, no problem here" verdict, the
 * `✗ running build is the installed build` that `test/doctor-running-build.test.ts`
 * exists to guarantee had become UNREACHABLE on the only shape that ships.
 *
 * The suite could not see any of it: its own last assertion
 * (`runningSourceRoot() === REPO_ROOT`) is true in source mode and false in a
 * compiled one, and nothing ever ran a compiled one. So these tests execute the
 * real binary as a subprocess. They cost one `bun build --compile` (~150ms,
 * and normally zero — CI runs `bun run build` before `bun test`, so the
 * artifact under test is the very one that gets published).
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { COMPILE_TEST_TIMEOUT_MS, SPAWN_TEST_TIMEOUT_MS } from "./helpers/spawn-test-timeout";

const REPO_ROOT = fileURLToPath(import.meta.url).replace(/\/test\/[^/]+$/, "");

let workdir = "";
let binary = "";

beforeAll(() => {
  workdir = mkdtempSync(join(tmpdir(), "fkanban-artifact-"));

  // Prefer the artifact CI just built — testing the published bytes beats
  // testing a re-compile of them. Fall back to compiling so a bare `bun test`
  // still covers this; never skip, because a skipped provenance test is
  // indistinguishable from the blindness that let this ship.
  const built = join(REPO_ROOT, "dist", "kanban");
  if (existsSync(built)) {
    binary = built;
    return;
  }
  binary = join(workdir, "kanban");
  const build = Bun.spawnSync(["bun", "build", join(REPO_ROOT, "src", "cli.ts"), "--compile", "--outfile", binary], {
    cwd: REPO_ROOT,
  });
  if (build.exitCode !== 0) {
    throw new Error(`could not compile the artifact under test: ${build.stderr.toString()}`);
  }
}, COMPILE_TEST_TIMEOUT_MS);

afterAll(() => {
  if (workdir) rmSync(workdir, { recursive: true, force: true });
});

/**
 * A host-track install root holding the compiled binary at the depth
 * `scripts/build-artifact.sh` puts it — `versions/<oid>/dist/kanban` — with
 * `current` pointing at one of them. Real directories, a real symlink, and real
 * copies: the binary under test resolves its own executable path, so a fixture
 * that symlinked the builds together would collapse to one realpath and prove
 * nothing.
 */
function install(builds: string[], currentBuild: string | null): { root: string; exe: (b: string) => string } {
  const root = mkdtempSync(join(tmpdir(), "fkanban-install-"));
  for (const b of builds) {
    mkdirSync(join(root, "versions", b, "dist"), { recursive: true });
    copyFileSync(binary, join(root, "versions", b, "dist", "kanban"));
  }
  if (currentBuild) symlinkSync(join(root, "versions", currentBuild), join(root, "current"));
  return { root, exe: (b: string) => join(root, "versions", b, "dist", "kanban") };
}

const installs: string[] = [];
afterAll(() => {
  while (installs.length > 0) rmSync(installs.pop()!, { recursive: true, force: true });
});

function run(root: string, exe: string, args: string[]): { report: Record<string, unknown>; exitCode: number } {
  const proc = Bun.spawnSync([exe, ...args], {
    env: { ...process.env, FKANBAN_HOST_TRACK_DIR: root },
  });
  const stdout = proc.stdout.toString().trim();
  return {
    report: stdout.startsWith("{") ? JSON.parse(stdout) : {},
    exitCode: proc.exitCode,
  };
}

describe("the compiled artifact reports its own install", () => {
  test("running the build `current` points at is `current`, not `unmanaged`", () => {
    const { root, exe } = install(["aaa111", "bbb222"], "bbb222");
    installs.push(root);

    const { report } = run(root, exe("bbb222"), ["which", "--json"]);

    // The whole defect in one assertion: the shipped shape used to answer
    // `false` / `unmanaged` here, for the most correct install possible.
    expect(report.in_host_track).toBe(true);
    expect(report.build_status).toBe("current");
    expect(report.build).toBe("bbb222");
    expect(report.issues).toEqual([]);
  }, SPAWN_TEST_TIMEOUT_MS);

  test("a superseded compiled build is detected — the check this module exists for", () => {
    // The live hazard: a long-lived `kanban mcp` keeps serving the version
    // directory it dereferenced at spawn. Under the compiled artifact this
    // state reported `unmanaged` — the verdict that means "no problem here".
    const { root, exe } = install(["aaa111", "bbb222"], "bbb222");
    installs.push(root);

    const { report } = run(root, exe("aaa111"), ["which", "--json"]);

    expect(report.build_status).toBe("superseded");
    expect(report.build).toBe("aaa111");
    expect(report.current_build).toBe("bbb222");
    expect(report.issues).toHaveLength(1);
  }, SPAWN_TEST_TIMEOUT_MS);

  test("`which --check` exits non-zero on a superseded artifact and zero on a current one", () => {
    // The scripted contract: a routine gating on this exit code got a clean 0
    // for both states, because both were `unmanaged` with no issues... except
    // `unmanaged` DID carry the containment issue, so the current install
    // failed the check and the stale one would too. Both answers were wrong.
    const { root, exe } = install(["aaa111", "bbb222"], "bbb222");
    installs.push(root);

    expect(run(root, exe("bbb222"), ["which", "--check"]).exitCode).toBe(0);
    expect(run(root, exe("aaa111"), ["which", "--check"]).exitCode).toBe(1);
    // Two spawns of the ~100MB compiled artifact, where its siblings do one.
    // On bun's 5s default that made the only two-spawn test in the file the
    // one that failed under load (measured 2026-08-23: 8.1s on a host running
    // two other agent test suites) — a timing verdict wearing a provenance
    // test's name. Same budget the other artifact-spawning test states.
  }, 30_000);

  test("a compiled binary outside every host-track root is still `unmanaged`", () => {
    // The fix must not answer "managed" by construction. A binary copied
    // somewhere arbitrary has no `current` to be behind, and saying otherwise
    // would be the same false confidence in the opposite direction.
    const { root } = install(["aaa111"], "aaa111");
    installs.push(root);
    const loose = mkdtempSync(join(tmpdir(), "fkanban-loose-"));
    installs.push(loose);
    const exe = join(loose, "kanban");
    copyFileSync(binary, exe);

    const { report } = run(root, exe, ["which", "--json"]);

    expect(report.build_status).toBe("unmanaged");
    expect(report.in_host_track).toBe(false);
  }, SPAWN_TEST_TIMEOUT_MS);

  test("`source_path` stays honest about the embedded module URL", () => {
    // `source_root` is now the resolved install tree, so the two fields say
    // different things on purpose. Keeping the raw embedded path visible is
    // what makes the resolution auditable from the report alone — the previous
    // version printed the embedded path AND `in_host_track: false` while its
    // own `bun_path` line resolved into the install root.
    const { root, exe } = install(["bbb222"], "bbb222");
    installs.push(root);

    const { report } = run(root, exe("bbb222"), ["which", "--json"]);

    expect(String(report.source_path)).toContain("$bunfs");
    expect(String(report.source_root)).toContain("versions/bbb222");
    expect(String(report.bun_path)).toContain("versions/bbb222");
  }, SPAWN_TEST_TIMEOUT_MS);
});

/**
 * Does the SHIPPED artifact print a registration command that can be run?
 *
 * Same root cause as the block above, one module over. `src/mcp/register.ts`
 * derived the repo root from its own module URL, so under the compiled
 * artifact — with no `kanban` shim on PATH — `kanban init`'s Next-steps block
 * and `kanban doctor`'s entrypoint check both printed
 *
 *   claude mcp add fkanban -- bun /$bunfs/root/kanban/src/mcp/main.ts
 *
 * naming a file inside the executable's embedded filesystem. The two surfaces
 * whose whole job is to tell you how to register the server were the two that
 * could not, and the no-shim branch is not hypothetical here: sandboxed Bash on
 * the primary loses `$PATH`, so `resolveKanbanShim()` returns null inside
 * routine runs on a machine where the shim is installed and fine.
 *
 * These run a compiled probe (`test/register-probe-entry.ts`) rather than
 * `dist/kanban`, because the only CLI surfaces that print the registration line
 * are `init` (writes config) and `doctor` (write-probes the node). The probe
 * reproduces the packaging, which is the whole of the defect — built from the
 * pre-fix module it emits the broken line verbatim.
 */
describe("the compiled artifact prints a registration command that works", () => {
  let probe = "";
  let noShimPath = "";

  beforeAll(() => {
    const built = join(workdir, "register-probe");
    const build = Bun.spawnSync(
      ["bun", "build", join(REPO_ROOT, "test", "register-probe-entry.ts"), "--compile", "--outfile", built],
      { cwd: REPO_ROOT },
    );
    if (build.exitCode !== 0) {
      throw new Error(`could not compile the register probe: ${build.stderr.toString()}`);
    }
    // `process.execPath` inside the binary is fully resolved, and on macOS
    // `$TMPDIR` lives under a symlinked `/var`. Compare against the same
    // resolution the binary will report rather than the path we happened to
    // write — otherwise this asserts a macOS path convention, not the fix.
    probe = realpathSync.native(built);

    // A PATH with a real `sh` (resolveKanbanShim shells out to `command -v`)
    // and no `kanban`/`fkanban` on it. Built from a temp dir rather than by
    // clearing PATH, so the shim lookup genuinely runs and genuinely misses.
    noShimPath = mkdtempSync(join(tmpdir(), "fkanban-noshim-"));
    installs.push(noShimPath);
  }, COMPILE_TEST_TIMEOUT_MS);

  function probeWith(path: string, env: Record<string, string> = {}, exe = probe): Record<string, unknown> {
    const proc = Bun.spawnSync([exe], { env: { PATH: path, ...env } });
    const stdout = proc.stdout.toString().trim();
    if (!stdout.startsWith("{")) {
      throw new Error(`probe produced no report (exit ${proc.exitCode}): ${proc.stderr.toString()}`);
    }
    return JSON.parse(stdout);
  }

  /** A host-track install of the probe at the depth build-artifact.sh uses. */
  function probeInstall(builds: string[], currentBuild: string): { root: string; exe: (b: string) => string } {
    const root = mkdtempSync(join(tmpdir(), "fkanban-probe-install-"));
    installs.push(root);
    for (const b of builds) {
      mkdirSync(join(root, "versions", b, "dist"), { recursive: true });
      copyFileSync(probe, join(root, "versions", b, "dist", "kanban"));
    }
    symlinkSync(join(root, "versions", currentBuild), join(root, "current"));
    return { root: realpathSync.native(root), exe: (b) => join(root, "versions", b, "dist", "kanban") };
  }

  test("with no shim on PATH it registers the executable, not a path inside it", () => {
    const report = probeWith(`${noShimPath}:/usr/bin:/bin`);

    // The defect in one assertion: this used to be `bun /$bunfs/…/main.ts`.
    expect(report.shape).toBe("compiled");
    expect(report.command).toBe(`claude mcp add fkanban -- ${probe} mcp`);
    expect(report.entrypoint).toBe(probe);

    // The property that makes doctor's `existsSync` check meaningful, and the
    // one `existsSync` itself cannot establish here: embedded paths pass
    // `existsSync` and `statSync` alike, so the probe uses `realpathSync.native`.
    expect(report.entrypoint_on_disk).toBe(true);
    expect(String(report.command)).not.toContain("$bunfs");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("the CLI invocation is runnable too — it was `bun run src/cli.ts`", () => {
    // init's Next-steps `list`/`add` lines. Under the artifact there is no
    // `src/cli.ts` on disk and no repo to be cd'd into, so the shipped binary
    // told a first-time user to run a file that does not exist.
    const report = probeWith(`${noShimPath}:/usr/bin:/bin`);
    expect(report.invocation).toBe(probe);
    expect(String(report.invocation)).not.toContain("$bunfs");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("a shim on PATH still wins, and the entrypoint is that shim", () => {
    // The fix must not answer "compiled" by construction. When a shim exists it
    // is what `claude mcp add fkanban -- kanban mcp` executes, so it — not the
    // running executable — is the honest entrypoint.
    const shimDir = mkdtempSync(join(tmpdir(), "fkanban-shim-"));
    installs.push(shimDir);
    const shim = join(shimDir, "kanban");
    writeFileSync(shim, "#!/bin/sh\nexit 0\n");
    chmodSync(shim, 0o755);

    const report = probeWith(`${shimDir}:/usr/bin:/bin`);

    expect(report.shape).toBe("shim");
    expect(report.command).toBe("claude mcp add fkanban -- kanban mcp");
    expect(report.entrypoint).toBe(shim);
    expect(report.entrypoint_on_disk).toBe(true);
  }, SPAWN_TEST_TIMEOUT_MS);

  test("run from source, the bun+path form is unchanged", () => {
    // The shape that always worked. Pinned because the fix's whole risk is
    // regressing it — a source checkout must still be told to run its own
    // `src/mcp/main.ts`, not the `bun` binary that happens to be executing it.
    const proc = Bun.spawnSync(
      [process.execPath, join(REPO_ROOT, "test", "register-probe-entry.ts")],
      { cwd: REPO_ROOT, env: { PATH: `${noShimPath}:/usr/bin:/bin` } },
    );
    const report = JSON.parse(proc.stdout.toString().trim());

    expect(report.shape).toBe("source");
    expect(report.command).toBe(`claude mcp add fkanban -- bun ${REPO_ROOT}/src/mcp/main.ts`);
    expect(report.entrypoint).toBe(`${REPO_ROOT}/src/mcp/main.ts`);
    expect(report.invocation).toBe("bun run src/cli.ts");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("under host-track it registers `current`, not the version dir it resolved to", () => {
    // `process.execPath` is fully resolved, so a binary invoked through
    // `<root>/current/dist/kanban` reports `<root>/versions/<oid>/dist/kanban`.
    // Registering THAT pins the MCP server to one build and guarantees it goes
    // stale at the next upgrade — the exact shape of the 192-commit-stale
    // `kanban-mcp` this module carries a note about.
    const { root, exe } = probeInstall(["aaa111", "bbb222"], "bbb222");
    const report = probeWith(`${noShimPath}:/usr/bin:/bin`, { FKANBAN_HOST_TRACK_DIR: root }, exe("bbb222"));

    expect(report.shape).toBe("compiled");
    expect(report.entrypoint).toBe(`${root}/current/dist/kanban`);
    expect(report.command).toBe(`claude mcp add fkanban -- ${root}/current/dist/kanban mcp`);
    expect(report.entrypoint_on_disk).toBe(true);
    // The resolved path is what it RAN from; it must not be what it registers.
    expect(String(report.exec_path)).toContain("versions/bbb222");
    expect(String(report.entrypoint)).not.toContain("versions/");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("a superseded build registers itself, not the `current` it is behind", () => {
    // The other direction of the same honesty. `current` here is a DIFFERENT
    // file from the running one, and quietly registering it would mean the
    // printed command starts a build this process never verified.
    const { root, exe } = probeInstall(["aaa111", "bbb222"], "bbb222");
    const report = probeWith(`${noShimPath}:/usr/bin:/bin`, { FKANBAN_HOST_TRACK_DIR: root }, exe("aaa111"));

    expect(report.entrypoint).toBe(`${root}/versions/aaa111/dist/kanban`);
    expect(String(report.entrypoint)).not.toContain("/current/");
  }, SPAWN_TEST_TIMEOUT_MS);

  test("`<executable> mcp` actually serves MCP — the claim the compiled branch rests on", async () => {
    // Asserted against the SHIPPED binary, not the probe. Everything above
    // proves register.ts now NAMES the executable; this proves the name is
    // worth printing. `test/mcp-cli-subcommand.test.ts` covers the same
    // subcommand only as `bun src/cli.ts mcp` — the source shape — so without
    // this the artifact's own MCP entrypoint has never been started.
    const transport = new StdioClientTransport({
      command: binary,
      args: ["mcp"],
      env: { ...(process.env as Record<string, string>), FKANBAN_CONFIG: "/nonexistent/fkanban-artifact-mcp/config.json" },
    });
    const client = new Client({ name: "test", version: "0.0.0" });
    await client.connect(transport);
    try {
      expect(client.getServerVersion()?.name).toBe("fkanban");
    } finally {
      await client.close();
    }
  }, 30_000);
});
