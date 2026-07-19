import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, readlinkSync, rmSync, writeFileSync } from "node:fs";
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
    for (const name of ["kanban", "kanban-mcp", "fkanban", "fkanban-mcp", "host-track-refresh", "kanban-host-track-refresh"]) {
      writeFileSync(resolve(seed, "bin", name), `#!/usr/bin/env bash\necho ${name}\n`);
      chmodSync(resolve(seed, "bin", name), 0o755);
    }
    writeFileSync(resolve(seed, "README.md"), "one\n");
    await run(["git", "add", "."], seed);
    await run(["git", "commit", "-q", "-m", "initial"], seed);
    await run(["git", "remote", "add", "origin", remote], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);

    const env = {
      FKANBAN_HOST_TRACK_REMOTE: remote,
      FKANBAN_HOST_TRACK_DIR: host,
      FKANBAN_HOST_TRACK_BIN_DIR: bin,
      FKANBAN_HOST_TRACK_STAMP_DIR: stamps,
      FKANBAN_HOST_TRACK_SKIP_INSTALL: "1",
    };
    const first = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), env);
    expect(first.code).toBe(0);
    expect(readlinkSync(resolve(bin, "kanban"))).toBe(`${host}/bin/kanban`);
    expect(readlinkSync(resolve(bin, "fkanban"))).toBe(`${host}/bin/fkanban`);
    expect(await Bun.file(resolve(stamps, "kanban.json")).json()).toMatchObject({
      app: "kanban",
      command: "kanban",
      kind: "B checkout-shim",
      stale: false,
    });
    expect(await Bun.file(resolve(stamps, "fkanban.json")).json()).toMatchObject({
      app: "fkanban",
      command: "fkanban",
      exec_path: `${bin}/fkanban`,
      kind: "B checkout-shim",
      stale: false,
    });

    writeFileSync(resolve(seed, "README.md"), "two\n");
    await run(["git", "add", "README.md"], seed);
    await run(["git", "commit", "-q", "-m", "update"], seed);
    await run(["git", "push", "-q", "origin", "main"], seed);

    const second = await run(["bash", "bin/host-track-refresh"], resolve(import.meta.dir, ".."), env);
    expect(second.code).toBe(0);
    expect(await Bun.file(resolve(host, "README.md")).text()).toBe("two\n");
  }, 30_000);
});
