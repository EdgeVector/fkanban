// Guards for the test-timeout architecture gate itself.
//
// The gate shipped covering `test()` only. Every `test()` in
// `test/fkanban-worktree.test.ts` carried `SPAWN_TEST_TIMEOUT_MS`, the gate
// reported PASSED, and the `beforeEach` that spawns three git processes timed
// out at 7031.87ms on the fkanban main tip (443d02d0, 2026-09-05) — 1 failure
// in 2058 tests, which left that tip's `ci-required` row `failure` and blocked
// the install of the merged p0 fix underneath it.
//
// So the hook cases below are the ones with a live incident behind them, and
// the `test()` cases are here so a future edit to the shared scanner cannot
// silently drop the coverage the gate already had.

import { expect, test } from "bun:test";
import { findTestTimeoutViolations } from "../scripts/check-test-timeout-boundary";

function scan(content: string): string[] {
  return findTestTimeoutViolations([{ path: "test/x.test.ts", content }]).map(
    (v) => v.test,
  );
}

const SPAWN = 'Bun.spawn(["git", "init"]);';

test("a hook that spawns directly and carries no timeout is a violation", () => {
  const found = scan(`
beforeEach(async () => {
  ${SPAWN}
});
`);
  expect(found).toEqual(["beforeEach (line 2)"]);
});

test("a hook that spawns through an in-file helper is a violation", () => {
  // The helper is what the real file used: the hook body names `git(...)` and
  // never mentions Bun.spawn, so a scanner that only pattern-matches the hook
  // body misses it. This is the exact shape that reached the main tip.
  const found = scan(`
async function git(cwd: string, args: string[]) {
  const proc = Bun.spawn(["git", "-C", cwd, ...args]);
  return proc.exited;
}

beforeEach(async () => {
  await git(repo, ["init"]);
});
`);
  expect(found).toEqual(["beforeEach (line 7)"]);
});

test("every lifecycle hook name is covered, not just beforeEach", () => {
  const found = scan(`
beforeAll(() => { ${SPAWN} });
beforeEach(() => { ${SPAWN} });
afterEach(() => { ${SPAWN} });
afterAll(() => { ${SPAWN} });
`);
  expect(found).toEqual([
    "beforeAll (line 2)",
    "beforeEach (line 3)",
    "afterEach (line 4)",
    "afterAll (line 5)",
  ]);
});

test("a spawning hook with an explicit timeout is clean", () => {
  expect(
    scan(`
beforeEach(async () => {
  ${SPAWN}
}, SPAWN_TEST_TIMEOUT_MS);

afterAll(() => { ${SPAWN} }, 30_000);
`),
  ).toEqual([]);
});

test("a hook that starts no process is not asked for a timeout", () => {
  // The gate is about process-start cost. Widening it to every hook would make
  // it noise, and noise is how the last one got ignored.
  expect(
    scan(`
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "x-"));
});
`),
  ).toEqual([]);
});

test("the second argument must be a timeout, not a second function", () => {
  // `hook(fn, timeout?)` has exactly one place a timeout can sit. A trailing
  // callback there is not one, and reading arity alone would call it clean.
  expect(
    scan(`
beforeEach(async () => {
  ${SPAWN}
}, () => {});
`),
  ).toEqual(["beforeEach (line 2)"]);
});

test("test() coverage is unchanged: no timeout is a violation", () => {
  expect(
    scan(`
test("spawns something", async () => {
  ${SPAWN}
});
`),
  ).toEqual(["spawns something"]);
});

test("test() coverage is unchanged: an explicit timeout is clean", () => {
  expect(
    scan(`
test("spawns something", async () => {
  ${SPAWN}
}, SPAWN_TEST_TIMEOUT_MS);
`),
  ).toEqual([]);
});

test("test(name, options, fn) is not a timeout", () => {
  // Three arguments, and the third is the body. Counting arguments would pass
  // this; the last-argument-is-a-function check is what catches it.
  expect(
    scan(`
test("spawns something", { retry: 2 }, async () => {
  ${SPAWN}
});
`),
  ).toEqual(["spawns something"]);
});

test("a hook inside a describe block is still scanned", () => {
  // The real second violation site sits inside a `describe`. The scanner is
  // flat by design, so this pins that the nesting does not hide it.
  const found = scan(`
describe("group", () => {
  beforeAll(() => {
    ${SPAWN}
  });
});
`);
  expect(found).toEqual(["beforeAll (line 3)"]);
});

test("a spawn named only inside a string or comment is not a violation", () => {
  // maskNonCode blanks literal text before any of this runs. Without it the
  // gate would flag its own fixtures, and every file that documents the rule.
  expect(
    scan(`
beforeEach(() => {
  // Bun.spawn(["git"]) is what this hook deliberately does NOT do.
  const note = "Bun.spawn is mentioned here only as text";
  plain(note);
});
`),
  ).toEqual([]);
});
