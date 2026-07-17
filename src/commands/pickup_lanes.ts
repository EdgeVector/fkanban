// `kanban pickup lanes` — show logical pickup lanes: config, pressure, starvation.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { listBoards, listCards } from "../record.ts";
import { buildPickupStatusReportWithSituations } from "../pickup.ts";
import {
  buildLaneStatus,
  laneOf,
  orderCandidatesByLanes,
  parsePickupLaneState,
  type LaneStatusRow,
  type PickupLaneState,
} from "../pickup_lanes.ts";
import type { SituationPreflight } from "../situations.ts";

export type PickupLanesResult = {
  board: string;
  algorithm: string;
  state: PickupLaneState;
  lanes: LaneStatusRow[];
  next_claim_order: string[];
  ready_total: number;
  doing_total: number;
};

export async function pickupLanesResult(opts: {
  cfg: Config;
  node: NodeClient;
  board?: string;
  situationPreflight?: SituationPreflight;
}): Promise<PickupLanesResult> {
  const board = opts.board ?? "default";
  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const boardRec = boards.find((b) => b.slug === board);
  const state = parsePickupLaneState(boardRec?.body ?? "");

  const report = await buildPickupStatusReportWithSituations(
    cards,
    boards,
    opts.situationPreflight,
    { cfg: opts.cfg, node: opts.node },
  );
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const readyCards = report.cards
    .filter((c) => c.ready && c.board === board && c.column === "todo")
    .map((c) => bySlug.get(c.slug))
    .filter((c): c is NonNullable<typeof c> => !!c);

  const lanes = buildLaneStatus(readyCards, cards, state, board);
  const order = orderCandidatesByLanes(readyCards, cards, state, board).map((c) => c.slug);

  return {
    board,
    algorithm:
      "p0-now first → program lanes fair-share (fewest doing, then oldest last-claim) → papercut → unlaned",
    state,
    lanes,
    next_claim_order: order.slice(0, 20),
    ready_total: readyCards.length,
    doing_total: cards.filter((c) => c.board === board && c.column === "doing").length,
  };
}

export function formatPickupLanes(result: PickupLanesResult, json?: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  const lines: string[] = [
    `pickup lanes — board=${result.board}`,
    `algorithm: ${result.algorithm}`,
    `ready=${result.ready_total} doing=${result.doing_total} sequence=${result.state.sequence}` +
      (result.state.last_claim_slug
        ? ` last_claim=${result.state.last_claim_slug} lane=${result.state.last_claim_lane ?? "?"}`
        : ""),
    "",
    "LANE".padEnd(48) + "READY".padStart(6) + "DOING".padStart(7) + "  STARVED  NEXT",
  ];

  for (const row of result.lanes) {
    if (row.ready === 0 && row.doing === 0) continue;
    const starved = row.starved ? "yes" : "no";
    lines.push(
      row.lane.padEnd(48) +
        String(row.ready).padStart(6) +
        String(row.doing).padStart(7) +
        "  " +
        starved.padEnd(8) +
        (row.next_slug ?? "-"),
    );
  }

  if (result.next_claim_order.length > 0) {
    lines.push("");
    lines.push("next claim order (first 20 ready; overlap not applied yet):");
    for (const [i, slug] of result.next_claim_order.entries()) {
      lines.push(`  ${String(i + 1).padStart(2)}. ${slug}`);
    }
  }

  lines.push("");
  lines.push(
    "Annotations (optional): lane:p0-now | lane:program:<ns-slug> | lane:papercut. " +
      "Without tags: P0 → p0-now; north_star → program:*; routine-error/papercut heuristics → papercut.",
  );

  return lines.join("\n");
}

export async function pickupLanesCmd(opts: {
  cfg: Config;
  node: NodeClient;
  board?: string;
  json?: boolean;
  situationPreflight?: SituationPreflight;
}): Promise<string> {
  const result = await pickupLanesResult(opts);
  if (opts.json) return JSON.stringify(result, null, 2);

  const board = opts.board ?? "default";
  const cards = await listCards(opts.node, opts.cfg);
  const laneBySlug = new Map<string, string>();
  for (const c of cards) {
    if (c.board === board) laneBySlug.set(c.slug, laneOf(c));
  }

  const lines = formatPickupLanes(result, false).split("\n");
  const idx = lines.findIndex((l) => l.startsWith("next claim order"));
  if (idx >= 0) {
    const head = lines.slice(0, idx + 1);
    const tail: string[] = [];
    for (const [i, slug] of result.next_claim_order.entries()) {
      const lane = laneBySlug.get(slug) ?? "?";
      tail.push(`  ${String(i + 1).padStart(2)}. [${lane}] ${slug}`);
    }
    let j = idx + 1;
    while (j < lines.length && lines[j]!.startsWith("  ")) j++;
    return [...head, ...tail, ...lines.slice(j)].join("\n");
  }
  return lines.join("\n");
}
