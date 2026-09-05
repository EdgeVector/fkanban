/**
 * A test that starts a process (`Bun.spawn`, `Bun.spawnSync`, a git/CLI
 * invocation, ...) must pass this as its explicit `test()` timeout. Bun's
 * 5000ms per-test default has no margin for process-start cost on a loaded
 * host — two tests crossed it under real CI load (fkanban CI
 * 2026-09-03T17:30Z, 5 live routines + a cargo build running concurrently).
 * `scripts/check-test-timeout-boundary.ts` enforces this in CI.
 */
export const SPAWN_TEST_TIMEOUT_MS = 15_000;

/**
 * A lifecycle hook (`beforeEach`/`afterEach`/`beforeAll`/`afterAll`) inherits
 * the SAME bun 5000ms default as a test, and it is not covered by the test's
 * own timeout argument. `test/fkanban-worktree.test.ts`'s `beforeEach` spawns
 * three git processes; on the fkanban main tip 443d02d0 it timed out at
 * 7031.87ms, failed 1 of 2058 tests, and left that tip's `ci-required` row
 * `failure` — which blocked the install of the merged p0 fix under it.
 *
 * A hook that COMPILES (`bun build --compile`) is a different scale again: it
 * is a full build, not a process start, so it gets its own budget rather than
 * borrowing the spawn one and re-creating the same too-tight deadline.
 */
export const COMPILE_TEST_TIMEOUT_MS = 120_000;
