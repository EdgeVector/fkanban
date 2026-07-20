// `fkanban pickup explain <slug>` — single readiness decision path for one card.
// Composes write-guard (assertDefaultTodoPickupReady) + classifyPickupCard +
// laneOf + overlap-against-doing so agents/Tom don't re-derive policy from prompts.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  assertDefaultTodoPickupReady,
  depStatus,
  listBoards,
  listCards,
  listDependencyStatusesForCards,
  requireCard,
  type Card,
} from "../record.ts";
import {
  classifyPickupCard,
  type PickupCategory,
  type PickupClassification,
} from "../pickup.ts";
import { laneOf, type LaneId } from "../pickup_lanes.ts";
import { overlapAgainstCards, type OverlapResult } from "./overlap.ts";
import {
  checkSituationFence,
  type SituationPreflight,
} from "../situations.ts";

export type WriteGuardStep = {
  ok: boolean;
  code?: string;
  message?: string;
  hint?: string;
};

export type PickupExplainReport = {
  slug: string;
  board: string;
  column: string;
  kind: string;
  repo: string;
  base: string;
  block_status: string;
  category: PickupCategory;
  ready: boolean;
  reason: string;
  suggestion: string;
  details: string[];
  blockedBy: string[];
  missingDeps: string[];
  lane: LaneId;
  write_guard: WriteGuardStep;
  surface_overlap: {
    conflicts: { slug: string; surfaces: string[] }[];
    warnings: string[];
    would_skip: boolean;
  };
  situation: { allowed: boolean; reason?: string; details?: string[] };
  eligible_for_claim: boolean;
  gates: { name: string; ok: boolean; note: string }[];
};

function writeGuardFor(card: Card): WriteGuardStep {
  try {
    const probe: Card = { ...card, board: "default", column: "todo" };
    assertDefaultTodoPickupReady(probe);
    return { ok: true };
  } catch (err) {
    if (err instanceof FkanbanError) {
      return {
        ok: false,
        code: err.code,
        message: err.message,
        hint: err.hint,
      };
    }
    return {
      ok: false,
      code: "unknown",
      message: err instanceof Error ? err.message : String(err),
    };
  }
}

function gatesFrom(
  classification: PickupClassification,
  writeGuard: WriteGuardStep,
  overlap: OverlapResult,
  situationAllowed: boolean,
  situationReason: string,
): { name: string; ok: boolean; note: string }[] {
  return [
    {
      name: "write-guard (default/todo policy)",
      ok: writeGuard.ok,
      note: writeGuard.ok
        ? "would pass assertDefaultTodoPickupReady"
        : (writeGuard.message ?? "failed"),
    },
    {
      name: "classify",
      ok: classification.ready,
      note: `${classification.category}: ${classification.reason}`,
    },
    {
      name: "surface-overlap",
      ok: overlap.conflicts.length === 0,
      note:
        overlap.conflicts.length === 0
          ? "no conflicts with doing"
          : `conflicts: ${overlap.conflicts.map((c) => c.slug).join(", ")}`,
    },
    {
      name: "situation-fence",
      ok: situationAllowed,
      note: situationAllowed ? "allowed" : situationReason || "blocked",
    },
  ];
}

export async function pickupExplainResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  situationPreflight?: SituationPreflight;
}): Promise<PickupExplainReport> {
  const slug = opts.slug.trim();
  if (!slug) {
    throw new FkanbanError({
      code: "usage",
      message: "pickup explain requires a card slug",
      hint: "Usage: fkanban pickup explain <slug> [--json]",
    });
  }

  let cards = await listCards(opts.node, opts.cfg);
  const boards = await listBoards(opts.node, opts.cfg);
  cards = await listDependencyStatusesForCards(opts.node, opts.cfg, cards);

  let card = cards.find((c) => c.slug === slug);
  if (!card) {
    card = await requireCard(opts.node, opts.cfg, slug);
    cards = [...cards.filter((c) => c.slug !== slug), card];
  }

  const terminalByBoard = new Map(
    boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]),
  );
  const dep = depStatus(card, cards, terminalByBoard);

  const fence = await checkSituationFence(card, opts.situationPreflight);
  const classification = classifyPickupCard(
    card,
    cards,
    dep,
    fence.allowed ? undefined : fence,
  );

  const writeGuard = writeGuardFor(card);
  const lane = laneOf(card);
  const overlap = overlapAgainstCards(card, cards);
  const wouldSkipOverlap = overlap.conflicts.length > 0;

  const eligible =
    classification.ready &&
    classification.column === "todo" &&
    classification.board === "default" &&
    !wouldSkipOverlap &&
    fence.allowed;

  const gates = gatesFrom(
    classification,
    writeGuard,
    overlap,
    fence.allowed,
    fence.reason ?? "",
  );

  return {
    slug: card.slug,
    board: card.board,
    column: card.column,
    kind: classification.kind,
    repo: classification.repo,
    base: classification.base,
    block_status: classification.block_status,
    category: classification.category,
    ready: classification.ready,
    reason: classification.reason,
    suggestion: classification.suggestion,
    details: classification.details,
    blockedBy: classification.blockedBy,
    missingDeps: classification.missingDeps,
    lane,
    write_guard: writeGuard,
    surface_overlap: {
      conflicts: overlap.conflicts.map((c) => ({
        slug: c.slug,
        surfaces: c.matches.map((m) => `${m.candidate}<->${m.other}`),
      })),
      warnings: overlap.warnings,
      would_skip: wouldSkipOverlap,
    },
    situation: {
      allowed: fence.allowed,
      reason: fence.reason,
      details: fence.details,
    },
    eligible_for_claim: eligible,
    gates,
  };
}

export function renderPickupExplain(report: PickupExplainReport): string {
  const lines: string[] = [];
  lines.push(`pickup explain — ${report.slug}`);
  lines.push(
    `  board/column: ${report.board}/${report.column}  kind=${report.kind}  lane=${report.lane}`,
  );
  lines.push(
    `  repo=${report.repo || "(none)"}  base=${report.base || "(none)"}  block_status=${report.block_status}`,
  );
  lines.push(
    `  category: ${report.category}${report.ready ? " (ready)" : ""} — ${report.reason}`,
  );
  for (const d of report.details) lines.push(`    detail: ${d}`);
  lines.push(`  eligible_for_claim: ${report.eligible_for_claim ? "YES" : "NO"}`);
  lines.push("  gates:");
  for (const g of report.gates) {
    lines.push(`    ${g.ok ? "OK  " : "FAIL"} ${g.name} — ${g.note}`);
  }
  if (!report.write_guard.ok && report.write_guard.hint) {
    lines.push(`  write-guard hint: ${report.write_guard.hint}`);
  }
  if (report.suggestion) lines.push(`  suggestion: ${report.suggestion}`);
  if (report.blockedBy.length) {
    lines.push(`  blockedBy: ${report.blockedBy.join(", ")}`);
  }
  if (report.surface_overlap.would_skip) {
    lines.push(
      `  surface-overlap skip: ${report.surface_overlap.conflicts.map((c) => c.slug).join(", ")}`,
    );
  }
  return lines.join("\n");
}

export async function pickupExplainCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
  situationPreflight?: SituationPreflight;
}): Promise<string> {
  const report = await pickupExplainResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : renderPickupExplain(report);
}
