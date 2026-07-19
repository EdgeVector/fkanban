// `kanban pickup claim` — atomic "give me the next ready card."
//
// Agents should not reimplement selection (list todo → overlap → move) in
// prompts. This command walks pickup-ready candidates in priority order,
// skips surface conflicts with in-flight doing work, and CAS-claims
// the first winner into `doing` (`move --from todo`). Concurrent workers
// racing the same slug get claim_conflict and continue to the next card.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config, schemaHashFor } from "../config.ts";
import {
  boardToFields,
  findBoard,
  listBoards,
  listCards,
  nowIso,
  priorityOf,
  requireCard,
  updateCardRecord,
  type Card,
} from "../record.ts";
import {
  buildPickupStatusReportWithSituations,
  PICKUP_CATEGORIES,
  selfHealGeneratedPickupBlocker,
  writeGroomedCard,
  type PickupCategory,
  type PickupClassification,
  type PickupStatusReport,
} from "../pickup.ts";
import {
  laneOf,
  orderCandidatesByLanes,
  parsePickupLaneState,
  recordLaneClaim,
  upsertPickupLaneStateInBody,
  type LaneId,
} from "../pickup_lanes.ts";
import { type SituationPreflight } from "../situations.ts";
import { ClaimConflictError, moveCmd } from "./move.ts";
import { claimedRepo, overlapAgainstCards } from "./overlap.ts";

export type PickupClaimOptions = {
  cfg: Config;
  node: NodeClient;
  /** Restrict candidates to this board (default: default). */
  board?: string;
  /** Optional worker id stamped onto `assignee` after a successful claim. */
  worker?: string;
  /** Prefer these repos first (still falls through to others). */
  preferRepo?: string[];
  /** Never claim cards for these repos. */
  excludeRepo?: string[];
  /** If `doing` count on the board is already ≥ this, refuse with at-capacity. */
  maxDoing?: number;
  /** Select the next card without moving it. */
  dryRun?: boolean;
  json?: boolean;
  situationPreflight?: SituationPreflight;
};

export type PickupClaimSkip = {
  slug: string;
  reason: string;
  detail?: string;
};

export type PickupClaimCardSummary = {
  slug: string;
  title: string;
  board: string;
  column: string;
  repo: string;
  base: string;
  kind: string;
  priority: string;
  /** Derived logical lane for fair-share pickup (p0-now / program:… / papercut / unlaned). */
  lane: string;
  body: string;
  tags: string[];
  deps: string[];
  surfaces: string[];
  north_star: string;
  branch: string;
  pr_url: string;
  assignee: string;
};

export type PickupClaimResult = {
  claimed: boolean;
  /** no-eligible | at-capacity | dry-run | claimed */
  reason: string;
  card?: PickupClaimCardSummary;
  from?: string;
  to?: string;
  worker?: string;
  scanned_ready: number;
  /** Count of cards currently in the target board's todo column. */
  todo_count: number;
  /** Count of non-ready cards still parked in the target board's todo column. */
  todo_blockers: number;
  skipped: PickupClaimSkip[];
  /** Sample of non-ready todo cards blocking pickup hygiene. */
  todo_blocker_exemplars?: PickupClaimDiagnosticExemplar[];
  diagnostics?: PickupClaimDiagnostics;
};

export type PickupClaimDiagnostics = {
  scanned_active: number;
  ready: number;
  counts: Record<PickupCategory, number>;
  /** Non-ready cards still parked in the target todo lane. */
  todo_blockers: number;
  inflight_without_artifact: number;
  exemplars?: PickupClaimDiagnosticExemplar[];
  todo_blocker_exemplars?: PickupClaimDiagnosticExemplar[];
  inflight_without_artifact_exemplars?: PickupClaimDiagnosticExemplar[];
};

export type PickupClaimDiagnosticExemplar = {
  slug: string;
  category: PickupCategory;
  reason: string;
  suggestion: string;
};

function normalizeRepoList(repos: string[] | undefined): string[] {
  if (!repos) return [];
  const out: string[] = [];
  for (const raw of repos) {
    for (const part of raw.split(",")) {
      const r = part.trim();
      if (r) out.push(r);
    }
  }
  return out;
}

