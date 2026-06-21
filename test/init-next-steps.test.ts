// `fkanban init` ends by guiding the dev's next action: on a genuine first-time
// fkanban setup — no prior config, OR a freshly bootstrapped node — it prints a
// copy-pasteable Next steps block (list / add / register the MCP server); on an
// idempotent re-init (config already present) it collapses to a single quiet
// line. `runInit` computes that combined first-time-setup flag
// (`bootstrapped || existing === null`) and passes it to `printNextSteps`, so
// these tests drive `printNextSteps` directly with the resolved boolean. The
// Next steps emission is threaded through the same injectable `print` callback
// as the rest of `init`, so we assert on captured lines without a live node.
//
// The printed `list`/`add`/re-init commands are shim-aware: they use the global
// `fkanban` shim when it's on PATH, else `bun run src/cli.ts` from the repo (the
// fresh-clone default, before `bun run install-cli`) — so copy-pasting never
// hits `command not found: fkanban`. We pass the invocation explicitly here so
// the assertions are deterministic regardless of whether the CI runner has the
// shim on PATH. See cards `init-print-next-steps`,
// `cli-init-next-steps-shim-aware-commands`.

import { describe, expect, test } from "bun:test";
import { printNextSteps } from "../src/commands/init.ts";

// `printNextSteps`'s gate is the combined first-time-setup flag that `runInit`
// computes as `bootstrapped || existing === null`. We pass the resolved boolean
// here (true = first-time setup, false = re-init over an existing config).
function capture(firstTimeSetup: boolean, invocation: string): string[] {
  const lines: string[] = [];
  printNextSteps((line) => lines.push(line), firstTimeSetup, invocation);
  return lines;
}

describe("init next-steps", () => {
  test("fresh bootstrap prints the full Next steps block (shim form)", () => {
    const out = capture(true, "fkanban").join("\n");
    expect(out).toContain("Next steps:");
    expect(out).toContain("fkanban list");
    expect(out).toContain("fkanban add my-first-card --title");
    // The MCP register command must be surfaced (form depends on PATH shim).
    expect(out).toMatch(/claude mcp add fkanban -- (fkanban mcp|bun .+\/src\/mcp\/main\.ts)/);
  });

  test("fresh bootstrap on a shim-less clone prints runnable `bun run src/cli.ts` commands", () => {
    const out = capture(true, "bun run src/cli.ts").join("\n");
    expect(out).toContain("Next steps:");
    expect(out).toContain("bun run src/cli.ts list");
    expect(out).toContain("bun run src/cli.ts add my-first-card --title");
    // No bare-`fkanban list`/`fkanban add` form (it would `command not found`).
    expect(out).not.toMatch(/^\s*fkanban list\b/m);
    expect(out).not.toMatch(/^\s*fkanban add\b/m);
  });

  test("first-time setup on an already-provisioned node prints the full Next steps block", () => {
    // The node was already provisioned (so `bootstrapped` is false), but there
    // was no prior `~/.fkanban/config.json` (`existing === null`) — a genuine
    // first-time fkanban setup. `runInit` resolves the combined flag to true,
    // so the MCP-registration hint must still be surfaced.
    const out = capture(true, "fkanban").join("\n");
    expect(out).toContain("Next steps:");
    expect(out).toContain("fkanban add my-first-card --title");
    expect(out).toMatch(/claude mcp add fkanban -- (fkanban mcp|bun .+\/src\/mcp\/main\.ts)/);
  });

  test("idempotent re-init collapses to a single quiet line, no Next steps block", () => {
    const lines = capture(false, "fkanban");
    const out = lines.join("\n");
    expect(out).toContain("Already initialized");
    expect(out).toContain("fkanban list");
    expect(out).not.toContain("Next steps:");
    expect(out).not.toContain("claude mcp add");
    // Quiet: a single blank separator + the one-line hint.
    expect(lines.filter((l) => l.trim().length > 0)).toHaveLength(1);
  });

  test("idempotent re-init uses the shim-less invocation form when there's no shim", () => {
    const out = capture(false, "bun run src/cli.ts").join("\n");
    expect(out).toContain("Already initialized — run `bun run src/cli.ts list`");
  });
});
