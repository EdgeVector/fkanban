// `fkanban pickup explain <slug>` — single readiness decision path for one card.
// Composes write-guard (assertDefaultTodoWriteGuard) + classifyPickupCard +
// laneOf + overlap-against-doing so agents/Tom don't re-derive policy from prompts.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  assertDefaultTodoWriteGuard,
  depStatus,
  findMilestone,
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
import { effectiveSurfaces, surfacesOverlap } from "../pickup_v2.ts";
import {
  hydrateOverlapPeers,
  overlapAgainstCards,
  overlapVerdict,
  type OverlapResult,
  type OverlapVerdict,
} from "./overlap.ts";
import {
  checkSituationFence,
  type SituationPreflight,
} from "../situations.ts";
import {
  probeCardPrLiveness,
  type PrLiveness,
  type PrLivenessProbe,
} from "../pr_liveness.ts";

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
    /** What the gate established — see {@link OverlapVerdict}. */
    verdict: OverlapVerdict;
    /** Peers in `doing` reached but not comparable (undeclared / unread). */
    unevaluated_peers: string[];
    /**
     * The doing card that claim-v2 skips this card for, by the claim's own
     * rule (`surfacesOverlap`): a card with no Surfaces reserves its whole
     * repo. `null` when claim-v2 would not skip it for overlap.
     */
    claim_v2_blocked_by: string | null;
  };
  situation: { allowed: boolean; reason?: string; details?: string[] };
  eligible_for_claim: boolean;
  /**
   * `ok` stays the binary "did this gate pass" every existing consumer reads.
   * `status: "unknown"` is additive and means the gate could not evaluate —
   * neither a pass nor a failure. Rendering those as FAIL would be as wrong as
   * the OK it replaced, in the other direction.
   */
  gates: { name: string; ok: boolean; note: string; status?: "unknown" }[];
  /**
   * Venue liveness of `pr_url`. Always present. `state=none` when the card
   * has no locator. Closed-unmerged is WORK, not reconcile.
   */
  pr_liveness: PrLiveness;
};

