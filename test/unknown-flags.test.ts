// Unknown/misspelled CLI flags must error with a clean hint and exit 2 —
// matching the unknown-*command* contract — instead of being silently
// swallowed (which used to drop data: a typo'd `--titel` created a
// title-less card while still exiting 0). See card `reject-unknown-flags`.
//
// These run the real CLI as a subprocess. Flag parsing happens before any
// node/config access, so these need no running folddb node.

import { describe, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdout: "pipe",
    stderr: "pipe",
    stdin: "ignore",
  });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { code, stdout, stderr };
}

describe("unknown-flag rejection", () => {
  test("add: a typo'd --titel errors with exit 2 and a per-command hint", async () => {
    const { code, stderr } = await runCli(["add", "zz", "--titel", "My Title", "--column", "todo"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--titel");
    expect(stderr.toLowerCase()).toContain("unknown option");
    expect(stderr).toContain("fkanban add --help");
  });

  test("add: a typo'd --colum (column) errors with exit 2 — no silent default", async () => {
    const { code, stderr } = await runCli(["add", "zz2", "--title", "T2", "--colum", "review"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--colum");
  });

  test("list: an unknown --bogusflag errors with exit 2 and a list-scoped hint", async () => {
    const { code, stderr } = await runCli(["list", "--bogusflag"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--bogusflag");
    expect(stderr).toContain("fkanban list --help");
  });

  test("list: --tag is now a recognized flag (NOT an unknown-flag exit 2)", async () => {
    // `--tag` is a first-class list filter, so it must not trip the
    // unknown-flag rejection. (It may still exit non-zero if no node is
    // reachable in CI, but never with the exit-2 unknown-flag contract, and
    // never with the unknown-flag hint.)
    const { code, stderr } = await runCli(["list", "--tag", "test"]);
    expect(code).not.toBe(2);
    expect(stderr).not.toContain("Unknown option");
  });

  test("known flags still parse: `add --help` prints help and exits 0", async () => {
    const { code, stdout } = await runCli(["add", "--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("fkanban add");
  });

  test("--version still works (exit 0)", async () => {
    const { code, stdout } = await runCli(["--version"]);
    expect(code).toBe(0);
    expect(stdout.trim().length).toBeGreaterThan(0);
  });

  test("unknown *command* contract is unchanged (exit 2)", async () => {
    const { code, stderr } = await runCli(["frobnicate"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Unknown command");
  });
});
