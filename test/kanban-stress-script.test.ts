import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "kanban-stress.sh");
const script = readFileSync(scriptPath, "utf8");

describe("kanban-stress harness schema drift guards", () => {
  test("uses the fixed board column list everywhere", () => {
    expect(script).toContain('FIXED_COLUMNS="backlog,todo,doing,done"');
    expect(script).not.toContain("backlog,todo,doing,review,done");
    expect(script).not.toContain("--columns a,b,c");
  });

  test("never targets the retired review column in the move leg", () => {
    expect(script).toContain("for col in doing done; do");
    expect(script).not.toContain("for col in doing review done");
  });

  test("board create failures are loud harness errors, not masked no-ops", () => {
    expect(script).toContain("ensure_board()");
    expect(script).toContain("errlog \"board create");
    expect(script).not.toContain("board create \"$BOARD\"");
    expect(script).not.toMatch(/board create[^\n]*\|\| true/);
  });

  // `normalizeKind` maps an unset kind to "pr", so an add that omits --kind
  // creates a Kind:pr card, and the placement guards reject a milestone-less
  // one entering todo/doing. Every such add failed rc=1 and was reported as a
  // "did not ACK" consistency finding against LastDB.
  //
  // Asserted over the ACTUAL add invocations rather than as a substring count:
  // a `toContain("--kind")` would pass while a single leg still omitted it,
  // which is precisely the shape of bug this pins.
  const addLines = script
    .split("\n")
    .filter((l) => /"\$FK" add /.test(l));

  test("every stress add targeting a pickup-gated column declares a non-pr kind", () => {
    // Guard the guard: if the leg extraction ever silently matches nothing,
    // the assertions below become vacuously true.
    expect(addLines.length).toBeGreaterThanOrEqual(4);

    const gated = addLines.filter((l) => /--column (todo|doing)\b/.test(l));
    expect(gated.length).toBeGreaterThanOrEqual(3);
    for (const line of gated) {
      expect(line).toMatch(/--kind "\$KSTRESS_KIND"/);
    }
  });

  test("the declared synthetic kind is a real non-pr kind", () => {
    expect(script).toMatch(/^KSTRESS_KIND="(registry|tracker|umbrella|meta|program|capstone|validation)"$/m);
  });

  test("synthetic adds do not reach for --force instead of an honest kind", () => {
    // --force would also disable assertBodyReplaceSafe, assertDepUnblocked and
    // the Situations preflight — the consistency guards the harness exists to
    // exercise — so it must not be the lever used to get past placement.
    for (const line of addLines) {
      expect(line).not.toMatch(/--force/);
    }
  });

  test("a systematic first-card failure aborts instead of logging N identical errors", () => {
    expect(script).toContain("first stress add failed - aborting run");
    expect(script).toMatch(/if \[ "\$i" -eq 1 \]; then/);
  });
});
