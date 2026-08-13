// The stress harness creates seven throwaway zz-kstress-* boards. Cleanup used
// to be a linear block at the very end of the script, so any early exit leaked
// them onto the live board list — seven were still there on 2026-07-30, and
// every board-wide list pays one keyed query per ghost board.
//
// These tests drive the real script against a stub CLI (KSTRESS_N=0 /
// KSTRESS_BURST=0 skips the card legs, leaving only the board durability legs)
// and assert what the trap actually reaps.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, writeFileSync, chmodSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const scriptPath = join(import.meta.dir, "..", "scripts", "kanban-stress.sh");
const script = readFileSync(scriptPath, "utf8");

const SCRATCH_BOARDS = [
  "zz-kstress-bd-1",
  "zz-kstress-bd-2",
  "zz-kstress-bd-3",
  "zz-kstress-bcburst-0",
  "zz-kstress-bcburst-1",
  "zz-kstress-bcburst-2",
  "zz-kstress-bcburst-3",
];

// A stand-in `kanban` that keeps board state in a file and logs every call, so
// the test can assert on what the harness asked for rather than on a live node.
const STUB = `#!/usr/bin/env bash
printf '%s\\n' "$*" >> "$KSTUB_LOG"
state="$KSTUB_STATE"
[ -f "$state" ] || : > "$state"
# Deterministic crash injection: when the harness asks for the trigger command,
# signal the harness itself (not this stub's command-substitution subshell).
if [ -n "$KSTUB_KILL_ON" ] && [ "$1 $2 $3" = "$KSTUB_KILL_ON" ]; then
  grep -qxF "$3" "$state" 2>/dev/null || printf '%s\\n' "$3" >> "$state"
  printf '{"slug":"%s"}\\n' "$3"
  kill -TERM "$(cat "$KSTUB_PIDFILE")" 2>/dev/null
  exit 0
fi
case "$1 $2" in
  "board list")
    printf '['
    sep=""
    while IFS= read -r b; do
      [ -z "$b" ] && continue
      printf '%s{"slug":"%s"}' "$sep" "$b"
      sep=","
    done < "$state"
    printf ']\\n'
    ;;
  "board create")
    grep -qxF "$3" "$state" 2>/dev/null || printf '%s\\n' "$3" >> "$state"
    printf '{"slug":"%s"}\\n' "$3"
    ;;
  "board rm")
    grep -vxF "$3" "$state" > "$state.tmp" 2>/dev/null || : > "$state.tmp"
    mv "$state.tmp" "$state"
    ;;
  "add "*)
    printf '{"slug":"%s"}\n' "$2"
    ;;
  "show "*)
    printf '{"slug":"%s"}\n' "$2"
    ;;
  "rm "*)
    # Model the live 2026-08-13 failure: the delete did NOT ACK, while the card
    # remains readable. The harness must report an ERROR, not claim that an
    # acknowledged delete failed to persist.
    case "$2" in *-c3) exit 1;; esac
    ;;
  *) : ;;
esac
exit 0
`;

function runHarness(
  killOn?: string,
  n = "0",
): { log: string[]; boards: string[]; stdout: string; exitCode: number } {
  const dir = mkdtempSync(join(tmpdir(), "kstress-cleanup-"));
  const stub = join(dir, "kanban");
  const log = join(dir, "calls.log");
  const state = join(dir, "boards.txt");
  const pidfile = join(dir, "harness.pid");
  writeFileSync(stub, STUB);
  chmodSync(stub, 0o755);
  writeFileSync(log, "");
  writeFileSync(state, "");

  // `exec` keeps the pid recorded here as the harness's own pid, so the stub
  // signals the script rather than the subshell it was called from.
  const proc = Bun.spawnSync(["bash", "-c", 'echo $$ > "$KSTUB_PIDFILE"; exec bash "$0"', scriptPath], {
    env: {
      ...process.env,
      FKANBAN: stub,
      KSTUB_LOG: log,
      KSTUB_STATE: state,
      KSTUB_PIDFILE: pidfile,
      ...(killOn ? { KSTUB_KILL_ON: killOn } : {}),
      KSTRESS_N: n,
      KSTRESS_BURST: "0",
      // Declare an isolated socket. These tests drive a STUB cli and never dial
      // a node, but the harness now refuses to run against the primary socket,
      // and without this it would resolve the developer's own
      // ~/.fkanban/config.json and bail before the legs under test. Setting it
      // also makes the run hermetic rather than machine-dependent.
      FOLDDB_SOCKET_PATH: join(dir, "isolated.sock"),
    },
  });

  return {
    log: readFileSync(log, "utf8").split("\n").filter(Boolean),
    boards: existsSync(state) ? readFileSync(state, "utf8").split("\n").filter(Boolean) : [],
    stdout: proc.stdout.toString(),
    exitCode: proc.exitCode ?? -1,
  };
}

