/**
 * READ-ONLY probe: what does a FAILED BoardMilestones partition read cost
 * `groom milestone-indexes-heal`, and what does the report say about it?
 *
 * `listBoardMilestonesPartition` returns `null` on ANY throw (bare `catch {}`),
 * which on this node is the documented `service_timeout` / "too many concurrent
 * reads" load signal. `classifyBoardMilestoneOps` then:
 *   - counts that board's rows as 0 in the removal-ceiling denominator,
 *   - classifies EVERY swept milestone on that board as an upsert,
 *   - skips the board entirely in the removal/recovery loop.
 *
 * The recovery loop is the only path that repairs index rows for milestones the
 * sweep does not enumerate. This probe measures how many live milestones are
 * reachable ONLY that way.
 *
 * Writes nothing.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoardMilestonesPartition } from "../src/board-milestones.ts";
import { listBoards, sweepMilestoneSlugs, findMilestone } from "../src/record.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "../src/concurrency.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const sweep = await sweepMilestoneSlugs(node, cfg);
const hydrated = await mapWithConcurrency(
  sweep.slugs,
  (slug: string) => findMilestone(node, cfg, slug),
  PARTITION_READ_CONCURRENCY,
);
const sweptLive = hydrated.filter((m): m is NonNullable<typeof m> => Boolean(m));
const sweptByBoard = new Map<string, number>();
for (const m of sweptLive) {
  const b = m.board || "default";
  sweptByBoard.set(b, (sweptByBoard.get(b) ?? 0) + 1);
}

const boards = await listBoards(node, cfg);
console.log(`sweep: enumerated=${sweep.slugs.length} live=${sweptLive.length} failed_leads=${sweep.failedLeads.length}`);
console.log(`boards: ${boards.map((b) => b.slug).join(", ")}`);
console.log("");
console.log("| board | index rows | index slugs LIVE | of those, NOT swept | swept-live on board |");
console.log("|---|---|---|---|---|");

let totalRows = 0;
let totalRecoveryOnly = 0;
for (const board of boards) {
  const rows = await listBoardMilestonesPartition(node, cfg, board.slug);
  if (rows === null) {
    console.log(`| ${board.slug} | READ FAILED (null) | - | - | ${sweptByBoard.get(board.slug) ?? 0} |`);
    continue;
  }
  totalRows += rows.length;
  const slugs = [...new Set(rows.map((r) => r.slug))];
  const truths = await mapWithConcurrency(
    slugs,
    (slug: string) => findMilestone(node, cfg, slug),
    PARTITION_READ_CONCURRENCY,
  );
  let live = 0;
  let recoveryOnly = 0;
  const sweptSlugs = new Set(sweptLive.map((m) => m.slug));
  for (let i = 0; i < slugs.length; i++) {
    const t = truths[i];
    if (!t || (t.board || "default") !== board.slug) continue;
    live++;
    if (!sweptSlugs.has(slugs[i]!)) recoveryOnly++;
  }
  totalRecoveryOnly += recoveryOnly;
  console.log(
    `| ${board.slug} | ${rows.length} | ${live} | ${recoveryOnly} | ${sweptByBoard.get(board.slug) ?? 0} |`,
  );
}

console.log("");
console.log(`TOTAL index rows examined: ${totalRows}`);
console.log(`Live milestones reachable ONLY via the recovery loop: ${totalRecoveryOnly}`);
console.log(`Live milestones the sweep reaches: ${sweptLive.length}`);
