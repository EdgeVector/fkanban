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

describe("missing-argument exit code (usage error → exit 2)", () => {
  // Every "Missing argument …" case routes through requirePositional(), so
  // covering a representative spread of commands proves the seam, not each one.
  const cases: Array<{ name: string; args: string[] }> = [
    { name: "search (missing query)", args: ["search"] },
    { name: "move (missing slug + column)", args: ["move"] },
    { name: "move (missing column)", args: ["move", "some-card"] },
    { name: "add (missing slug)", args: ["add"] },
    { name: "show (missing slug)", args: ["show"] },
    { name: "board create (missing slug)", args: ["board", "create"] },
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

  test("bare invocation prints help and exits 0 (unchanged)", async () => {
    const { code } = await runCli([]);
    expect(code).toBe(0);
  });
});
