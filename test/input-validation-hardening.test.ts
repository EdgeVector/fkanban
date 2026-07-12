// CLI input validation must reject malformed invocations before any config/node
// access: surplus positionals, non-decimal integer spellings, and unknown
// board/dep/tag subcommands should all produce clean usage errors (exit 2).

import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));
const NO_CONFIG = join(tmpdir(), `fkanban-input-validation-no-config-${process.pid}.json`);
const NO_SOCKET = join(tmpdir(), `fkanban-input-validation-no-socket-${process.pid}.sock`);

async function runCli(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    env: { ...process.env, FKANBAN_CONFIG: NO_CONFIG, FOLDDB_SOCKET_PATH: NO_SOCKET },
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

describe("surplus positional rejection", () => {
  test("move rejects a third positional instead of silently dropping it", async () => {
    const { code, stderr } = await runCli(["move", "ship-login", "doing", "done"]);
    expect(code).toBe(2);
    expect(stderr).toContain("Too many arguments");
    expect(stderr).toContain('"done"');
    expect(stderr).toContain("kanban move <slug> <column>");
  });

  test("a valid move invocation is not rejected as a usage error", async () => {
    const { code, stderr } = await runCli(["move", "ship-login", "doing"]);
    expect(code).not.toBe(2);
    expect(stderr).not.toContain("Too many arguments");
  });

  test("other fixed-arity commands reject surplus positionals before node access", async () => {
    for (const args of [
      ["add", "slug", "extra"],
      ["show", "slug", "junk"],
      ["rm", "slug", "junk"],
      ["board", "list", "junk"],
    ]) {
      const { code, stderr } = await runCli(args);
      expect(code).toBe(2);
      expect(stderr).toContain("Too many arguments");
    }
  });
});

describe("strict decimal integer flags", () => {
  test("list rejects scientific and hex limit spellings", async () => {
    for (const value of ["1e3", "0x10"]) {
      const { code, stderr } = await runCli(["list", "--limit", value]);
      expect(code).toBe(2);
      expect(stderr).toContain("--limit must be a positive integer");
      expect(stderr).toContain(`got "${value}"`);
    }
  });

  test("plain decimal limit is accepted by validation", async () => {
    const { code, stderr } = await runCli(["list", "--limit", "1000"]);
    expect(code).not.toBe(2);
    expect(stderr).not.toContain("--limit must be a positive integer");
  });
});

describe("subcommand validation before context loading", () => {
  test("board bogus reports unknown subcommand, not missing config/node", async () => {
    const { code, stderr } = await runCli(["board", "bogus"]);
    expect(code).toBe(2);
    expect(stderr).toContain('Unknown board subcommand "bogus"');
    expect(stderr).not.toContain(NO_CONFIG);
    expect(stderr).not.toContain("config");
  });

  test("dep/tag bogus report unknown subcommand before missing arguments or context", async () => {
    const dep = await runCli(["dep", "bogus"]);
    expect(dep.code).toBe(2);
    expect(dep.stderr).toContain('Unknown dep subcommand "bogus"');
    expect(dep.stderr).not.toContain("Missing argument");

    const tag = await runCli(["tag", "bogus"]);
    expect(tag.code).toBe(2);
    expect(tag.stderr).toContain('Unknown tag subcommand "bogus"');
    expect(tag.stderr).not.toContain("Missing argument");
  });
});