function writeGuardFor(
  card: Card,
  opts?: { enforceLivePrMilestone?: boolean; milestoneState?: string },
): WriteGuardStep {
  try {
    const probe: Card = { ...card, board: "default", column: "todo" };
    // Same function moveCmd / addCmd run. Explain saying YES on a card the
    // claim write then rejects is exactly the contradiction that let one
    // unclaimable head noop pickup for hours.
    assertDefaultTodoWriteGuard(probe, false, undefined, {
      milestoneState: opts?.milestoneState ?? "",
      enforceLivePrMilestone: opts?.enforceLivePrMilestone === true,
    });
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

/**
 * Render the surface-overlap gate as what it actually established.
 *
 * `unknown` and `partial` are NOT failures — they report absent input, and
 * failing them would strand nearly every card on a board where surfaces are
 * near-universally undeclared. They are surfaced as not-passing so that an
 * agent reading the gate list cannot mistake "nothing was declared" for
 * "checked, clear", which is the whole defect.
 */
function surfaceOverlapGate(
  overlap: OverlapResult,
): { name: string; ok: boolean; note: string; status?: "unknown" } {
  const verdict = overlapVerdict(overlap);
  const peers = overlap.unevaluatedPeers;
  const notes: Record<OverlapVerdict, string> = {
    conflict: `conflicts: ${overlap.conflicts.map((c) => c.slug).join(", ")}`,
    clear: "no conflicts with doing",
    unknown: overlap.repo
      ? `not evaluated — ${overlap.slug} declares no surfaces; nothing was compared`
      : `not evaluated — ${overlap.slug} declares no repo; nothing was compared`,
    partial: `no conflicts among comparable peers, but ${peers.length} in doing could not be judged: ${peers.join(", ")}`,
  };
  const gate: { name: string; ok: boolean; note: string; status?: "unknown" } = {
    name: "surface-overlap",
    ok: verdict === "clear",
    note: notes[verdict],
  };
  if (verdict === "unknown" || verdict === "partial") gate.status = "unknown";
  return gate;
}

function prLivenessGate(
  live: PrLiveness,
): { name: string; ok: boolean; note: string; status?: "unknown" } {
  const gate: { name: string; ok: boolean; note: string; status?: "unknown" } = {
    name: "pr-liveness",
    ok: live.action === "work",
    note: `${live.state} venue=${live.venue} action=${live.action} — ${live.note}`,
  };
  if (live.state === "unknown") gate.status = "unknown";
  return gate;
}

function gatesFrom(
  classification: PickupClassification,
  writeGuard: WriteGuardStep,
  overlap: OverlapResult,
  situationAllowed: boolean,
  situationReason: string,
  prLiveness: PrLiveness,
  claimV2Peer: Card | null,
  card: Card,
): { name: string; ok: boolean; note: string; status?: "unknown" }[] {
  return [
    {
      name: "write-guard (default/todo policy)",
      ok: writeGuard.ok,
      note: writeGuard.ok
        ? "would pass assertDefaultTodoWriteGuard"
        : (writeGuard.message ?? "failed"),
    },
    {
      name: "classify",
      ok: classification.ready,
      note: `${classification.category}: ${classification.reason}`,
    },
    // `ok` here means "this gate checked and passed", not merely "conflicts is
    // empty" — those are different claims, and on the live board (100 of 104
    // todo cards declare no surfaces) the second one was almost never the
    // first. Advisory only: `would_skip` below still keys off `conflicts`.
    surfaceOverlapGate(overlap),
    // The advisory gate above and claim-v2 answered different questions: the
    // advisory gate said UNK for a card with no Surfaces while claim-v2 read
    // the empty list as "**" and skipped the card. Explain said "Pick this card
    // up next" for hours while every pickup worker claimed nothing
    // (2026-09-26, cloud-sync-resume-evidence-provenance-20260924). This gate
    // is the claim's own rule, so explain and claim cannot disagree.
    {
      name: "claim-v2 overlap (repo reservation)",
      ok: claimV2Peer === null,
      note: claimV2Peer === null
        ? "claim-v2 would not skip for overlap"
        : `claim-v2 skips: surface overlap with doing card ${claimV2Peer.slug}` +
          (card.surfaces.length === 0 || claimV2Peer.surfaces.length === 0
            ? ` (${card.surfaces.length === 0 ? card.slug : claimV2Peer.slug} declares no Surfaces, so it reserves all of ${card.repo}; set Surfaces: to run in parallel)`
            : ` (${effectiveSurfaces(card).join(",")} vs ${effectiveSurfaces(claimV2Peer).join(",")})`),
    },
    {
      name: "situation-fence",
      ok: situationAllowed,
      note: situationAllowed ? "allowed" : situationReason || "blocked",
    },
    prLivenessGate(prLiveness),
  ];
}

export async function pickupExplainResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  situationPreflight?: SituationPreflight;
  prLivenessProbe?: PrLivenessProbe;
}): Promise<PickupExplainReport> {
  const slug = opts.slug.trim();
  if (!slug) {
    throw new FkanbanError({
      code: "usage",
      message: "pickup explain requires a card slug",
      hint: "Usage: fkanban pickup explain <slug> [--json]",
    });
  }

  const boards = await listBoards(opts.node, opts.cfg);
  let cards = await listCards(opts.node, opts.cfg, { boards });
  cards = await listDependencyStatusesForCards(opts.node, opts.cfg, cards);

  // The peer set stays thin — dep status, overlap and lane all read real
  // fields (deps/column/repo/surfaces), never the body. The SUBJECT card is
  // point-read for its body, because the write-guard and the registry
  // classifier both judge it: on the thin list every card came back "empty or
  // annotation-only body" for a body that was never fetched, and the report
  // presented that phantom next to real blockers as if they were the same
  // kind of finding.
  const card = await requireCard(opts.node, opts.cfg, slug);
  cards = [...cards.filter((c) => c.slug !== slug), card];
  // Overlap judges the doing peers' Repo/Surfaces claims, which may live only
  // in a body the thin list never read — hydrate that small set too, or the
  // surface-overlap gate reports OK about peers it could not evaluate.
  cards = await hydrateOverlapPeers(opts.node, opts.cfg, cards);

  const dep = depStatus(card, cards);

  const fence = await checkSituationFence(card, opts.situationPreflight);
  const enforceLivePrMilestone = opts.cfg.enforceLivePrMilestone === true;

  // The abandoned-milestone gate needs the Milestone record; a read failure
  // degrades to state "" (gate passes on state, still fails on a missing
  // milestone) rather than failing the whole explain. Classification gets the
  // same state so ready ≠ write-guard cannot disagree on abandoned outcomes.
  let milestoneState = "";
  const msSlug = (card.milestone ?? "").trim();
  let milestoneStateBySlug: Map<string, string> | undefined;
  if (msSlug && enforceLivePrMilestone) {
    const ms = await findMilestone(opts.node, opts.cfg, msSlug).catch(() => null);
    if (ms) {
      milestoneState = ms.state;
      milestoneStateBySlug = new Map([[ms.slug, ms.state]]);
    } else {
      // Missing record: classify as unattached (same as empty portfolio map miss).
      milestoneStateBySlug = new Map();
    }
  }
  const prLiveness = await probeCardPrLiveness(card, {
    node: opts.node,
    probe: opts.prLivenessProbe,
  });
  const prLivenessBySlug = new Map([[card.slug, prLiveness]]);
  const classification = classifyPickupCard(
    card,
    cards,
    dep,
    fence.allowed ? undefined : fence,
    {
      requireLiveMilestone: enforceLivePrMilestone,
      milestoneStateBySlug,
      prLivenessBySlug,
    },
  );
  const writeGuard = writeGuardFor(card, { enforceLivePrMilestone, milestoneState });
  const lane = laneOf(card);
  const overlap = overlapAgainstCards(card, cards);
  const claimV2Peer =
    cards.find(
      (p) =>
        p.slug !== card.slug &&
        p.board === card.board &&
        p.column === "doing" &&
        surfacesOverlap(card, p),
    ) ?? null;
  const wouldSkipOverlap = overlap.conflicts.length > 0 || claimV2Peer !== null;

  // write_guard is part of eligibility: "eligible_for_claim: YES" next to a
  // FAIL write-guard gate was a live contradiction (the claim would reject
  // what explain endorsed).
  const eligible =
    classification.ready &&
    classification.column === "todo" &&
    classification.board === "default" &&
    writeGuard.ok &&
    !wouldSkipOverlap &&
    fence.allowed;

  const gates = gatesFrom(
    classification,
    writeGuard,
    overlap,
    fence.allowed,
    fence.reason ?? "",
    prLiveness,
    claimV2Peer,
    card,
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
      verdict: overlapVerdict(overlap),
      unevaluated_peers: overlap.unevaluatedPeers,
      claim_v2_blocked_by: claimV2Peer?.slug ?? null,
    },
    situation: {
      allowed: fence.allowed,
      reason: fence.reason,
      details: fence.details,
    },
    eligible_for_claim: eligible,
    gates,
    pr_liveness: prLiveness,
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
  lines.push(
    `  pr_liveness: ${report.pr_liveness.state} venue=${report.pr_liveness.venue} action=${report.pr_liveness.action} — ${report.pr_liveness.note}`,
  );
  lines.push("  gates:");
  for (const g of report.gates) {
    const label = g.status === "unknown" ? "UNK " : g.ok ? "OK  " : "FAIL";
    lines.push(`    ${label} ${g.name} — ${g.note}`);
  }
  if (!report.write_guard.ok && report.write_guard.hint) {
    lines.push(`  write-guard hint: ${report.write_guard.hint}`);
  }
  if (report.suggestion) lines.push(`  suggestion: ${report.suggestion}`);
  if (report.blockedBy.length) {
    lines.push(`  blockedBy: ${report.blockedBy.join(", ")}`);
  }
  if (report.surface_overlap.would_skip) {
    const skipPeers = new Set(report.surface_overlap.conflicts.map((c) => c.slug));
    if (report.surface_overlap.claim_v2_blocked_by) {
      skipPeers.add(report.surface_overlap.claim_v2_blocked_by);
    }
    lines.push(`  surface-overlap skip: ${[...skipPeers].join(", ")}`);
  }
  return lines.join("\n");
}

export async function pickupExplainCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
  situationPreflight?: SituationPreflight;
  prLivenessProbe?: PrLivenessProbe;
}): Promise<string> {
  const report = await pickupExplainResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : renderPickupExplain(report);
}
