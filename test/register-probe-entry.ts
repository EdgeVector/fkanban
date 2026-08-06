// A standalone entrypoint that prints what `src/mcp/register.ts` resolves, so
// `compiled-artifact-provenance.test.ts` can ask that module its question from
// INSIDE a `bun build --compile` executable.
//
// Not a test file (no `.test.ts`, so `bun test` does not collect it) — it is
// compiled by the test as a second artifact. Why a separate entry rather than
// the shipped `dist/kanban`: the registration surface is printed only by
// `kanban init` (which writes config) and `kanban doctor` (which runs write
// probes against the node), and a unit test must not do either. What matters
// for the defect is the PACKAGING, not which entry was compiled — in any
// `--compile` output `import.meta.url` resolves into the executable's embedded
// filesystem, which is the condition register.ts was blind to. Verified: built
// from the pre-fix module this probe reproduces the reported line verbatim,
// `claude mcp add fkanban -- bun /$bunfs/root/<name>/src/mcp/main.ts`.
//
// The separate claim — that `<execPath> mcp` really serves MCP — is asserted
// against the shipped binary itself, in the same test file.
import { fkanbanInvocation, mcpAddCommand, mcpEntrypointPath, registrationShape } from "../src/mcp/register.ts";
import { realpathSync } from "node:fs";

function onDisk(path: string | null): boolean {
  if (!path) return false;
  try {
    realpathSync.native(path);
    return true;
  } catch {
    return false;
  }
}

const entrypoint = mcpEntrypointPath();
console.log(
  JSON.stringify({
    shape: registrationShape(),
    command: mcpAddCommand(),
    entrypoint,
    entrypoint_on_disk: onDisk(entrypoint),
    invocation: fkanbanInvocation(),
    exec_path: process.execPath,
  }),
);