function cardSummary(card: Card, priority: string): PickupClaimCardSummary {
  return {
    slug: card.slug,
    title: card.title,
    board: card.board,
    column: card.column,
    repo: claimedRepo(card),
    base: card.base || "",
    kind: card.kind || "pr",
    priority,
    lane: laneOf(card),
    body: card.body,
    tags: card.tags,
    deps: card.deps,
    surfaces: card.surfaces,
    north_star: card.north_star || "",
    branch: card.branch || "",
    pr_url: card.pr_url || "",
    assignee: card.assignee || "",
  };
}

async function persistLaneClaimState(opts: {
  cfg: Config;
  node: NodeClient;
  board: string;
  lane: LaneId;
  slug: string;
}): Promise<void> {
  // Best-effort: fair-share still works from live doing counts if this write
  // loses a race. Cursor/state is for diagnostics + finer round-robin.
  try {
    const boardRec = await findBoard(opts.node, opts.cfg, opts.board);
    if (!boardRec) return;
    const prev = parsePickupLaneState(boardRec.body);
    const next = recordLaneClaim(prev, opts.lane, opts.slug, nowIso());
    const body = upsertPickupLaneStateInBody(boardRec.body, next);
    if (body === boardRec.body) return;
    const updated = { ...boardRec, body, updated_at: nowIso() };
    await opts.node.updateRecord({
      schemaHash: schemaHashFor("board", opts.cfg),
      fields: boardToFields(updated),
      keyHash: updated.slug,
    });
  } catch {
    // ignore
  }
}

const DIAGNOSTIC_EXEMPLARS_PER_CATEGORY = 3;
const INFLIGHT_WITHOUT_ARTIFACT_EXEMPLARS = 3;
const TODO_BLOCKER_EXEMPLARS = 8;

function diagnosticExemplar(card: PickupClassification): PickupClaimDiagnosticExemplar {
  return {
    slug: card.slug,
    category: card.category,
    reason: card.reason,
    suggestion: card.suggestion,
  };
}

function claimDiagnostics(report: PickupStatusReport, cards: Card[], board: string): PickupClaimDiagnostics {
  const exemplars: PickupClaimDiagnosticExemplar[] = [];
  for (const category of PICKUP_CATEGORIES) {
    if (category === "pickup-ready") continue;
    exemplars.push(
      ...report.cards
        .filter((card) => card.category === category)
        .slice(0, DIAGNOSTIC_EXEMPLARS_PER_CATEGORY)
        .map(diagnosticExemplar),
    );
  }
  const todoBlockers = report.cards.filter(
    (classification) =>
      classification.board === board &&
      classification.column === "todo" &&
      !classification.ready,
  );
  const bySlug = new Map(cards.map((card) => [card.slug, card]));
  const inflightWithoutArtifact = report.cards.filter((classification) => {
    if (classification.category !== "collision" || classification.column !== "doing") return false;
    const card = bySlug.get(classification.slug);
    return card !== undefined && !card.pr_url && !card.branch;
  });
  return {
    scanned_active: report.scanned,
    ready: report.ready,
    counts: report.counts,
    todo_blockers: todoBlockers.length,
    inflight_without_artifact: inflightWithoutArtifact.length,
    ...(exemplars.length > 0 ? { exemplars } : {}),
    ...(todoBlockers.length > 0
      ? {
          todo_blocker_exemplars: todoBlockers
            .slice(0, TODO_BLOCKER_EXEMPLARS)
            .map(diagnosticExemplar),
        }
      : {}),
    ...(inflightWithoutArtifact.length > 0
      ? {
          inflight_without_artifact_exemplars: inflightWithoutArtifact
            .slice(0, INFLIGHT_WITHOUT_ARTIFACT_EXEMPLARS)
            .map(diagnosticExemplar),
        }
      : {}),
  };
}

function todoBlockerFields(diagnostics: PickupClaimDiagnostics): Pick<PickupClaimResult, "todo_blockers" | "todo_blocker_exemplars"> {
  return {
    todo_blockers: diagnostics.todo_blockers,
    ...(diagnostics.todo_blocker_exemplars?.length
      ? { todo_blocker_exemplars: diagnostics.todo_blocker_exemplars }
      : {}),
  };
}

async function selfHealTargetTodoGeneratedBlockers(opts: {
  cfg: Config;
  node: NodeClient;
  cards: Card[];
  board: string;
  dryRun?: boolean;
}): Promise<Card[]> {
  let nextCards = opts.cards;
  for (const card of opts.cards) {
    if (card.board !== opts.board || card.column !== "todo") continue;
    const healed = selfHealGeneratedPickupBlocker(card, nextCards);
    if (!healed.changed || !healed.issues.some((issue) => issue.applyable)) continue;
    nextCards = nextCards.map((c) => c.slug === card.slug ? healed.card : c);
    if (!opts.dryRun) {
      await writeGroomedCard({ cfg: opts.cfg, node: opts.node }, healed.card);
    }
  }
  return nextCards;
}

