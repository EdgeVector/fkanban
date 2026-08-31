// `kanban ping` — one cheap liveness request to the node. The socket-safe
// answer to "is the node up", replacing the `kanban list` health-check
// convention: a status read costs the node one request, a list costs a board
// read. Report shape is shared verbatim by `ping --json` and the MCP
// `fkanban_ping` tool so the two can't diverge (same pattern as doctor).

import pkg from "../../package.json" with { type: "json" };
import { pingNode, type PingReport, type Verbose } from "../client.ts";
import { resolveSocketPath, tryReadConfig, type Config } from "../config.ts";

// `version` is the installed fkanban CLI version (same source as
// `kanban --version`) — a report field, not a liveness signal.
export type PingCommandReport = PingReport & { version: string };

export type PingOptions = {
  configPath?: string;
  /**
   * Config to probe, for a caller that already HAS one.
   *
   * The MCP server is that caller: it is handed a `Config` at construction and
   * every other tool it exposes uses it, but `fkanban_ping` alone went back to
   * disk through `tryReadConfig` and probed whatever node THAT file named. Two
   * consequences, and the second is why this parameter exists:
   *
   *   - a server explicitly pointed at one node could ping a different one, and
   *   - the tool could not be exercised hermetically, so
   *     `mcp-read-tools-do-not-mutate.test.ts` — a unit test — issued a real
   *     status request to Tom's primary brain on every run. `/api/status` is
   *     ~176 KB, 98% of it the node's telemetry ring, and the test's 5s budget
   *     was then a bet on the shared primary's latency. It lost on 2026-08-02
   *     (5001ms) and failed a merge gate that had nothing to do with ping.
   *
   * `configPath` still wins nothing over this: an explicit config is the most
   * specific thing a caller can supply, so it short-circuits the disk read.
   */
  cfg?: Config;
  /**
   * Deadline for the single status request. Omitted, the probe inherits the
   * shared data-plane default (`FKANBAN_HTTP_TIMEOUT_MS`, else 30s).
   *
   * Exposed so a caller with its own budget can bound the probe to it rather
   * than discovering the inherited one the hard way. The fleet sets 90s for
   * data-plane reads; a routine that gates on liveness and then loses 90 of its
   * 126 seconds to the gate has been failed by the check, not by the node.
   */
  timeoutMs?: number;
  json?: boolean;
  verbose?: Verbose;
  print?: (line: string) => void;
};

// Run the probe and return the structured report without printing. Missing
// config is an unreachable-node report, not a throw: ping is used from health
// checks that must always get an answer.
export async function runPingStructured(
  opts: Omit<PingOptions, "json" | "print"> = {},
): Promise<PingCommandReport> {
  const cfg = opts.cfg ?? tryReadConfig(opts.configPath);
  if (!cfg) {
    return {
      ok: false,
      latency_ms: 0,
      version: pkg.version,
      error: "config missing — run `kanban init`",
    };
  }
  const report = await pingNode({
    nodeUrl: cfg.nodeUrl,
    socketPath: resolveSocketPath(cfg),
    timeoutMs: opts.timeoutMs,
    verbose: opts.verbose,
  });
  return { ...report, version: pkg.version };
}

export async function pingCommand(opts: PingOptions = {}): Promise<number> {
  const print = opts.print ?? ((l: string) => console.log(l));
  const report = await runPingStructured(opts);
  if (opts.json) {
    print(JSON.stringify(report));
  } else if (report.ok) {
    print(`✓ node ok in ${report.latency_ms}ms`);
  } else if (report.timed_out) {
    // Do NOT say "unreachable" here. The node answered nothing within the
    // deadline, which on this endpoint is an ordinary outcome for a busy or
    // freshly-restarted node — `/api/status` re-walks the entire store per
    // request (see `PingReport.timed_out`). The fleet gates real work on this
    // one line: CLAUDE.md points every agent at `kanban ping` as THE health
    // check, and routines that read "unreachable" stop. Saying "busy" instead
    // is not a softer word for the same thing, it is the accurate one, and it
    // is the difference between a routine retrying and a routine aborting.
    print(`✗ node did not answer in ${report.latency_ms}ms — busy, not unreachable — ${report.error}`);
  } else {
    print(`✗ node unreachable — ${report.error}`);
  }
  return report.ok ? 0 : 1;
}
