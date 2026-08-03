#!/usr/bin/env bun
/**
 * READ-ONLY probe: the SERIAL ROUND-TRIP DEPTH of each hot kanban command.
 *
 * Run (e) established the cost model for every client of this node:
 *
 *     wall time ~= serial round-trip depth x ~190ms
 *
 * ...because a request costs ~190ms on an *idle* node regardless of what it
 * asks for (10 sequential 404s = 1.92s, 10 concurrent = 0.19s). Rows, fields
 * and bytes measured 1.02x. Depth is the only lever.
 *
 * So the actionable map is not "which command issues the most requests" — a
 * command issuing 40 requests in one wave is FAST. It is "how many WAVES does
 * each command have", i.e. how many times does it await a response before it
 * can issue the next request.
 *
 * Measured by monkey-patching `globalThis.fetch`, which is the single choke
 * point every node request funnels through (src/client.ts:1604), so the count
 * includes the SDK/capability/attestation layers the command never sees.
 *
 * A "wave" ends when a request starts after every request in the current wave
 * has finished — that is exactly the boundary that costs another ~190ms.
 *
 * Run: bun scripts/probe-round-trip-depth.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listResult } from "../src/commands/list.ts";
import { showResult } from "../src/commands/show.ts";
import { searchResult } from "../src/commands/search.ts";
import { pickupStatusResult } from "../src/commands/pickup_status.ts";
import { overlapResult } from "../src/commands/overlap.ts";
import {
  milestoneListResult,
  milestonePortfolioResult,
  milestoneDetailResult,
} from "../src/commands/milestone.ts";

type Req = { path: string; start: number; end: number };

const realFetch = globalThis.fetch;
let recording: Req[] | null = null;

// Patch once, globally. Every node request in this process funnels through it.
globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
  const start = performance.now();
  const res = await realFetch(input as Parameters<typeof realFetch>[0], init);
  const end = performance.now();
  if (recording) {
    const raw = typeof input === "string" ? input : String((input as Request).url ?? input);
    recording.push({ path: raw.replace(/^https?:\/\/[^/]+/, ""), start, end });
  }
  return res;
}) as typeof fetch;

/**
 * Number of serial waves in a request timeline.
 *
 * Sweep by start time; a request that begins only after EVERY request in the
 * current wave has already ended could not have been issued without first
 * awaiting one of them, so it opens a new wave. Requests that merely overlap
 * partially stay in the same wave — they are concurrent in flight and share
 * one ~190ms window.
 */
function waves(reqs: Req[]): number {
  if (reqs.length === 0) return 0;
  const sorted = [...reqs].sort((a, b) => a.start - b.start);
  let count = 1;
  let waveEnd = sorted[0]!.end;
  for (const r of sorted.slice(1)) {
    if (r.start >= waveEnd) {
      count++;
      waveEnd = r.end;
    } else {
      waveEnd = Math.max(waveEnd, r.end);
    }
  }
  return count;
}

async function profile(name: string, fn: () => Promise<unknown>): Promise<void> {
  const reqs: Req[] = [];
  recording = reqs;
  const t0 = performance.now();
  let err: string | null = null;
  try {
    await fn();
  } catch (e) {
    err = e instanceof Error ? e.message : String(e);
  }
  const wall = performance.now() - t0;
  recording = null;

  const w = waves(reqs);
  const perWave = w > 0 ? (wall / w).toFixed(0) : "-";
  console.log(
    `${name.padEnd(26)} wall=${wall.toFixed(0).padStart(6)}ms  reqs=${
      String(reqs.length).padStart(3)
    }  waves=${String(w).padStart(3)}  ms/wave=${String(perWave).padStart(4)}  ${
      err ? `ERR ${err}` : ""
    }`,
  );

  // Per-wave breakdown: what is each serial step waiting on?
  if (process.env.DETAIL && reqs.length) {
    const sorted = [...reqs].sort((a, b) => a.start - b.start);
    let waveNo = 1;
    let waveEnd = sorted[0]!.end;
    const buckets: string[][] = [[]];
    for (const r of sorted) {
      if (r.start >= waveEnd && buckets[waveNo - 1]!.length) {
        waveNo++;
        buckets.push([]);
        waveEnd = r.end;
      } else {
        waveEnd = Math.max(waveEnd, r.end);
      }
      buckets[waveNo - 1]!.push(r.path);
    }
    buckets.forEach((b, i) => {
      const tally = new Map<string, number>();
      for (const p of b) tally.set(p, (tally.get(p) ?? 0) + 1);
      const shown = [...tally].map(([p, n]) => (n > 1 ? `${p} x${n}` : p)).join(", ");
      console.log(`    wave ${String(i + 1).padStart(2)}: ${shown.slice(0, 150)}`);
    });
  }
}

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

// A card that exists, for the point-read paths.
const probeSlug = process.env.PROBE_SLUG ?? "";
let slug = probeSlug;
if (!slug) {
  const first = await listResult({ cfg, node, column: "done", limit: 1 });
  slug = first.cards[0]?.slug ?? "";
}
if (!slug) throw new Error("no card to probe with");
console.log(`probe card: ${slug}\n`);

// Warm the process once so lazy attestation/schema-resolution costs are not
// billed to whichever command happens to run first.
await listResult({ cfg, node, limit: 1 });

console.log("command                       wall        reqs  waves  ms/wave");
console.log("-".repeat(72));

await profile("list (bare)", () => listResult({ cfg, node }));
await profile("list --column todo", () => listResult({ cfg, node, column: "todo" }));
await profile("list --all", () => listResult({ cfg, node, all: true }));
await profile("show <slug>", () => showResult({ cfg, node, slug }));
await profile("search 'kanban'", () => searchResult({ cfg, node, query: "kanban" }));
await profile("pickup status", () => pickupStatusResult({ cfg, node }));
await profile("overlap <slug>", () => overlapResult({ cfg, node, slug }));
await profile("milestone list", () => milestoneListResult({ cfg, node }));
await profile("milestone portfolio", () => milestonePortfolioResult({ cfg, node }));

const ms = await milestoneListResult({ cfg, node });
const msSlug = ms.milestones[0]?.slug;
if (msSlug) {
  await profile("milestone detail", () => milestoneDetailResult({ cfg, node, slug: msSlug }));
}