export async function pickupClaimResult(opts: PickupClaimOptions): Promise<PickupClaimResult> {
  const board = opts.board ?? "default";
  const preferRepo = normalizeRepoList(opts.preferRepo);
  const excludeRepo = new Set(normalizeRepoList(opts.excludeRepo).map((r) => r.toLowerCase()));
  const skipped: PickupClaimSkip[] = [];

  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const cardsForSelection = await selfHealTargetTodoGeneratedBlockers({
    cfg: opts.cfg,
    node: opts.node,
    cards,
    board,
    dryRun: opts.dryRun,
  });
  const todoCount = cardsForSelection.filter((c) => c.board === board && c.column === "todo").length;

  if (opts.maxDoing !== undefined) {
    const doingCount = cardsForSelection.filter((c) => c.board === board && c.column === "doing").length;
    if (doingCount >= opts.maxDoing) {
      const report = await buildPickupStatusReportWithSituations(cardsForSelection, boards, opts.situationPreflight, {
        cfg: opts.cfg,
        node: opts.node,
      });
      const diagnostics = claimDiagnostics(report, cardsForSelection, board);
      return {
        claimed: false,
        reason: "at-capacity",
        scanned_ready: 0,
        todo_count: todoCount,
        ...todoBlockerFields(diagnostics),
        skipped: [{
          slug: "*",
          reason: "at-capacity",
          detail: `doing=${doingCount} max-doing=${opts.maxDoing}`,
        }],
        worker: opts.worker,
        diagnostics,
      };
    }
  }

  const report = await buildPickupStatusReportWithSituations(
    cardsForSelection,
    boards,
    opts.situationPreflight,
    { cfg: opts.cfg, node: opts.node },
  );
  const diagnostics = claimDiagnostics(report, cardsForSelection, board);
  const claimDiagnosticsIfActionable = diagnostics.todo_blockers > 0 ? diagnostics : undefined;

  const readyClassifications = report.cards.filter(
    (c) => c.ready && c.board === board && c.column === "todo",
  );
  const bySlug = new Map(cardsForSelection.map((c) => [c.slug, c]));
  const readyCards: Card[] = [];
  for (const c of readyClassifications) {
    const full = bySlug.get(c.slug);
    if (full) readyCards.push(full);
  }

  const boardRec = boards.find((b) => b.slug === board);
  const laneState = parsePickupLaneState(boardRec?.body ?? "");
  const candidates = orderCandidatesByLanes(
    readyCards,
    cardsForSelection,
    laneState,
    board,
    preferRepo,
  );

  // Working copy of board state so we can mark a CAS conflict as no longer todo
  // without re-listing (and so overlap sees concurrent skips consistently).
  let liveCards = cardsForSelection.slice();

  for (const candidate of candidates) {
    const repo = claimedRepo(candidate);
    if (excludeRepo.has(repo.toLowerCase())) {
      skipped.push({ slug: candidate.slug, reason: "exclude-repo", detail: repo });
      continue;
    }

    const overlap = overlapAgainstCards(candidate, liveCards);
    if (overlap.conflicts.length > 0) {
      const peers = overlap.conflicts.map((c) => c.slug).join(",");
      skipped.push({
        slug: candidate.slug,
        reason: "surface-overlap",
        detail: peers,
      });
      continue;
    }

    if (opts.dryRun) {
      return {
        claimed: true,
        reason: "dry-run",
        card: cardSummary(candidate, priorityOf(candidate)),
        from: "todo",
        to: "doing",
        worker: opts.worker,
        scanned_ready: readyCards.length,
        todo_count: todoCount,
        ...todoBlockerFields(diagnostics),
        skipped,
        ...(claimDiagnosticsIfActionable ? { diagnostics: claimDiagnosticsIfActionable } : {}),
      };
    }

    try {
      const moved = await moveCmd({
        cfg: opts.cfg,
        node: opts.node,
        slug: candidate.slug,
        column: "doing",
        expectColumn: "todo",
        situationPreflight: opts.situationPreflight,
      });

      let claimedCard = await requireCard(opts.node, opts.cfg, candidate.slug);
      if (opts.worker && opts.worker.trim()) {
        const stamped: Card = {
          ...claimedCard,
          assignee: opts.worker.trim(),
          updated_at: nowIso(),
        };
        await updateCardRecord({ cfg: opts.cfg, node: opts.node }, stamped);
        claimedCard = stamped;
      }

      const lane = laneOf(claimedCard);
      await persistLaneClaimState({
        cfg: opts.cfg,
        node: opts.node,
        board,
        lane,
        slug: claimedCard.slug,
      });

      return {
        claimed: true,
        reason: "claimed",
        card: cardSummary(claimedCard, priorityOf(claimedCard)),
        from: moved.from,
        to: moved.to,
        worker: opts.worker,
        scanned_ready: readyCards.length,
        todo_count: todoCount,
        ...todoBlockerFields(diagnostics),
        skipped,
        ...(claimDiagnosticsIfActionable ? { diagnostics: claimDiagnosticsIfActionable } : {}),
      };
    } catch (err) {
      if (err instanceof ClaimConflictError) {
        skipped.push({
          slug: candidate.slug,
          reason: "claim_conflict",
          detail: `current=${err.current}`,
        });
        // Reflect the race in local state so later candidates' overlap is accurate.
        liveCards = liveCards.map((c) =>
          c.slug === candidate.slug ? { ...c, column: err.current === "unknown" ? "doing" : err.current } : c
        );
        continue;
      }
      if (err instanceof FkanbanError && (
        err.code === "card_blocked" ||
        err.code === "default_todo_not_pickup_ready" ||
        err.code === "situation_blocked"
      )) {
        skipped.push({
          slug: candidate.slug,
          reason: err.code,
          detail: err.message,
        });
        continue;
      }
      throw err;
    }
  }

  return {
    claimed: false,
    reason: "no-eligible",
    scanned_ready: readyCards.length,
    todo_count: todoCount,
    skipped,
    worker: opts.worker,
    diagnostics,
    ...todoBlockerFields(diagnostics),
  };
}

