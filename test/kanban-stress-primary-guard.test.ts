// The stress harness isolates the BOARD but not the NODE. Driving
// KSTRESS_BURST concurrent writers at the shared primary degrades every other
// agent's card moves AND contaminates the harness's own latency numbers,
// because `index_wait` on the node is a global cross-writer barrier (brain
// lastdb-mutation-convergence-wait-was-a-global-barrier, fold #984). Measured
// 2026-07-31: an orphaned run at BURST=10 drove live kanban writes to a 26.4s
// average, p95 72.8s, while lastgit issued zero mutations.
//
// These tests drive the real script with HOME pointed at a temp dir, so the
// "primary" sockets are files this test controls and nothing depends on the
// developer's machine.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, chmodSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "kanban-stress.sh");

// Answers `board list` with an empty array and ACKs anything else, so a run that
// gets past the guard reaches the real legs instead of dying on a stub miss.
const STUB = `#!/usr/bin/env bash
case "$1 $2" in
  "board list") printf '[]\\n' ;;
  *) printf '{"slug":"%s"}\\n' "$3" ;;
esac
`;

/**
 * Build a throwaway HOME containing the primary socket the guard looks for.
 * The socket path must be derived from the SAME home the run uses, so home
 * creation is separate from running.
 */
function makeHome(opts: { folddbSymlinksToLastdb?: boolean } = {}) {
  const home = mkdtempSync(join(tmpdir(), "kstress-guard-"));
  const stub = join(home, "kanban-stub.sh");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);

  // Materialize the primary socket path the guard checks for. A regular file is
  // enough: the guard compares canonical paths and never dials it.
  const lastdbData = join(home, ".lastdb", "data");
  mkdirSync(lastdbData, { recursive: true });
  writeFileSync(join(lastdbData, "folddb.sock"), "");
  if (opts.folddbSymlinksToLastdb) {
    symlinkSync(join(home, ".lastdb"), join(home, ".folddb"));
  }

  return {
    home,
    stub,
    primarySocket: join(lastdbData, "folddb.sock"),
    compatSocket: join(home, ".folddb", "data", "folddb.sock"),
    isolatedSocket: join(home, "isolated-node", "data", "folddb.sock"),
  };
}

function runHarness(
  h: ReturnType<typeof makeHome>,
  opts: { socket?: string; allowPrimary?: boolean } = {},
) {
  const proc = Bun.spawnSync(["bash", scriptPath], {
    env: {
      ...process.env,
      HOME: h.home,
      FKANBAN: h.stub,
      KSTRESS_N: "0",
      KSTRESS_BURST: "0",
      // Keep the developer's real config out of resolution entirely.
      KANBAN_CONFIG: join(h.home, "config-does-not-exist.json"),
      ...(opts.socket ? { FOLDDB_SOCKET_PATH: opts.socket } : {}),
      ...(opts.allowPrimary ? { KSTRESS_ALLOW_PRIMARY: "1" } : {}),
    },
  });

  return { stdout: proc.stdout.toString(), exitCode: proc.exitCode ?? -1 };
}

const hasJq = Bun.which("jq") !== null;

describe("kanban-stress refuses the shared primary node", () => {
  test.if(hasJq)("refuses a run pointed at ~/.lastdb/data/folddb.sock", () => {
    const h = makeHome();
    const { stdout, exitCode } = runHarness(h, { socket: h.primarySocket });

    expect(stdout).toContain("refusing to stress the shared primary");
    // Exit 0 is load-bearing: a nonzero exit cancels the scheduled-run queue.
    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUMMARY:");
    expect(stdout).toContain("errors=1");
    // It must bail BEFORE any leg runs, or it has already done the damage.
    expect(stdout).not.toContain("kanban-stress run=");
  });

  test.if(hasJq)("refuses via the ~/.folddb compat path that symlinks to the primary", () => {
    // Same node, legacy name. A string compare would let this through; the
    // guard canonicalizes both sides before comparing.
    const h = makeHome({ folddbSymlinksToLastdb: true });
    const { stdout, exitCode } = runHarness(h, { socket: h.compatSocket });

    expect(stdout).toContain("refusing to stress the shared primary");
    expect(exitCode).toBe(0);
    expect(stdout).not.toContain("kanban-stress run=");
  });

  test.if(hasJq)("KSTRESS_ALLOW_PRIMARY=1 forces a deliberate supervised run", () => {
    const h = makeHome();
    const { stdout, exitCode } = runHarness(h, {
      socket: h.primarySocket,
      allowPrimary: true,
    });

    expect(stdout).not.toContain("refusing to stress the shared primary");
    expect(stdout).toContain("kanban-stress run=");
    expect(exitCode).toBe(0);
  });

  test.if(hasJq)("an isolated socket runs without the guard firing", () => {
    const h = makeHome();
    const { stdout, exitCode } = runHarness(h, { socket: h.isolatedSocket });

    expect(stdout).not.toContain("refusing to stress the shared primary");
    expect(stdout).toContain("kanban-stress run=");
    expect(exitCode).toBe(0);
  });
});
