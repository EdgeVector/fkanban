// papercut-kanban-bare-subsystem-surface-fences-a-whole-crate-silently
import { describe, expect, test } from "bun:test";
import { bareSurfaceTokens } from "../src/commands/add.ts";

describe("bareSurfaceTokens", () => {
  test("names a bare subsystem token", () => {
    expect(bareSurfaceTokens(["fold_db_core"])).toEqual(["fold_db_core"]);
  });
  test("paths and globs are not bare", () => {
    expect(
      bareSurfaceTokens(["fold_db/crates/core/src/fold_db_core/mutation_manager", "src/**/*.ts", "README.md/"]),
    ).toEqual(["README.md"]);
  });
});