function formatDiagnosticExemplar(exemplar: PickupClaimDiagnosticExemplar): string {
  return `${exemplar.slug}: ${exemplar.category} - ${exemplar.reason}; ${exemplar.suggestion}`;
}

function appendTodoBlockerDiagnostics(lines: string[], diagnostics: PickupClaimDiagnostics): void {
  if (diagnostics.todo_blockers <= 0 || !diagnostics.todo_blocker_exemplars?.length) return;
  lines.push(`  todo blockers: ${diagnostics.todo_blockers}`);
  for (const exemplar of diagnostics.todo_blocker_exemplars.slice(0, TODO_BLOCKER_EXEMPLARS)) {
    lines.push(`    - ${formatDiagnosticExemplar(exemplar)}`);
  }
}

export function formatPickupClaim(result: PickupClaimResult, json?: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  if (result.claimed && result.card) {
    const mode = result.reason === "dry-run" ? "would claim" : "claimed";
    const lines = [
      `${mode}: ${result.card.slug}`,
      `  repo: ${result.card.repo || "(none)"}  base: ${result.card.base || "(none)"}  priority: ${result.card.priority}  lane: ${result.card.lane}`,
      `  title: ${result.card.title}`,
    ];
    if (result.worker) lines.push(`  worker: ${result.worker}`);
    if (result.skipped.length > 0) {
      lines.push(`  skipped ${result.skipped.length} earlier candidate(s):`);
      for (const s of result.skipped.slice(0, 12)) {
        lines.push(`    - ${s.slug}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
      }
    }
    if (result.diagnostics) appendTodoBlockerDiagnostics(lines, result.diagnostics);
    return lines.join("\n");
  }

  const lines = [
    `no claim: ${result.reason}`,
    `  scanned_ready: ${result.scanned_ready}`,
    `  todo_count: ${result.todo_count}`,
  ];
  if (result.skipped.length > 0) {
    lines.push("  skipped:");
    for (const s of result.skipped.slice(0, 20)) {
      lines.push(`    - ${s.slug}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
    }
  }
  if (result.diagnostics) appendTodoBlockerDiagnostics(lines, result.diagnostics);
  return lines.join("\n");
}

export async function pickupClaimCmd(opts: PickupClaimOptions): Promise<string> {
  const result = await pickupClaimResult(opts);
  return formatPickupClaim(result, opts.json);
}
