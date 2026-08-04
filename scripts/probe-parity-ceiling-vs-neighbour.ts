#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does `parity-check`'s real in-flight ceiling cost the
 * OTHER clients on this primary, and what does bounding it cost the check?
 *
 * `probe-parity-nested-pool-width.ts` measured the ceiling: 144, because
 * `parity_check` pools milestone partitions at `PARTITION_READ_CONCURRENCY`
 * (12) and each partition sweep pools its 24 leads at the same 12 inside that.
 * The constant is 12; the path runs at 144.
 *
 * `concurrency.ts` rejects a width of 24 on the grounds that it would be
 * "unbounded for this call site", and is explicit that its politeness
 * justification rests on an experiment nobody ran — the effect of a wide
 * fan-out on the other clients sharing this primary. That experiment is this
 * file, run at the width the path has actually been using all along.
 *
 * Method: a total-in-flight semaphore wraps `queryAll`, so one knob caps the
 * whole nested tree regardless of how the pools compose. A NEIGHBOUR reader —
 * the cheap point read every other kanban/brain/lastgit process issues — runs
 * continuously throughout, against an idle control measured first.
 *
 * Run: bun scripts/probe-parity-ceiling-vs-neighbour.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient, type QueryFilter } from "../src/client.ts";
import { parityCheckResult } from "../src/commands/parity_check.ts";

const cfg = readConfig();
const CEILINGS = [12, 24, 48, 96, 144];
const REPS = 3;

function makeNode(opsLabel: string): NodeClient {
  return newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    socketPath: cfg.nodeSocketPath,
    opsLabel,
  });
}

/** Cap TOTAL in-flight queryAll calls at `width`, whatever the pools do. */
function capped(node: NodeClient, width: number, gauge: { max: number; calls: number }): NodeClient {
  let inFlight = 0;
  const waiters: Array<() => void> = [];
  const acquire = async (): Promise<void> => {
    if (inFlight < width) {
      inFlight += 1;
      return;
    }
    await new Promise<void>((resolve) => waiters.push(resolve));
    inFlight += 1;
  };
  const release = (): void => {
    inFlight -= 1;
    const next = waiters.shift();
    if (next) next();
  };
  const realQueryAll = node.queryAll.bind(node);
  return Object.assign(Object.create(Object.getPrototypeOf(node)), node, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      await acquire();
      gauge.calls += 1;
      if (inFlight > gauge.max) gauge.max = inFlight;
      try {
        return await realQueryAll(args);
      } finally {
        release();
      }
    },
  }) as NodeClient;
}

function median(xs: number[]): number {
  if (xs.length === 0) return -1;
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? (s[m] as number) : Math.round((((s[m - 1] as number) + (s[m] as number)) / 2));
}

// ---- neighbour: the cheap point read every other client on this node issues.
const neighbourNode = makeNode("kanban-probe-neighbour");
const boardHash = cfg.schemaHashes?.board;
if (!boardHash) throw new Error("no board schema hash in config");

async function neighbourOnce(): Promise<number> {
  const t0 = performance.now();
  await neighbourNode.queryAll({
    schemaHash: boardHash as string,
    fields: ["title"],
    filter: { HashKey: "default" } as QueryFilter,
  });
  return performance.now() - t0;
}

async function neighbourLoop(stop: { done: boolean }, out: number[]): Promise<void> {
  while (!stop.done) out.push(await neighbourOnce());
}

// ---- idle control, measured before any parity load.
const idle: number[] = [];
for (let i = 0; i < 12; i++) idle.push(await neighbourOnce());
const idleMedian = median(idle);

type Row = { ceiling: number; wall: number; calls: number; maxSeen: number; neighbour: number; n: number };
const rows: Row[] = [];

for (const ceiling of CEILINGS) {
  const walls: number[] = [];
  const neighbourSamples: number[] = [];
  let calls = 0;
  let maxSeen = 0;
  for (let rep = 0; rep < REPS; rep++) {
    const gauge = { max: 0, calls: 0 };
    const node = capped(makeNode("kanban-parity"), ceiling, gauge);
    const stop = { done: false };
    const nbrOut: number[] = [];
    const nbr = neighbourLoop(stop, nbrOut);
    const t0 = performance.now();
    await parityCheckResult({ cfg, node });
    walls.push(performance.now() - t0);
    stop.done = true;
    await nbr;
    neighbourSamples.push(...nbrOut);
    calls = gauge.calls;
    if (gauge.max > maxSeen) maxSeen = gauge.max;
  }
  rows.push({
    ceiling,
    wall: median(walls),
    calls,
    maxSeen,
    neighbour: median(neighbourSamples),
    n: neighbourSamples.length,
  });
  console.log(
    `ceiling=${String(ceiling).padStart(3)}  wall=${String(Math.round(median(walls))).padStart(5)}ms  ` +
      `calls=${calls}  max_seen=${maxSeen}  neighbour_median=${median(neighbourSamples)}ms (n=${neighbourSamples.length})`,
  );
}

console.log(`\nidle neighbour control: ${idleMedian}ms (n=${idle.length})`);
console.log("\n| ceiling | wall | waves(calls/ceiling) | neighbour median | vs idle |");
console.log("|---|---|---|---|---|");
for (const r of rows) {
  const delta = r.neighbour - idleMedian;
  console.log(
    `| ${r.ceiling} | ${Math.round(r.wall)}ms | ${Math.ceil(r.calls / r.ceiling)} | ${r.neighbour}ms | ${delta >= 0 ? "+" : ""}${delta}ms |`,
  );
}
