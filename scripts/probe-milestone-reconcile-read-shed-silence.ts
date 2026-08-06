/**
 * READ-ONLY probe: what does `milestone reconcile`/`detail` REPORT when one of
 * its two MilestoneCards reads is shed by the node?
 *
 * The reconcile wave issues two reads against the SAME partition:
 *   - `listMilestoneCardsPartition`      (wide payload read, ~15 fields)
 *   - `listMilestoneCardsPartitionSpine` (address enumeration, projects `slug`)
 *
 * Both return `null` from a bare `catch {}`. The call site then:
 *   - wide null   => skips reconciliation entirely, children come from the
 *                    board, repairs are hard-coded to all-zero, and
 *                    `renderRepairPlan` prints NOTHING because classified === 0.
 *   - spine null  => `indexAddresses ?? []`, so every board card is classified
 *                    stale (rows.length !== 1) and queued as an upsert with
 *                    `previous: null`, while every orphan removal is skipped
 *                    because `rows[0]` is undefined.
 *
 * This probe runs the REAL reconcile classifier against the REAL primary in
 * `apply: false` mode under three arms — healthy, wide shed, spine shed — and
 * prints the repair plan and the rendered text each arm produces.
 *
 * Fault injection is a Proxy over the real node client that throws
 * `service_timeout` on MilestoneCards queries only, discriminated by projection
 * width. Point reads and every other schema still answer, which is the real
 * shape: the node sheds one query and serves its neighbour.
 *
 * Writes nothing: `apply: false` on every arm.
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { milestoneCardsHash, listMilestoneCardsPartition, listMilestoneCardsPartitionSpine } from "../src/milestone-cards.ts";
import { milestoneReconcileResult } from "../src/commands/milestone.ts";
import { listMilestones } from "../src/record.ts";

const cfg = readConfig();
const realNode = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const MS_HASH = milestoneCardsHash(cfg);
if (!MS_HASH) {
  console.log("milestone_cards is not bound in this config — nothing to probe.");
  process.exit(0);
}

type Shed = "none" | "wide" | "spine";

/** Throw on MilestoneCards queries of the named projection width only. */
function shedding(node: NodeClient, shed: Shed): NodeClient {
  if (shed === "none") return node;
  return new Proxy(node, {
    get(target, prop, recv) {
      if (prop !== "queryAll") return Reflect.get(target, prop, recv);
      return async (opts: { schemaHash: string; fields: string[]; filter?: unknown; allowFullScan?: boolean }) => {
        if (opts.schemaHash === MS_HASH) {
          const isSpine = opts.fields.length === 1 && opts.fields[0] === "slug";
          if ((shed === "spine" && isSpine) || (shed === "wide" && !isSpine)) {
            throw new Error("service_timeout: node did not respond within 30000ms");
          }
        }
        return await node.queryAll(opts);
      };
    },
  }) as NodeClient;
}

// Candidates: milestones whose MilestoneCards partition actually holds rows.
// A partition with no rows cannot show a difference between the arms.
const milestones = await listMilestones(realNode, cfg);
const candidates: Array<{ slug: string; wide: number; spine: number }> = [];
for (const m of milestones) {
  const [wide, spine] = await Promise.all([
    listMilestoneCardsPartition(realNode, cfg, m.slug),
    listMilestoneCardsPartitionSpine(realNode, cfg, m.slug),
  ]);
  const w = wide?.length ?? 0;
  const s = spine?.length ?? 0;
  if (w > 0 || s > 0) candidates.push({ slug: m.slug, wide: w, spine: s });
  if (candidates.length >= 4) break;
}

console.log(`live milestones: ${milestones.length}`);
console.log(`probed partitions (first 4 with rows): ${candidates.map((c) => `${c.slug} wide=${c.wide} spine=${c.spine}`).join(" | ")}`);
console.log("");
console.log("| milestone | arm | children | upserts | removals | repair line | index_read_failed | banner | warned |");
console.log("|---|---|---|---|---|---|---|---|---|");

for (const c of candidates) {
  for (const shed of ["none", "wide", "spine"] as Shed[]) {
    const node = shedding(realNode, shed);
    try {
      const r = await milestoneReconcileResult({ cfg, node, slug: c.slug, apply: false });
      const lines = r.text.split("\n");
      const repairLine = lines.some((l) => l.startsWith("index drift:") || l.startsWith("index repair:"));
      const banner = lines.some((l) => l.includes("⚠ INDEX READ INCOMPLETE"));
      const warned = r.warnings.some((w) => w.code === "unreadable-milestone-index");
      console.log(
        `| ${c.slug} | ${shed} | ${r.children.length} | ${r.repairs.upserts} | ${r.repairs.removals} | ${repairLine ? "yes" : "NO"} | ${r.repairs.index_read_failed ?? "null"} | ${banner ? "yes" : "NO"} | ${warned ? "yes" : "NO"} |`,
      );
    } catch (err) {
      console.log(`| ${c.slug} | ${shed} | THREW: ${(err as Error).message} | | | | | | |`);
    }
  }
}
