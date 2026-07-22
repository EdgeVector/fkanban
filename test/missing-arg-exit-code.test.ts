// A missing required positional argument is a *usage* error — "you invoked
// the CLI wrong" — so it must exit 2, matching the unknown-command and
// unknown-flag contracts. Operational failures (node down, card missing,
// blocked) stay exit 1, so an agent driving the CLI can tell "bad invocation"
// (2) from "the board op failed" (1). See card `missing-arg-exit-code-2`.
//
// These run the real CLI as a subprocess. requirePositional() throws before
// any node/config access, so the missing-arg cases need no running folddb
// node. (`show <missing>` does reach the node; its exit-1 contract is asserted
// in unit.test.ts against an ephemeral node and is not re-derived here.)

import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pkg from "../package.json";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const REPO_ROOT = resolve(dirname(CLI), "..");

async function runCli(
  args: string[],
  env: Record<string, string> = {},
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
    env: { ...process.env, ...env },
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("missing-argument exit code (usage error → exit 2)", () => {
  // Every "Missing argument …" case routes through requirePositional(), so
  // covering a representative spread of commands proves the seam, not each one.
  // These commands all run requirePositional() *before* loadCtx(), so they
  // throw missing_arg with no config/node present (the CI runner has neither).
  // (`board create` / `dep` load config first, so their missing-arg path is
  // gated behind config and would need a node in CI — not exercised here.)
  const cases: Array<{ name: string; args: string[] }> = [
    { name: "search (missing query)", args: ["search"] },
    { name: "move (missing slug + column)", args: ["move"] },
    { name: "move (missing column)", args: ["move", "some-card"] },
    { name: "add (missing slug)", args: ["add"] },
    { name: "show (missing slug)", args: ["show"] },
    { name: "rm (missing slug)", args: ["rm"] },
  ];

  for (const { name, args } of cases) {
    test(`${name} → exit 2 with a Missing-argument usage message`, async () => {
      const { code, stderr } = await runCli(args);
      expect(code).toBe(2);
      expect(stderr).toContain("Missing argument");
    });
  }

  test("unknown command stays exit 2 (unchanged usage-error contract)", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown command");
  });

  test("which prints CLI provenance without reaching config/node", async () => {
    const { code, stdout, stderr } = await runCli(["which"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain(`fkanban v${pkg.version}`);
    expect(stdout).toContain("executable_path:");
    expect(stdout).toContain("source_path:");
    expect(stdout).toContain("bun_path:");
  });

  test("which --json prints stable machine-readable provenance", async () => {
    const { code, stdout, stderr } = await runCli(["which", "--json"]);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as {
      package: string;
      version: string;
      executable_path: string;
      source_path: string;
      bun_path: string;
      bun_version: string;
    };
    expect(report.package).toBe(pkg.name);
    expect(report.version).toBe(pkg.version);
    expect(report.executable_path).toContain("src/cli.ts");
    expect(report.source_path).toContain("src/cli.ts");
    expect(typeof (report as { in_host_track?: unknown }).in_host_track).toBe("boolean");
    expect(typeof (report as { expected_host_track?: unknown }).expected_host_track).toBe("string");
    expect(report.bun_path.length).toBeGreaterThan(0);
    expect(report.bun_version.length).toBeGreaterThan(0);
  });

  test("which --check exits nonzero when the CLI is not host-track managed", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "fkanban-which-not-host-track-"));
    const { code, stdout, stderr } = await runCli(["which", "--check"], { HOME: home });
    expect(code).toBe(1);
    expect(stderr).toBe("");
    expect(stdout).toContain("in_host_track: false");
  });

  test("which --check exits zero when the source root resolves under legacy host-track", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "fkanban-which-host-track-"));
    mkdirSync(resolve(home, ".host-track"), { recursive: true });
    symlinkSync(REPO_ROOT, resolve(home, ".host-track/fkanban"));
    const { code, stdout, stderr } = await runCli(["which", "--check"], { HOME: home });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("in_host_track: true");
  });

  test("which --check exits zero under local-safe apps/fkanban layout", async () => {
    // Kind B install root: ~/.host-track/apps/fkanban (versions/current underneath).
    // Symlink the install root at REPO_ROOT so source_root is pathWithin it.
    const home = mkdtempSync(resolve(tmpdir(), "fkanban-which-apps-host-track-"));
    mkdirSync(resolve(home, ".host-track/apps"), { recursive: true });
    symlinkSync(REPO_ROOT, resolve(home, ".host-track/apps/fkanban"));
    const { code, stdout, stderr } = await runCli(["which", "--check"], { HOME: home });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("in_host_track: true");
    // expected_host_track may be the realpath of the apps/fkanban symlink
  });

  test("which --check honors FKANBAN_HOST_TRACK_DIR override", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "fkanban-which-override-"));
    const { code, stdout, stderr } = await runCli(["which", "--check"], {
      HOME: home,
      FKANBAN_HOST_TRACK_DIR: REPO_ROOT,
    });
    expect(code).toBe(0);
    expect(stderr).toBe("");
    expect(stdout).toContain("in_host_track: true");
  });

  test("which accepts the host-track refresh alias advertised by the manifest", async () => {
    const home = mkdtempSync(resolve(tmpdir(), "fkanban-which-refresh-"));
    mkdirSync(resolve(home, ".host-track"), { recursive: true });
    symlinkSync(REPO_ROOT, resolve(home, ".host-track/fkanban"));
    const env = {
      HOME: home,
      PATH: `${resolve(REPO_ROOT, "bin")}:${process.env.PATH ?? ""}`,
    };
    const { code, stdout, stderr } = await runCli(["which", "kanban-host-track-refresh", "--json", "--check"], env);
    expect(code).toBe(0);
    expect(stderr).toBe("");
    const report = JSON.parse(stdout) as { command: string; under_host_track: boolean; issues: string[] };
    expect(report.command).toBe("kanban-host-track-refresh");
    expect(report.under_host_track).toBe(true);
    expect(report.issues).toEqual([]);
  });

  test("bare invocation prints help and exits 0 (unchanged)", async () => {
    const { code } = await runCli([]);
    expect(code).toBe(0);
  });
});
