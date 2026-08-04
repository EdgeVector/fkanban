#!/usr/bin/env bun
/**
 * What does the COMPLETE parity baseline actually cost on the milestone indexes?
 *
 * `doctor`'s BoardCards parity uses the union over every leading field
 * (`sweepBoardCardsPartition`) — the only baseline that is not itself a
 * projection. The two milestone indexes use a one-field `slug` spine instead,
 * with a recorded justification that the sweep "costs ~780ms per partition;
 * across the milestone partitions on this board it would turn an 8s doctor into
 * a 40s one."
 *
 * That constant was measured on BoardCards' `default` partition — 123 rows, 24
 * leads. The milestone partitions are a different shape entirely (52 rows across
 * 19 partitions). The estimate has been carried across four runs and blocked a
 * correctness fix; nobody has measured it on the index it is being used to
 * decide about.
 *
 * Read-only. Times, per partition:
 *   - the slug-only spine (today's baseline)
 *   - the full per-lead sweep union (the complete baseline)
 * and reports any row the sweep reaches that the spine does not.
 *
 *   bun scripts/probe-milestone-parity-baseline-cost.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient, type QueryFilter } from "../src/client.ts";
import {
  BOARD_MILESTONES_FIELDS,
  MILESTONE_CARDS_FIELDS,
} from "../src/schemas.ts";
import { listBoards } from "../src/record.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const CONCURRENCY = 8;

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

type LeadResult = { lead: string; sks: Set<string>; error: string | null };

/** Read one partition under ONE leading field; report refusal, never swallow. */
async function readLead(
  schemaHash: string,
  partition: string,
  lead: string,
): Promise<LeadResult> {
  const filter = { HashKey: partition } as QueryFilter;
  try {
    const res = await (node as NodeClient).queryAll({
      schemaHash,
      fields: [lead],
      filter,
    });
    const sks = new Set<string>();
    for (const row of res.results) {
      // The row's REAL address is the range key, not a payload copy of it —
      // on a partially-written row the copy is exactly what went missing.
      const sk = typeof row.key?.range === "string" && row.key.range.length > 0
        ? row.key.range
        : null;
      if (sk !== null) sks.add(sk);
    }
    // A read that returned rows but no addressable key is not an empty
    // partition — refuse to report it as one.
    if (res.results.length > 0 && sks.size === 0) {
      return {
        lead,
        sks,
        error: `${res.results.length} row(s) returned with no range key — cannot address them`,
      };
    }
    return { lead, sks, error: null };
  } catch (err) {
    return {
      lead,
      sks: new Set<string>(),
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

async function measure(
  label: string,
  schemaHash: string,
  partitions: string[],
  fields: readonly string[],
): Promise<void> {
  console.log(`\n=== ${label} — ${partitions.length} partition(s), ${fields.length} leads ===`);

  // Today's baseline: one read per partition, leading with `slug`.
  const spineStart = performance.now();
  const spine = await mapWithConcurrency(
    partitions,
    async (p) => ({ p, r: await readLead(schemaHash, p, "slug") }),
    CONCURRENCY,
  );
  const spineMs = performance.now() - spineStart;

  // The complete baseline: union over every leading field.
  const sweepStart = performance.now();
  const sweep = await mapWithConcurrency(
    partitions,
    async (p) => {
      const perLead = await mapWithConcurrency(
        [...fields],
        (lead) => readLead(schemaHash, p, lead),
        CONCURRENCY,
      );
      const union = new Set<string>();
      const failed: string[] = [];
      for (const l of perLead) {
        if (l.error !== null) failed.push(`${l.lead}: ${l.error.slice(0, 80)}`);
        for (const sk of l.sks) union.add(sk);
      }
      return { p, union, failed, perLead };
    },
    CONCURRENCY,
  );
  const sweepMs = performance.now() - sweepStart;

  const spineBySk = new Map(spine.map((s) => [s.p, s.r]));
  let totalSpine = 0;
  let totalSweep = 0;
  let totalInvisible = 0;

  for (const s of sweep) {
    const spineRows = spineBySk.get(s.p)?.sks ?? new Set<string>();
    totalSpine += spineRows.size;
    totalSweep += s.union.size;
    const invisible = [...s.union].filter((sk) => !spineRows.has(sk));
    totalInvisible += invisible.length;
    if (invisible.length > 0 || s.failed.length > 0) {
      console.log(`  ${s.p}: spine=${spineRows.size} sweep=${s.union.size}`);
      if (invisible.length > 0) {
        console.log(`    INVISIBLE TO THE SPINE (${invisible.length}): ${invisible.slice(0, 5).join(", ")}`);
        // Which leads DID reach them — that names the atom the row is missing.
        for (const sk of invisible.slice(0, 3)) {
          const reached = s.perLead.filter((l) => l.sks.has(sk)).map((l) => l.lead);
          console.log(`      ${sk} reachable under: ${reached.join(", ")}`);
        }
      }
      for (const f of s.failed) console.log(`    REFUSED LEAD ${f}`);
    }
  }

  console.log(`  ---`);
  console.log(`  spine (1 lead):  ${spineMs.toFixed(0)}ms   ${totalSpine} rows`);
  console.log(`  sweep (${fields.length} leads): ${sweepMs.toFixed(0)}ms   ${totalSweep} rows`);
  console.log(`  cost multiple:   ${(sweepMs / Math.max(spineMs, 1)).toFixed(1)}x`);
  // A probe that read nothing reports "no drift" identically to a probe that
  // read everything and found none. Say which one happened.
  if (totalSweep === 0) {
    console.log(`  ** READ NOTHING — this is not evidence of parity. Fix the probe. **`);
  } else {
    console.log(`  rows the spine cannot see: ${totalInvisible}`);
  }
}

const boards = (await listBoards(node, cfg)).map((b) => b.slug);
console.log(`boards: ${boards.join(", ")}`);

const bmHash = cfg.schemaHashes?.board_milestones;
if (bmHash) {
  await measure("BoardMilestones", bmHash, boards, BOARD_MILESTONES_FIELDS);
} else {
  console.log("board_milestones not bound — skipped");
}

const mcHash = cfg.schemaHashes?.milestone_cards;
if (mcHash) {
  // Candidate partitions: every milestone some card names, same set doctor uses.
  const { listCards } = await import("../src/record.ts");
  const cards = await listCards(node, cfg);
  const milestones = [...new Set(cards.map((c) => (c.milestone ?? "").trim()).filter((m) => m.length > 0))].sort();
  await measure("MilestoneCards", mcHash, milestones, MILESTONE_CARDS_FIELDS);
} else {
  console.log("milestone_cards not bound — skipped");
}
