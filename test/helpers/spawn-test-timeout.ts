/**
 * A test that starts a process (`Bun.spawn`, `Bun.spawnSync`, a git/CLI
 * invocation, ...) must pass this as its explicit `test()` timeout. Bun's
 * 5000ms per-test default has no margin for process-start cost on a loaded
 * host — two tests crossed it under real CI load (fkanban CI
 * 2026-09-03T17:30Z, 5 live routines + a cargo build running concurrently).
 * `scripts/check-test-timeout-boundary.ts` enforces this in CI.
 */
export const SPAWN_TEST_TIMEOUT_MS = 15_000;
