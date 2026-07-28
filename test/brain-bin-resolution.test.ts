// The brain CLI is `brain`; `fbrain` was the old name and is gone from PATH.
//
// Why this file exists: brain_checkpoint spawned the literal string "fbrain".
// The spawn failed with ENOENT, the module downgraded that to a warning, and so
// EVERY card completion checkpoint was silently skipped — `kanban move <slug>
// done` still reported success while the durable record was never written:
//
//   fkanban: warning: F-Brain completion checkpoint skipped for `<slug>`
//   (Executable not found in $PATH: "fbrain"); card write still applied.
//
// A rename that only breaks a best-effort side path is exactly the kind that
// survives for months, so pin the resolution rather than the spelling.

import { afterEach, describe, expect, test } from "bun:test";

import { brainBinForTest, resetBrainBinForTest } from "../src/brain_checkpoint.ts";

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_OVERRIDE = process.env.FKANBAN_BRAIN_BIN;

function restoreEnv(): void {
  if (ORIGINAL_PATH === undefined) delete process.env.PATH;
  else process.env.PATH = ORIGINAL_PATH;
  if (ORIGINAL_OVERRIDE === undefined) delete process.env.FKANBAN_BRAIN_BIN;
  else process.env.FKANBAN_BRAIN_BIN = ORIGINAL_OVERRIDE;
  resetBrainBinForTest();
}

/** A PATH dir holding executables with the given names. */
async function pathWith(names: string[]): Promise<string> {
  const dir = `/tmp/fkanban-brain-bin-${names.join("-") || "empty"}-${process.pid}`;
  await Bun.$`mkdir -p ${dir}`.quiet();
  for (const n of names) {
    await Bun.write(`${dir}/${n}`, "#!/bin/sh\nexit 0\n");
    await Bun.$`chmod +x ${dir}/${n}`.quiet();
  }
  return dir;
}

afterEach(restoreEnv);

describe("brain CLI binary resolution", () => {
  test("resolves `brain` — the name actually installed today", async () => {
    process.env.PATH = await pathWith(["brain"]);
    resetBrainBinForTest();
    expect(brainBinForTest()).toBe("brain");
  });

  test("prefers `brain` over a leftover `fbrain` when both exist", async () => {
    process.env.PATH = await pathWith(["brain", "fbrain"]);
    resetBrainBinForTest();
    expect(brainBinForTest()).toBe("brain");
  });

  test("falls back to `fbrain` on a host that still only has the old name", async () => {
    process.env.PATH = await pathWith(["fbrain"]);
    resetBrainBinForTest();
    expect(brainBinForTest()).toBe("fbrain");
  });

  test("FKANBAN_BRAIN_BIN overrides resolution", async () => {
    process.env.PATH = await pathWith(["brain", "fbrain"]);
    process.env.FKANBAN_BRAIN_BIN = "/opt/custom/brain";
    resetBrainBinForTest();
    expect(brainBinForTest()).toBe("/opt/custom/brain");
  });

  test("with neither on PATH, names the CURRENT binary so the error is actionable", async () => {
    process.env.PATH = await pathWith([]);
    resetBrainBinForTest();
    // The old code hard-coded the dead name here, which sent every reader
    // looking for a binary that was renamed rather than missing.
    expect(brainBinForTest()).toBe("brain");
  });
});
