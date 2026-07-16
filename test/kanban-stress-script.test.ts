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
});
