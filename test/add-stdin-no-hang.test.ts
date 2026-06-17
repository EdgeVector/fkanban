// `fkanban add` must never hang on a stdin that won't reach EOF.
//
// `add` optionally sources its `--body` from piped stdin, so it used to drain
// stdin to EOF with `for await (...of process.stdin)`. Under Bun a pipe that a
// parent opens but never writes to or closes — the shape of a background- or
// agent-spawned `add` that inherits stdin without closing it — never delivers
// EOF, so that drain blocked forever and the card write below it never ran.
// This was the "`add` never exits / silently failed to persist the card" bug.
//
// These spawn the real CLI with a stdin pipe we deliberately hold OPEN (never
// `.end()`), against a config that points at a dead node so `add` fails fast
// once it gets past the stdin read. If the bounded read regressed, the process
// would hang and `proc.exited` would never resolve — the watchdog kills it and
// the test fails. With the fix it exits well under the watchdog.

import { afterAll, beforeAll, expect, test } from "bun:test";
import { fileURLToPath } from "node:url";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const CLI = fileURLToPath(new URL("../src/cli.ts", import.meta.url));

let dir: string;
let configPath: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "fkanban-stdin-"));
  configPath = join(dir, "config.json");
  writeFileSync(
    configPath,
    JSON.stringify({
      configVersion: 1,
      // 127.0.0.1:1 refuses instantly, so `add` exits the moment it reaches the
      // node call — the only thing under test is that it gets there at all.
      nodeUrl: "http://127.0.0.1:1",
      schemaServiceUrl: "http://127.0.0.1:1",
      userHash: "deadbeef",
      schemaHashes: { card: "card-hash", board: "board-hash" },
    }),
  );
});

afterAll(() => {
  rmSync(dir, { recursive: true, force: true });
});

// Spawn the CLI with stdin held open (never closed) and resolve with the exit
// code, or "HUNG" if a watchdog had to kill it.
async function runWithOpenStdin(args: string[]): Promise<number | "HUNG"> {
  const proc = Bun.spawn(["bun", "run", CLI, ...args], {
    stdin: "pipe", // we never write or .end() this → child's stdin never EOFs
    stdout: "ignore",
    stderr: "ignore",
    env: {
      ...process.env,
      FKANBAN_CONFIG: configPath,
      // No socket under here → owner-session attestation fails fast, unattested.
      FOLDDB_HOME: dir,
      // Tiny grace so the "no first byte" give-up is near-instant in the test.
      FKANBAN_STDIN_IDLE_MS: "50",
    },
  });

  let timer: ReturnType<typeof setTimeout> | undefined;
  const watchdog = new Promise<"HUNG">((resolve) => {
    timer = setTimeout(() => {
      proc.kill();
      resolve("HUNG");
    }, 8000);
  });

  const result = await Promise.race([proc.exited, watchdog]);
  if (timer) clearTimeout(timer);
  return result;
}

test("add with --body flag does not touch stdin (exits despite a never-EOF stdin)", async () => {
  const result = await runWithOpenStdin([
    "add",
    "zz-stdin-nohang",
    "--title",
    "probe",
    "--column",
    "backlog",
    "--body",
    "body from flag",
  ]);
  // Exits (any code) rather than hanging. A dead node → non-zero, but the point
  // is it RETURNED.
  expect(result).not.toBe("HUNG");
}, 12000);

test("add without --body gives up on a silent never-EOF stdin instead of hanging", async () => {
  const result = await runWithOpenStdin([
    "add",
    "zz-stdin-nohang",
    "--title",
    "probe",
    "--column",
    "backlog",
  ]);
  expect(result).not.toBe("HUNG");
}, 12000);
