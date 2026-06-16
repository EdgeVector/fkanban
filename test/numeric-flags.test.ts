// Numeric CLI flags (`list --limit`, `move --position`) must validate their
// argument and reject a non-numeric or out-of-range value LOUDLY — exit 2 + a
// one-line per-command hint — instead of silently swallowing it into a default
// (the old behavior: `--limit abc` exited 0 with the default cap; `--limit 0`
// silently meant unbounded). Same "validate input loudly" contract as the
// unknown-flag rejection. See card `validate-numeric-flags-limit-position`.
//
// These run the real CLI as a subprocess. The rejection happens at the
// arg-parsing seam, before any node/config access, so they need no folddb node.

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

describe("numeric-flag validation", () => {
  test("list: --limit abc errors with exit 2 and a list-scoped hint", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain('got "abc"');
    expect(stderr).toContain("fkanban list --help");
  });

  test("list: --limit 12abc (partial-numeric) is rejected, not coerced to 12", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "12abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain('got "12abc"');
  });

  test("list: --limit 0 errors with exit 2 and points at --all", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "0"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain("Use --all to show everything");
  });

  test("move: --position abc errors with exit 2 and a move-scoped hint", async () => {
    const { code, stderr } = await runCli(["move", "zz", "todo", "--position", "abc"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--position must be an integer >= 0");
    expect(stderr).toContain('got "abc"');
    expect(stderr).toContain("fkanban move --help");
  });

  test("move: a negative --position is rejected (positions are non-negative)", async () => {
    const { code, stderr } = await runCli(["move", "zz", "todo", "--position=-1"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--position must be an integer >= 0");
  });
});
