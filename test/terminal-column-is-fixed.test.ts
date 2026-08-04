// The invariant that licenses `TERMINAL_COLUMN` being a constant instead of a
// per-board map.
//
// Columns are fixed (Tom, 2026-07-16): `backlog → todo → doing → done`, and
// `board create --columns` rejects anything else. `resolveColumns` enforces
// that by IGNORING the board columns it is handed, so `terminalColumn(...)`
// returns `done` no matter what a board record says — including a stale board
// carrying a pre-2026-07-16 custom layout.
//
// `boardTerminalMap(boards)` used to build `slug → terminalColumn(...)` for
// callers that keyed by board, and `terminalColumnFor(slug, map)` read
// `map?.get(slug) ?? "done"`. Under this invariant every value in that map was
// `done` and so was the fallback, so the map could not differ from omitting it
// — for a known board, an unknown board, or a board with custom columns. Four
// call sites nonetheless issued a dedicated `listBoards` read purely to build
// it, one of them (`assertDepUnblocked`) on the WRITE path.
//
// If per-board columns ever come back, they come back through `resolveColumns`,
// and these tests are what fails first: re-thread a board→terminal map from
// here rather than trusting the constant.

import { describe, expect, test } from "bun:test";

import { isDepEnforcedColumn, terminalColumn, TERMINAL_COLUMN } from "../src/record.ts";
import { DEFAULT_COLUMNS, resolveColumns } from "../src/schemas.ts";

describe("terminalColumn is constant while columns are fixed", () => {
  const layouts: Array<[string, string[]]> = [
    ["the fixed layout", [...DEFAULT_COLUMNS]],
    ["a legacy review lane", ["backlog", "todo", "doing", "review", "done"]],
    ["a fully custom layout", ["spec", "build", "ship"]],
    ["a hollow board record", []],
    ["a single-column board", ["only"]],
  ];

  for (const [name, columns] of layouts) {
    test(`${name} still terminates at TERMINAL_COLUMN`, () => {
      expect(terminalColumn(columns)).toBe(TERMINAL_COLUMN);
      expect(resolveColumns(columns)).toEqual([...DEFAULT_COLUMNS]);
    });
  }

  test("TERMINAL_COLUMN is the last fixed column", () => {
    expect(TERMINAL_COLUMN).toBe(DEFAULT_COLUMNS.at(-1)!);
  });
});

describe("dep enforcement does not vary by board", () => {
  // The old signature was `isDepEnforcedColumn(column, boardSlug, map?)`. These
  // pin that the verdict never depended on the board — the reason the board
  // read in front of it was removable.
  const boardsThatUsedToMatter = ["default", "zz", "agent-dogfood-scratch", "a-board-that-does-not-exist"];

  test("gated columns are doing/done, whatever board the card is on", () => {
    for (const _board of boardsThatUsedToMatter) {
      expect(isDepEnforcedColumn("backlog")).toBe(false);
      expect(isDepEnforcedColumn("todo")).toBe(false);
      expect(isDepEnforcedColumn("doing")).toBe(true);
      expect(isDepEnforcedColumn("done")).toBe(true);
    }
  });

  test("a custom terminal name is not gated — no board can declare one", () => {
    // Pre-fix, a board whose columns ended in `ship` would have gated `ship`.
    // `board create` refuses that layout, so `ship` is just an invalid column.
    expect(isDepEnforcedColumn("ship")).toBe(false);
    expect(isDepEnforcedColumn("review")).toBe(false);
  });
});
