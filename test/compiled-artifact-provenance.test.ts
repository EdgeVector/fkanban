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
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

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
});

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
  });

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
  });

  test("`which --check` exits non-zero on a superseded artifact and zero on a current one", () => {
    // The scripted contract: a routine gating on this exit code got a clean 0
    // for both states, because both were `unmanaged` with no issues... except
    // `unmanaged` DID carry the containment issue, so the current install
    // failed the check and the stale one would too. Both answers were wrong.
    const { root, exe } = install(["aaa111", "bbb222"], "bbb222");
    installs.push(root);

    expect(run(root, exe("bbb222"), ["which", "--check"]).exitCode).toBe(0);
    expect(run(root, exe("aaa111"), ["which", "--check"]).exitCode).toBe(1);
  });

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
  });

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
  });
});
