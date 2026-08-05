#!/usr/bin/env bun
/**
 * What is the node ACTUALLY doing right now, per client and schema?
 *
 * `lastdb ops` prints cumulative counters covering the whole life of the
 * daemon — hours of history, including whatever storm happened while you were
 * asleep. Three consecutive chief-engineer runs opened with that table and two
 * of them chased a non-problem it pointed at: once an archive drain that had
 * already finished, once 3,720 `LastgitCiStatus` reads that turned out to be
 * an earlier agent's `show` storm running at zero calls/min live. The
 * cumulative table is not just noisy for this purpose, it is actively
 * misleading, and the fix is mechanical: sample twice and subtract.
 *
 * This is that subtraction, promoted out of scratch. Take the DELTA FIRST,
 * then use `lastdb ops` only to explain what the delta already flagged.
 *
 *   bun scripts/probe-ops-delta.ts            # 60s window
 *   bun scripts/probe-ops-delta.ts 90         # 90s window
 *   bun scripts/probe-ops-delta.ts 90 kanban  # only rows for one client
 *
 * ## Cold shard loads, and the fourth run this table caught out
 *
 * The warning above was written after two runs chased phantom LOAD. A third and
 * fourth then chased a phantom READ COST, from the one column this probe
 * computed and did not print.
 *
 * `lastdb ops` ranks a table titled "Top by cold shard loads (read cost, not
 * wall time)". On 2026-08-05 its top row was
 * `client=kanban kind=mutation schema=board_cards loads=14484 count=3734`, and
 * two consecutive chief-engineer handoffs carried "why does a single-row upsert
 * cold-load FOUR shards?" as the live lead. Measured over a 36-minute window on
 * the same node, the same key took **137 mutations and 1 cold load** — 0.007
 * per call, against the 3.9 the lifetime ratio implies. A 530x gap.
 *
 * Cold loads are cache MISSES, so they cluster at the start of a daemon's life
 * and after any sweep that touches a wide, cold key range. Dividing a lifetime
 * total by lifetime traffic averages that burst over every call that came
 * after, producing a per-call figure that describes no operation the product
 * performs. It is the same mistake as the wall-clock one, in the column nobody
 * was subtracting — so the delta table now prints `loads` and `loads/call`, and
 * flags any row whose lifetime ratio disagrees with its live one.
 *
 * Counters reset when `lastdbd` restarts. A restart mid-window shows up as
 * negative deltas; the script says so rather than printing nonsense.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";

import {
  KEY_SEP,
  misleadingColdLoadRows,
  rowsFromRequestOps,
  splitKey,
  unattributedRemainder,
  type OpRow,
} from "./lib/ops-delta-rows.ts";

type Sample = {
  at: number;
  rows: Map<string, OpRow>;
  rollup: Map<string, OpRow>;
  idle: Map<string, OpRow>;
  uptimeHint: number;
};

const windowSec = Number(process.argv[2] ?? 60);
const clientFilter = process.argv[3];
if (!Number.isFinite(windowSec) || windowSec <= 0) {
  console.error(`usage: bun scripts/probe-ops-delta.ts [windowSeconds] [client]`);
  process.exit(1);
}

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

async function sample(): Promise<Sample> {
  const res = await node.rawCall("GET", "/api/status");
  // rawCall returns {status, headers, body, json} — `status` is the HTTP code,
  // `body` the raw string. The payload is `json`, which itself nests the node
  // report under `status`.
  const payload = ((res as { json?: unknown }).json ?? {}) as Record<string, unknown>;
  const report = (payload.status ?? payload) as Record<string, unknown>;
  const ops = report.request_ops as Record<string, unknown> | undefined;
  if (!ops) throw new Error("no request_ops on /api/status — node too old?");
  const { rows, rollup, idle } = rowsFromRequestOps(ops);
  return { at: Date.now(), rows, rollup, idle, uptimeHint: Number(ops.sample_count ?? 0) };
}

const fmt = (n: number) => n.toLocaleString("en-US");
const pad = (s: string, n: number) => s.padEnd(n).slice(0, n);

console.log(`sampling ${windowSec}s window${clientFilter ? ` (client=${clientFilter})` : ""}…`);
const before = await sample();
await new Promise((r) => setTimeout(r, windowSec * 1000));
const after = await sample();

const elapsed = (after.at - before.at) / 1000;
if (after.uptimeHint < before.uptimeHint) {
  console.log("\n!! sample_count went BACKWARDS — lastdbd restarted mid-window.");
  console.log("   Counters reset; this window is not comparable. Re-run.\n");
  process.exit(2);
}

type Delta = {
  client: string;
  kind: string;
  schema: string;
  count: number;
  sumMs: number;
  errors: number;
  loads: number;
  lifetimeCount?: number;
  lifetimeLoads?: number;
  phases: Record<string, number>;
};

const deltas: Delta[] = [];
for (const [key, now] of after.rows) {
  const then = before.rows.get(key);
  const count = now.count - (then?.count ?? 0);
  if (count <= 0) continue;
  const [client, kind, schema] = splitKey(key);
  if (clientFilter && client !== clientFilter) continue;
  const phases: Record<string, number> = {};
  for (const [p, v] of Object.entries(now.phase_sums ?? {})) {
    const d = v - (then?.phase_sums?.[p] ?? 0);
    if (d > 0) phases[p] = d;
  }
  deltas.push({
    client,
    kind,
    schema,
    count,
    sumMs: now.sum_ms - (then?.sum_ms ?? 0),
    errors: now.error_count - (then?.error_count ?? 0),
    loads: (now.sum_cold_shard_loads ?? 0) - (then?.sum_cold_shard_loads ?? 0),
    // Kept alongside the delta so the two ratios can be shown side by side.
    // This is the number `lastdb ops` prints, and on its own it is the trap.
    lifetimeCount: now.count,
    lifetimeLoads: now.sum_cold_shard_loads ?? 0,
    phases,
  });
}

// Traffic the `app_verb` rollup saw that no per-schema row accounts for. The
// ranking tables are top-32 across ALL clients, so a low-volume schema can be
// missing from every one of them while its calls still land in the rollup.
// Shown as its own row so that traffic stays visible WITHOUT double-counting
// the rows that are attributed — see `lib/ops-delta-rows.ts` for the 2x bug
// this replaced.
const UNATTRIBUTED = "(unattributed)";
for (const [rollupKey, nowRollup] of after.rollup) {
  const thenRollup = before.rollup.get(rollupKey);
  const [client, kind] = rollupKey.split(KEY_SEP) as [string, string];
  if (clientFilter && client !== clientFilter) continue;
  const rest = unattributedRemainder(deltas, {
    client,
    kind,
    count: nowRollup.count - (thenRollup?.count ?? 0),
    sumMs: nowRollup.sum_ms - (thenRollup?.sum_ms ?? 0),
  });
  if (rest.count <= 0) continue;
  deltas.push({
    client,
    kind,
    schema: UNATTRIBUTED,
    count: rest.count,
    sumMs: rest.sumMs,
    errors: 0,
    loads: 0,
    phases: {},
  });
}

if (deltas.length === 0) {
  console.log(`\nNo traffic at all in ${elapsed.toFixed(0)}s.`);
  console.log("An idle node is a real answer: whatever the cumulative table blames is NOT running now.");
  process.exit(0);
}

deltas.sort((a, b) => b.sumMs - a.sumMs);

console.log(`\n== live delta over ${elapsed.toFixed(0)}s (this is what is happening NOW) ==\n`);
console.log(
  `  ${pad("client", 12)} ${pad("kind", 10)} ${pad("schema", 14)} ` +
    `${"calls".padStart(7)} ${"/min".padStart(7)} ${"avg ms".padStart(8)} ${"sum ms".padStart(10)} ` +
    `${"loads".padStart(7)} ${"ld/call".padStart(8)} ${"err".padStart(4)}`,
);
for (const d of deltas) {
  console.log(
    `  ${pad(d.client, 12)} ${pad(d.kind, 10)} ${pad(d.schema.slice(0, 12), 14)} ` +
      `${fmt(d.count).padStart(7)} ${(d.count / (elapsed / 60)).toFixed(1).padStart(7)} ` +
      `${(d.sumMs / d.count).toFixed(0).padStart(8)} ${fmt(Math.round(d.sumMs)).padStart(10)} ` +
      `${fmt(d.loads).padStart(7)} ${(d.loads / d.count).toFixed(2).padStart(8)} ` +
      `${String(d.errors).padStart(4)}`,
  );
}

// The rows where `lastdb ops` and this window disagree about read cost.
//
// Printed as its own block rather than a footnote, because the lifetime ratio
// is what an operator reaches for first (CLAUDE.md sends every agent to
// `lastdb ops` to "name the offender") and it is the number that has now sent
// two chief-engineer runs after a non-problem. A row here means: the loads in
// that bucket were paid EARLIER — a cold cache at daemon start, or a sweep over
// a wide key range — and are not being paid by the traffic running now.
const misleading = misleadingColdLoadRows(deltas);

if (misleading.length > 0) {
  console.log(`\n== cold-load rows where the LIFETIME table disagrees with this window ==\n`);
  console.log(
    `  ${pad("client", 12)} ${pad("kind", 10)} ${pad("schema", 14)} ` +
      `${"lifetime".padStart(9)} ${"live".padStart(8)}  ratio`,
  );
  for (const r of misleading) {
    console.log(
      `  ${pad(r.row.client, 12)} ${pad(r.row.kind, 10)} ${pad(r.row.schema.slice(0, 12), 14)} ` +
        `${r.lifetime.toFixed(2).padStart(9)} ${r.live.toFixed(3).padStart(8)}  ` +
        `${r.ratio.toFixed(0)}x`,
    );
  }
  console.log(
    `\n  loads/call from \`lastdb ops\` is a LIFETIME total over LIFETIME traffic.\n` +
      `  For these rows it does not describe the workload running now — quote the\n` +
      `  live column, or say explicitly that the cost was paid earlier.`,
  );
}

// Phase breakdown for the worst offender: `molecule_gate` dominating means the
// node is serializing against concurrent writers to one key, not doing storage
// work — a different problem with a different fix than a slow `apply`.
//
// Pick the costliest row that actually CARRIES phases, not simply `deltas[0]`.
// Only the per-schema ranking tables report `phase_sums`; a `(unattributed)`
// remainder row never does. Blindly taking `deltas[0]` is what made this whole
// block dead code before — the `app_verb` rollup outranked every real row by
// construction and carried no phases, so this silently printed nothing on
// every single run.
const worst = deltas.find((d) => Object.keys(d.phases).length > 0);
const phaseEntries = worst
  ? Object.entries(worst.phases).sort((a, b) => b[1] - a[1])
  : [];
if (worst && phaseEntries.length) {
  const totalUs = phaseEntries.reduce((s, [, v]) => s + v, 0);
  console.log(`\n== phases for the top row (${worst.client} ${worst.kind} ${worst.schema.slice(0, 12)}) ==\n`);
  for (const [p, us] of phaseEntries.slice(0, 6)) {
    const pctOfTotal = totalUs > 0 ? (us / totalUs) * 100 : 0;
    console.log(
      `  ${pad(p, 20)} ${(us / 1000 / worst.count).toFixed(0).padStart(8)} ms/call  ` +
        `${pctOfTotal.toFixed(0).padStart(3)}% of phased time`,
    );
  }
}

// Idle long-poll waits, reported SEPARATELY and never ranked beside real work.
// A watch parks on the node until something changes, so it books ~30s of
// "duration" while costing the node nothing; `lastdb ops` excludes these from
// its rankings for exactly that reason and this now matches it. Measured live
// 2026-08-03, `lastgit local_watch` booked 120,572ms over a 120s window — 50x
// the busiest real row — and used to sit at the top of this table.
const idleRows: Array<{ client: string; kind: string; count: number; waitedMs: number }> = [];
for (const [idleKey, nowIdle] of after.idle) {
  const thenIdle = before.idle.get(idleKey);
  const [client, kind] = idleKey.split(KEY_SEP) as [string, string];
  if (clientFilter && client !== clientFilter) continue;
  const count = nowIdle.count - (thenIdle?.count ?? 0);
  if (count <= 0) continue;
  idleRows.push({ client, kind, count, waitedMs: nowIdle.sum_ms - (thenIdle?.sum_ms ?? 0) });
}
if (idleRows.length) {
  console.log(`\n== idle long-poll wait (client-requested sleep, NOT node work) ==\n`);
  for (const r of idleRows.sort((a, b) => b.waitedMs - a.waitedMs)) {
    console.log(
      `  ${pad(r.client, 12)} ${pad(r.kind, 10)} ${fmt(r.count).padStart(7)} calls  ` +
        `${fmt(Math.round(r.waitedMs)).padStart(10)} ms waited`,
    );
  }
}

const errs = deltas.filter((d) => d.errors > 0);
console.log(
  `\n${errs.length ? `!! ${errs.length} row(s) with errors — see the err column above.` : "0 errors in the window."}`,
);
console.log(
  "\nNow — and only now — read `lastdb ops` to explain what this delta flagged.\n" +
    "A row that is huge there and absent here is history, not a live cost.",
);
