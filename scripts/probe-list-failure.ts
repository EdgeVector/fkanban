#!/usr/bin/env bun
/**
 * READ-ONLY probe: trace every query each `list` variant issues, INCLUDING the
 * one that fails.
 *
 * Why this exists rather than `probe-command-reads.ts`: that probe records a
 * call only once it RETURNS, so the query that kills a command is the one line
 * missing from its output. On 2026-08-01 bare `kanban list` exited 1 against
 * the live board and the existing probe could say only that it stopped.
 *
 * It also separates two things an `HTTP 400` alone conflates: WHICH partition
 * answered badly, and which PROJECTION reached it. That distinction was the
 * whole finding — the `agent-dogfood-scratch` partition answered the footer's
 * narrow 6-field read with `laststore: corrupt: empty rec` while answering the
 * wide 14- and 22-field reads with 0 rows, cleanly. A wider projection
 * succeeding where its own SUBSET fails is not intuition-shaped; print both.
 *
 * Run: bun scripts/probe-list-failure.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { listCmd } from "../src/commands/list.ts";

const cfg = readConfig();
const NAME = new Map<string, string>(
  Object.entries(cfg.schemaHashes ?? {}).map(([n, h]) => [h as string, n]),
);

function trace(): NodeClient {
  const real = newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    socketPath: cfg.nodeSocketPath,
  });
  const realQueryAll = real.queryAll.bind(real);
  return Object.assign(Object.create(Object.getPrototypeOf(real)), real, {
    queryAll: async (args: Parameters<NodeClient["queryAll"]>[0]) => {
      const a = args as { schemaHash: string; fields?: string[]; filter?: unknown };
      const label = NAME.get(a.schemaHash) ?? a.schemaHash.slice(0, 8);
      const fields = a.fields ?? [];
      const filter = JSON.stringify(a.filter ?? "FULL_SCAN");
      try {
        const res = await realQueryAll(args);
        console.log(
          `  ok   ${label.padEnd(16)} f=${String(fields.length).padStart(2)} ` +
            `rows=${String(res.results.length).padStart(4)} ${filter.slice(0, 60)}`,
        );
        return res;
      } catch (err) {
        console.log(
          `  FAIL ${label.padEnd(16)} f=${String(fields.length).padStart(2)} ` +
            `           ${filter.slice(0, 60)}`,
        );
        console.log(`       projection: [${fields.join(",")}]`);
        console.log(`       ${(err as Error).message.slice(0, 160)}`);
        throw err;
      }
    },
  }) as NodeClient;
}

const VARIANTS: Array<{ label: string; opts: Record<string, unknown> }> = [
  { label: "list (bare)", opts: {} },
  { label: "list --board default", opts: { board: "default" } },
  { label: "list --column todo", opts: { column: "todo" } },
  { label: "list --json", opts: { json: true } },
  { label: "list --group-by-milestone", opts: { groupByMilestone: true } },
];

let failed = 0;
for (const v of VARIANTS) {
  console.log(`\n=== ${v.label} ===`);
  try {
    await listCmd({ cfg, node: trace(), ...v.opts } as never);
    console.log("  => ok");
  } catch (err) {
    failed += 1;
    console.log(`  => THREW: ${(err as Error).message.slice(0, 120)}`);
  }
}
console.log(`\n${failed === 0 ? "all variants ok" : `${failed}/${VARIANTS.length} variants FAILED`}`);
