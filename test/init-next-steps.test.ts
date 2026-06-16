// `fkanban init` ends by guiding the dev's next action: on a fresh bootstrap it
// prints a copy-pasteable Next steps block (list / add / register the MCP
// server); on an idempotent re-init it collapses to a single quiet line. The
// Next steps emission is threaded through the same injectable `print` callback
// as the rest of `init`, so we assert on captured lines without a live node.
// See card `init-print-next-steps`.

import { describe, expect, test } from "bun:test";
import { printNextSteps } from "../src/commands/init.ts";

function capture(bootstrapped: boolean): string[] {
  const lines: string[] = [];
  printNextSteps((line) => lines.push(line), bootstrapped);
  return lines;
}

describe("init next-steps", () => {
  test("fresh bootstrap prints the full Next steps block", () => {
    const out = capture(true).join("\n");
    expect(out).toContain("Next steps:");
    expect(out).toContain("fkanban list");
    expect(out).toContain("fkanban add my-first-card --title");
    // The MCP register command must be surfaced (form depends on PATH shim).
    expect(out).toMatch(/claude mcp add fkanban -- (fkanban mcp|bun .+\/src\/mcp\/main\.ts)/);
  });

  test("idempotent re-init collapses to a single quiet line, no Next steps block", () => {
    const lines = capture(false);
    const out = lines.join("\n");
    expect(out).toContain("Already initialized");
    expect(out).toContain("fkanban list");
    expect(out).not.toContain("Next steps:");
    expect(out).not.toContain("claude mcp add");
    // Quiet: a single blank separator + the one-line hint.
    expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(1);
  });
});
