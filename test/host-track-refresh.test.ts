import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";

const roots: string[] = [];

function tempRoot(): string {
  const root = mkdtempSync(resolve(tmpdir(), "fkanban-host-track-"));
  roots.push(root);
  return root;
}

async function run(cmd: string[], cwd: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(cmd, {
    cwd,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, code };
}

describe("host-track refresh", () => {
  afterEach(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
    roots.length = 0;
  });

  // Real git clone/fetch/ff work — bun's default 5 s per-test timeout flakes
  // on a contended machine (two consecutive forge CI runs died at ~5.1 s and
  // ~6.2 s on 2026-07-17 while rustc/docker builds shared the host).
  test("clones, fast-forwards, and repoints PATH shims", async () => {
    const root = tempRoot();
    const remote = resolve(root, "remote.git");
    const seed = resolve(root, "seed");
    const host = resolve(root, "host/fkanban");
    const bin = resolve(root, "bin");
    const stamps = resolve(root, "stamps");

    await run(["git", "init", "--bare", "-q", remote], root);
    await run(["git", "init", "-q", "-b", "main", seed], root);
    await run(["git", "config", "user.email", "test@example.invalid"], seed);
    await run(["git", "config", "user.name", "Host Track Test"], seed);
    mkdirSync(resolve(seed, "bin"), { recursive: true });
    mkdirSync(resolve(seed, "src/mcp"), { recursive: true });
    writeFileSync(resolve(seed, "src/cli.ts"), "console.log('cli')\n");
    writeFileSync(resolve(seed, "src/mcp/main.ts"), "console.log('mcp')\n");
    writeFileSync(resolve(seed, "bin", "kanban"), "#!/usr/bin/env bash\necho tracked-kanban\n");
    chmodSync(resolve(seed, "bin", "kanban"), 0o755);
    for (const name of ["host-track-refresh", "kanban-host-track-refresh"]) {
      writeFileSync(resolve(seed, "bin", name), `#!/usr/bin/env bash\necho ${name}\n`);
      chmodSync(resolve(seed, "bin", name), 0o755);
    }
    writeFileSync(resolve(seed, "README.md"), "one\n");
    await run(["git", "add", "."], seed);
    await run(["git", "commit", "-q", "-m", "initial"], seed);
    await run(["git", "remote", "add", "origin", remote], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);
    const firstHead = (await run(["git", "rev-parse", "HEAD"], seed)).stdout.trim();

    const env = {
      FKANBAN_HOST_TRACK_REMOTE: remote,
      FKANBAN_HOST_TRACK_DIR: host,
      FKANBAN_HOST_TRACK_BIN_DIR: bin,
      FKANBAN_HOST_TRACK_STAMP_DIR: stamps,
      FKANBAN_HOST_TRACK_SKIP_INSTALL: "1",
    };
    const first = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), env);
    expect(first.code).toBe(0);
    const kanbanShim = resolve(bin, "kanban");
    const fkanbanShim = resolve(bin, "fkanban");
    expect(statSync(kanbanShim).mode & 0o111).not.toBe(0);
    expect(statSync(fkanbanShim).mode & 0o111).not.toBe(0);
    expect(await Bun.file(kanbanShim).text()).toContain("host-track checkout is missing or incomplete");
    expect(await Bun.file(fkanbanShim).text()).toContain("host-track refresh kanban");
    expect(await run([kanbanShim], root)).toMatchObject({ code: 0, stdout: "cli\n", stderr: "" });
    expect(await run(["git", "-C", host, "remote", "get-url", "lastgit"], root)).toMatchObject({
      code: 0,
      stdout: `${remote}\n`,
      stderr: "",
    });
    expect((await run(["git", "-C", host, "ls-remote", "lastgit", "refs/heads/main"], root)).stdout).toBe(`${firstHead}\trefs/heads/main\n`);
    expect(await Bun.file(resolve(stamps, "kanban.json")).json()).toMatchObject({
      app: "kanban",
      command: "kanban",
      kind: "B checkout-shim",
      gate_remote: "lastgit",
      gate_ref: "refs/heads/main",
      gate_head: firstHead,
      stale: false,
    });
    expect(await Bun.file(resolve(stamps, "fkanban.json")).json()).toMatchObject({
      app: "fkanban",
      command: "fkanban",
      exec_path: `${bin}/fkanban`,
      kind: "B checkout-shim",
      stale: false,
    });

    const hostKanbanScript = await Bun.file(resolve(host, "bin/kanban")).text();
    const hostRefreshScript = await Bun.file(resolve(host, "bin/host-track-refresh")).text();
    for (const name of ["kanban", "host-track-refresh"]) {
      rmSync(resolve(bin, name));
      symlinkSync(resolve(host, "bin", name), resolve(bin, name));
    }

    writeFileSync(resolve(seed, "README.md"), "two\n");
    await run(["git", "add", "README.md"], seed);
    await run(["git", "commit", "-q", "-m", "update"], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);
    const secondHead = (await run(["git", "rev-parse", "HEAD"], seed)).stdout.trim();

    const second = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), env);
    expect(second.code).toBe(0);
    expect(await Bun.file(resolve(host, "README.md")).text()).toBe("two\n");
    expect(await Bun.file(resolve(stamps, "kanban.json")).json()).toMatchObject({
      host_head: secondHead,
      gate_head: secondHead,
      stale: false,
    });
    expect(lstatSync(resolve(bin, "kanban")).isSymbolicLink()).toBe(false);
    expect(lstatSync(resolve(bin, "host-track-refresh")).isSymbolicLink()).toBe(false);
    expect(await Bun.file(resolve(host, "bin/kanban")).text()).toBe(hostKanbanScript);
    expect(await Bun.file(resolve(host, "bin/host-track-refresh")).text()).toBe(hostRefreshScript);

    rmSync(resolve(host, "src/cli.ts"), { force: true });
    const broken = await run([kanbanShim], root);
    expect(broken.code).toBe(127);
    expect(broken.stdout).toBe("");
    expect(broken.stderr).toContain("kanban: host-track checkout is missing or incomplete");
    expect(broken.stderr).toContain("expected ");
    expect(broken.stderr).toContain("host-track refresh kanban");
  }, 60_000);

  // A slow/loaded node (observed: LastGit git-protocol round trips averaging
  // 8.5s, p95/max ~30s — papercut-fkanban-host-track-refresh-hangs-and-drifted)
  // must produce a fast, attributed failure instead of an unbounded hang.
  test("bounds a slow git step and reports it by name instead of hanging", async () => {
    const root = tempRoot();
    const remote = resolve(root, "remote.git");
    const seed = resolve(root, "seed");
    const host = resolve(root, "host/fkanban");
    const bin = resolve(root, "bin");
    const stamps = resolve(root, "stamps");
    const fakeGitDir = resolve(root, "fake-git-bin");

    await run(["git", "init", "--bare", "-q", remote], root);
    await run(["git", "init", "-q", "-b", "main", seed], root);
    await run(["git", "config", "user.email", "test@example.invalid"], seed);
    await run(["git", "config", "user.name", "Host Track Test"], seed);
    mkdirSync(resolve(seed, "bin"), { recursive: true });
    mkdirSync(resolve(seed, "src/mcp"), { recursive: true });
    writeFileSync(resolve(seed, "src/cli.ts"), "console.log('cli')\n");
    writeFileSync(resolve(seed, "src/mcp/main.ts"), "console.log('mcp')\n");
    for (const name of ["kanban", "host-track-refresh", "kanban-host-track-refresh"]) {
      writeFileSync(resolve(seed, "bin", name), `#!/usr/bin/env bash\necho ${name}\n`);
      chmodSync(resolve(seed, "bin", name), 0o755);
    }
    await run(["git", "add", "."], seed);
    await run(["git", "commit", "-q", "-m", "initial"], seed);
    await run(["git", "remote", "add", "origin", remote], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);

    // First refresh: real git, establishes the checkout so the second
    // refresh takes the "fetch" branch (not "clone") where the slow step
    // under test actually runs.
    const baseEnv = {
      FKANBAN_HOST_TRACK_REMOTE: remote,
      FKANBAN_HOST_TRACK_DIR: host,
      FKANBAN_HOST_TRACK_BIN_DIR: bin,
      FKANBAN_HOST_TRACK_STAMP_DIR: stamps,
      FKANBAN_HOST_TRACK_SKIP_INSTALL: "1",
    };
    const primed = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), baseEnv);
    expect(primed.code).toBe(0);

    const realGit = (await run(["bash", "-c", "command -v git"], root)).stdout.trim();
    mkdirSync(fakeGitDir, { recursive: true });
    // Match FAKE_GIT_SLOW_STEP against any argument, not just $1 — the real
    // invocation is `git -C <dir> fetch origin <ref>`, so the subcommand is
    // not the first positional arg. `exec sleep` (not a plain `sleep` call
    // inside this script) so SIGTERM from `timeout` lands on `sleep` itself —
    // bash defers a received SIGTERM until a synchronous child command
    // finishes, so without `exec` here `timeout` would appear not to fire.
    writeFileSync(
      resolve(fakeGitDir, "git"),
      [
        "#!/usr/bin/env bash",
        'for arg in "$@"; do',
        '  if [ "$arg" = "${FAKE_GIT_SLOW_STEP:-}" ]; then',
        '    exec sleep "${FAKE_GIT_SLEEP:-5}"',
        "  fi",
        "done",
        `exec "${realGit}" "$@"`,
        "",
      ].join("\n"),
    );
    chmodSync(resolve(fakeGitDir, "git"), 0o755);

    const slowEnv = {
      ...baseEnv,
      PATH: `${fakeGitDir}:${process.env.PATH ?? ""}`,
      FAKE_GIT_SLOW_STEP: "fetch",
      FAKE_GIT_SLEEP: "5",
      FKANBAN_HOST_TRACK_GIT_TIMEOUT: "1",
    };
    const start = performance.now();
    const slow = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), slowEnv);
    const elapsedMs = performance.now() - start;

    expect(slow.code).toBe(124);
    expect(slow.stderr).toContain("step 'git fetch' timed out after 1s");
    expect(slow.stderr).toContain("lastdb ops");
    // Bounded by the 1s step timeout, not the fake git's 5s sleep.
    expect(elapsedMs).toBeLessThan(4000);
  }, 60_000);

  // A refresh whose gate ref (what "current" actually means) has moved past
  // what got fetched/merged must fail loud, not print the same "refreshed"
  // success text a real success would print — this false-clean signal is how
  // a real drift went undetected for hours in production
  // (papercut-fkanban-host-track-refresh-hangs-and-drifted).
  test("exits non-zero and warns when the checkout is still behind the configured gate ref", async () => {
    const root = tempRoot();
    const remote = resolve(root, "remote.git");
    const seed = resolve(root, "seed");
    const host = resolve(root, "host/fkanban");
    const bin = resolve(root, "bin");
    const stamps = resolve(root, "stamps");

    await run(["git", "init", "--bare", "-q", remote], root);
    await run(["git", "init", "-q", "-b", "main", seed], root);
    await run(["git", "config", "user.email", "test@example.invalid"], seed);
    await run(["git", "config", "user.name", "Host Track Test"], seed);
    mkdirSync(resolve(seed, "bin"), { recursive: true });
    mkdirSync(resolve(seed, "src/mcp"), { recursive: true });
    writeFileSync(resolve(seed, "src/cli.ts"), "console.log('cli')\n");
    writeFileSync(resolve(seed, "src/mcp/main.ts"), "console.log('mcp')\n");
    for (const name of ["kanban", "host-track-refresh", "kanban-host-track-refresh"]) {
      writeFileSync(resolve(seed, "bin", name), `#!/usr/bin/env bash\necho ${name}\n`);
      chmodSync(resolve(seed, "bin", name), 0o755);
    }
    await run(["git", "add", "."], seed);
    await run(["git", "commit", "-q", "-m", "initial"], seed);
    await run(["git", "remote", "add", "origin", remote], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);
    // A second branch one commit ahead of main — stands in for "the real
    // gate has moved further than what this refresh just fetched/merged".
    await run(["git", "checkout", "-q", "-b", "ahead"], seed);
    writeFileSync(resolve(seed, "README.md"), "ahead\n");
    await run(["git", "add", "README.md"], seed);
    await run(["git", "commit", "-q", "-m", "ahead"], seed);
    await run(["git", "push", "-q", "origin", "ahead"], seed);

    const env = {
      FKANBAN_HOST_TRACK_REMOTE: remote,
      FKANBAN_HOST_TRACK_DIR: host,
      FKANBAN_HOST_TRACK_BIN_DIR: bin,
      FKANBAN_HOST_TRACK_STAMP_DIR: stamps,
      FKANBAN_HOST_TRACK_SKIP_INSTALL: "1",
      FKANBAN_HOST_TRACK_GATE_REF: "refs/heads/ahead",
    };
    const result = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), env);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("WARNING checkout still behind gate after refresh");
    expect(result.stdout).not.toContain("kanban host-track refreshed");
    expect(await Bun.file(resolve(stamps, "kanban.json")).json()).toMatchObject({ stale: true });
  }, 60_000);
});
