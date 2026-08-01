#!/usr/bin/env bun
/**
 * When a MilestoneCards slug holds two rows, does `milestone reconcile`
 * actually converge — or does it re-issue the same write forever?
 *
 * `reconcileMilestoneCardChildren` classifies `rows.length !== 1` as stale and
 * calls `upsertMilestoneCard(truth, previous = rows[0])`. The purge inside that
 * upsert is gated on `prevSk !== nextSk`. So convergence depends entirely on
 * whether the row the scan happened to return FIRST is the stale one or the
 * true one — a property of partition order, not of the drift.
 *
 * Read-only. Reports, for every duplicated slug on the live primary:
 *   - the sks, in the order the partition read returns them
 *   - which sk the Card record says is true
 *   - whether the purge inside upsertMilestoneCard would fire
 *
 *   bun scripts/probe-milestone-dup-repair-reachability.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listMilestoneCardsPartition, milestoneCardSk } from "../src/milestone-cards.ts";
import { findCardSummaryForReconcile } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const bmHash = cfg.schemaHashes?.board_milestones;
if (!bmHash || !cfg.schemaHashes?.milestone_cards) {
  console.log("milestone_cards / board_milestones not bound — nothing to probe");
  process.exit(0);
}

const milestones: string[] = [];
for (const board of ["default", "agent-dogfood-scratch"]) {
  try {
    const res = await node.queryAll({ schemaHash: bmHash, fields: ["slug"], filter: { HashKey: board } });
    for (const r of res.results ?? []) {
      const s = String(((r.fields ?? {}) as Record<string, unknown>).slug ?? "");
      if (s && !milestones.includes(s)) milestones.push(s);
    }
  } catch {
    /* skip */
  }
}

let dupSlugs = 0;
let unreachable = 0;

for (const ms of milestones) {
  const rows = await listMilestoneCardsPartition(node, cfg, ms);
  if (!rows) {
    console.log(`${ms}: partition read failed`);
    continue;
  }
  const bySlug = new Map<string, typeof rows>();
  for (const r of rows) bySlug.set(r.slug, [...(bySlug.get(r.slug) ?? []), r]);

  for (const [slug, group] of bySlug) {
    if (group.length < 2) continue;
    dupSlugs += 1;
    // Order preserved exactly as the partition read returned it — this is the
    // order reconcile's rowsBySlug map sees, so rows[0] is group[0].
    const sks = group.map((r) => milestoneCardSk(r.column, r.position, r.slug));
    const truth = await findCardSummaryForReconcile(node, cfg, slug).catch(() => null);
    const trueSk = truth ? milestoneCardSk(truth.column, truth.position, truth.slug) : null;
    const prevSk = sks[0]!;
    const prevMs = group[0]!.milestone ?? "";
    const nextMs = truth?.milestone ?? "";

    // Model what reconcileMilestoneCardChildren ACTUALLY does, both branches.
    //
    // No truth (or truth moved milestone/board): the row goes to `removals`,
    // and removeMilestoneCard purges every row for the slug unconditionally.
    // That branch converges no matter which row came back first.
    const goesToRemovals = !truth
      || (truth.milestone ?? "") !== ms
      || (truth.board || "default") !== (group[0]!.board || "default");
    // Truth matches: the row goes to `upserts` with previous = rows[0], and the
    // purge inside upsertMilestoneCard is gated on prevSk !== nextSk.
    const purgeFires = goesToRemovals || prevSk !== trueSk || prevMs !== nextMs;

    console.log(`\n${ms}`);
    console.log(`  slug          ${slug}`);
    sks.forEach((sk, i) => console.log(`  row[${i}]        ${sk}${sk === trueSk ? "   <- TRUE" : ""}`));
    console.log(`  truth         ${trueSk ?? "(card not readable)"}`);
    console.log(`  branch        ${goesToRemovals ? "removals (purges unconditionally)" : "upserts (purge gated on prevSk)"}`);
    console.log(`  converges?    ${purgeFires ? "YES" : "NO  — reconcile rewrites and the orphan SURVIVES"}`);
    if (!purgeFires) unreachable += 1;
  }
}

console.log(`\nduplicated slugs: ${dupSlugs}   unrepairable by reconcile: ${unreachable}`);
console.log(
  `\nColumn sks sort: backlog < doing < done < todo.\n` +
    `rows[0] is the TRUE row (so no purge) whenever the card's real column sorts\n` +
    `BEFORE the orphan's — i.e. every backward move: done->doing, done->backlog,\n` +
    `todo->anything. Those are the cases that cannot self-repair.`,
);
