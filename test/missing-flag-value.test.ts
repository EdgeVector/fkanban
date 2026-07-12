// A flag fed a missing or dash-leading value via the SPACE form
// (`add --title --column todo`, `list --limit -5`) must produce a clean
// kanban-styled one-line error — never Node's raw `parseArgs` internals
// (the `-XYZ` placeholder advice) and never a visible `..` double-period.
// Exit code stays 2. The `=` form (`--limit=-5`) keeps its own #34 validation
// path and must remain unchanged. See card `clean-parseargs-missing-value-error`.
//
// These run the real CLI as a subprocess. The throw happens at the arg-parsing
// seam, before any node/config access, so they need no running folddb node.

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

describe("missing / dash-leading flag value (clean message, not parseArgs internals)", () => {
  test("add: --title with no value (next token is a flag) → clean one-liner, exit 2", async () => {
    const { code, stderr } = await runCli(["add", "x", "--title", "--column", "todo"]);
    expect(code).toBe(2);
    // No Node internals, no double-period.
    expect(stderr).not.toContain("-XYZ");
    expect(stderr).not.toContain("..");
    // One non-empty line on stderr.
    expect(stderr.trim().split("\n").length).toBe(1);
    // kanban voice: names the flag and points at help.
    expect(stderr).toContain("--title");
    expect(stderr).toContain("kanban add --help");
  });

  test("list: --limit -5 (dash-leading value, space form) → clean one-liner, exit 2", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "-5"]);
    expect(code).toBe(2);
    expect(stderr).not.toContain("-XYZ");
    expect(stderr).not.toContain("..");
    expect(stderr.trim().split("\n").length).toBe(1);
    expect(stderr).toContain("kanban list --help");
  });

  test("list: --limit=-5 (=-form) keeps the #34 validation message, unchanged", async () => {
    const { code, stderr } = await runCli(["list", "--limit=-5"]);
    expect(code).toBe(2);
    expect(stderr).toContain("--limit must be a positive integer");
    expect(stderr).toContain('got "-5"');
  });
});
