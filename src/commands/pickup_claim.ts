// `kanban pickup claim` — atomic "give me the next ready card."
//
// Agents should not reimplement selection (list todo → overlap → move) in
// prompts. This command walks pickup-ready candidates in priority order,
// skips surface conflicts with in-flight doing/review work, and CAS-claims
// the first winner into `doing` (`move --from todo`). Concurrent workers
// racing the same slug get claim_conflict and continue to the next card.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  listBoards,
  listCards,
  nowIso,
  priorityOf,
  rankCards,
  requireCard,
  updateCardRecord,
  type Card,
} from "../record.ts";
import { buildPickupStatusReportWithSituations } from "../pickup.ts";
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
  skipped: PickupClaimSkip[];
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

function orderCandidates(readyCards: Card[], preferRepo: string[]): Card[] {
  const ranked = rankCards(readyCards);
  if (preferRepo.length === 0) return ranked;
  const prefer = new Set(preferRepo.map((r) => r.toLowerCase()));
  const preferred: Card[] = [];
  const rest: Card[] = [];
  for (const c of ranked) {
    const repo = claimedRepo(c).toLowerCase();
    if (prefer.has(repo)) preferred.push(c);
    else rest.push(c);
  }
  return [...preferred, ...rest];
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

  if (opts.maxDoing !== undefined) {
    const doingCount = cards.filter((c) => c.board === board && c.column === "doing").length;
    if (doingCount >= opts.maxDoing) {
      return {
        claimed: false,
        reason: "at-capacity",
        scanned_ready: 0,
        skipped: [{
          slug: "*",
          reason: "at-capacity",
          detail: `doing=${doingCount} max-doing=${opts.maxDoing}`,
        }],
        worker: opts.worker,
      };
    }
  }

  const report = await buildPickupStatusReportWithSituations(
    cards,
    boards,
    opts.situationPreflight,
  );

  const readyClassifications = report.cards.filter(
    (c) => c.ready && c.board === board && c.column === "todo",
  );
  const bySlug = new Map(cards.map((c) => [c.slug, c]));
  const readyCards: Card[] = [];
  for (const c of readyClassifications) {
    const full = bySlug.get(c.slug);
    if (full) readyCards.push(full);
  }

  const candidates = orderCandidates(readyCards, preferRepo);

  // Working copy of board state so we can mark a CAS conflict as no longer todo
  // without re-listing (and so overlap sees concurrent skips consistently).
  let liveCards = cards.slice();

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
        skipped,
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

      return {
        claimed: true,
        reason: "claimed",
        card: cardSummary(claimedCard, priorityOf(claimedCard)),
        from: moved.from,
        to: moved.to,
        worker: opts.worker,
        scanned_ready: readyCards.length,
        skipped,
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
    reason: readyCards.length === 0 ? "no-eligible" : "no-eligible",
    scanned_ready: readyCards.length,
    skipped,
    worker: opts.worker,
  };
}

export function formatPickupClaim(result: PickupClaimResult, json?: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  if (result.claimed && result.card) {
    const mode = result.reason === "dry-run" ? "would claim" : "claimed";
    const lines = [
      `${mode}: ${result.card.slug}`,
      `  repo: ${result.card.repo || "(none)"}  base: ${result.card.base || "(none)"}  priority: ${result.card.priority}`,
      `  title: ${result.card.title}`,
    ];
    if (result.worker) lines.push(`  worker: ${result.worker}`);
    if (result.skipped.length > 0) {
      lines.push(`  skipped ${result.skipped.length} earlier candidate(s):`);
      for (const s of result.skipped.slice(0, 12)) {
        lines.push(`    - ${s.slug}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
      }
    }
    return lines.join("\n");
  }

  const lines = [
    `no claim: ${result.reason}`,
    `  scanned_ready: ${result.scanned_ready}`,
  ];
  if (result.skipped.length > 0) {
    lines.push("  skipped:");
    for (const s of result.skipped.slice(0, 20)) {
      lines.push(`    - ${s.slug}: ${s.reason}${s.detail ? ` (${s.detail})` : ""}`);
    }
  }
  return lines.join("\n");
}

export async function pickupClaimCmd(opts: PickupClaimOptions): Promise<string> {
  const result = await pickupClaimResult(opts);
  return formatPickupClaim(result, opts.json);
}
