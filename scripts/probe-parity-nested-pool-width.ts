#!/usr/bin/env bun
/**
 * READ-ONLY probe: how many node reads does `parity-check` actually have in
 * flight at once?
 *
 * `PARTITION_READ_CONCURRENCY` is documented and pinned at 12, and its own
 * docstring rejects 24 on design grounds ("a width of 24 means 'unbounded for
 * this call site'"). But `parity_check.ts` pools MILESTONE partitions at that
 * width, and `sweepMilestoneCardsPartition` pools its 24 LEADS at the same
 * width inside each one. Nested pools multiply; the constant does not.
 *
 * This measures the real in-flight ceiling by wrapping `queryAll` with a
 * gauge — no estimate, no node-side attribution needed, and the fleet's
 * concurrent traffic cannot pollute a client-side counter.
 *
 * Also reports the node's own `queue_wait` for the sweep, because that is the
 * phase a too-wide fan-out shows up in: 12 requests that arrive together wait
 * on each other, and the wait is charged to every one of them.
 *
 * Run: bun scripts/probe-parity-nested-pool-width.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { parityCheckResult } from "../src/commands/parity_check.ts";

const cfg = readConfig();

type Gauge = {
  inFlight: number;
  maxInFlight: number;
  calls: number;
  waveStamps: number[];
};

function instrument(node: NodeClient, g: Gauge): NodeClient {
  const realQueryAll = node.queryAll.bind(node);
  return Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      g.inFlight += 1;
      g.calls += 1;
      if (g.inFlight > g.maxInFlight) g.maxInFlight = g.inFlight;
      g.waveStamps.push(performance.now());
      try {
        return await realQueryAll(args);
      } finally {
        g.inFlight -= 1;
      }
    },
  }) as NodeClient;
}

const g: Gauge = { inFlight: 0, maxInFlight: 0, calls: 0, waveStamps: [] };
const node = instrument(
  newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    socketPath: cfg.nodeSocketPath,
    opsLabel: "kanban-parity",
  }),
  g,
);

const t0 = performance.now();
const res = await parityCheckResult({ cfg, node });
const wall = performance.now() - t0;

console.log("=== parity-check in-flight gauge (live primary, read-only) ===");
console.log(`partitions_checked : ${res.partitions_checked}`);
console.log(`rows_checked       : ${res.rows_checked}`);
console.log(`ok                 : ${res.ok}`);
console.log(`node queryAll calls: ${g.calls}`);
console.log(`MAX IN FLIGHT      : ${g.maxInFlight}`);
console.log(`wall               : ${Math.round(wall)}ms`);
console.log(
  `\nPARTITION_READ_CONCURRENCY is 12. Anything above 12 means the pools nested.`,
);