const hasJq = Bun.which("jq") !== null;

describe("kanban-stress scratch cleanup", () => {
  test.if(hasJq)("reaps every throwaway board it created", () => {
    const { log, boards, stdout, exitCode } = runHarness();

    expect(exitCode).toBe(0);
    expect(stdout).toContain("SUMMARY:");

    for (const board of SCRATCH_BOARDS) {
      expect(log.some((line) => line.startsWith(`board create ${board} `))).toBe(true);
      expect(log.some((line) => line.startsWith(`board rm ${board} `))).toBe(true);
    }
    // Nothing throwaway survives the run.
    expect(boards.filter((b) => b.startsWith("zz-kstress-"))).toEqual([]);
  });

  // The regression itself: cleanup used to be a linear block at the end of the
  // script, so a run that died before reaching it leaked every board it had
  // created. This kills the harness mid-run, right after the third durability
  // board is created.
  test.if(hasJq)("reaps its boards even when the run is killed mid-flight", () => {
    const { log, boards } = runHarness("board create zz-kstress-bd-3");

    for (const board of ["zz-kstress-bd-1", "zz-kstress-bd-2", "zz-kstress-bd-3"]) {
      expect(log.some((line) => line.startsWith(`board rm ${board} `))).toBe(true);
    }
    expect(boards.filter((b) => b.startsWith("zz-kstress-"))).toEqual([]);
    expect(boards).toContain("agent-dogfood-scratch");
  });

  test.if(hasJq)("never reaps the persistent scratch board it runs against", () => {
    const { log, boards } = runHarness();

    expect(log.some((line) => line.startsWith("board rm agent-dogfood-scratch"))).toBe(false);
    expect(boards).toContain("agent-dogfood-scratch");
  });

  test.if(hasJq)("does not call a rejected delete a persisted-delete finding", () => {
    const { stdout, exitCode } = runHarness(undefined, "3");

    expect(exitCode).toBe(0);
    expect(stdout).toContain("ERROR: delete test rm failed for ");
    expect(stdout).not.toContain("FINDING: delete-not-persisted");
  });
});

describe("kanban-stress cleanup is trap-driven", () => {
  test("registers cleanup for EXIT, INT and TERM", () => {
    expect(script).toContain("trap cleanup_scratch EXIT");
    expect(script).toContain("trap on_signal INT TERM");
    expect(script).toContain("cleanup_scratch()");
  });

  // Bash resumes the script after a signal handler returns. A handler that only
  // reaps lets the run continue and create MORE scratch boards that the
  // already-fired cleanup never sees — which is exactly what the mid-flight kill
  // test caught.
  test("the signal handler exits instead of falling back into the run", () => {
    const handler = script.slice(script.indexOf("on_signal() {"), script.indexOf("trap cleanup_scratch EXIT"));
    expect(handler).toContain("exit 0");
  });

  test("boards are registered for cleanup at creation time", () => {
    expect(script).toContain('scratch_boards+=("$b")');
    // The old tail-of-script reap is gone: a crash before it leaked every board.
    expect(script).not.toMatch(/for b in "\$\{bd\[@\]\}" zz-kstress-bcburst-0/);
  });

  test("cleanup is idempotent — INT/TERM run it, then bash runs it again on EXIT", () => {
    expect(script).toContain("cleanup_done");
  });
});
