// papercut-kanban-add-accepts-validation-card-without-done-when-20260923
import { expect, test } from "bun:test";

import { warnProofCardWithoutDoneWhen } from "../src/commands/add.ts";

function capture(fn: () => void): string[] {
  const out: string[] = [];
  const orig = console.error;
  console.error = (...a: unknown[]) => { out.push(a.map(String).join(" ")); };
  try { fn(); } finally { console.error = orig; }
  return out;
}

test("a validation card with no DONE-WHEN warns at creation", () => {
  const w = capture(() => warnProofCardWithoutDoneWhen("v1", "validation", "## GOAL\nx\n## END STATE\ny\n"));
  expect(w).toHaveLength(1);
  expect(w[0]).toContain("no DONE-WHEN line");
});

test("a DONE-WHEN line or a pr kind stays quiet", () => {
  expect(capture(() => warnProofCardWithoutDoneWhen("v2", "validation", "DONE-WHEN: date >= 2026-10-01\n"))).toHaveLength(0);
  expect(capture(() => warnProofCardWithoutDoneWhen("p1", "pr", "## GOAL\nx\n"))).toHaveLength(0);
});
