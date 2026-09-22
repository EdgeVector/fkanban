import {
  assertLivePrMilestone,
  normalizeBlockStatus,
  normalizeKind,
} from "./record.ts";

export type PickupV2Card = {
  slug: string;
  column: string;
  position: string;
  created_at: string;
  repo: string;
  deps: string[];
  surfaces: string[];
  /**
   * Eligibility fields. Optional on the TYPE so existing fixtures and callers
   * still compile, but NOT optional in practice: `PICKUP_V2_ELIGIBILITY_FIELDS`
   * lists them and `pickup_claim_v2` must project every one. A field left
   * `undefined` is treated as "not read", which is why the projection is pinned
   * by a test — an unprojected hold is exactly the bug this pair prevents.
   */
  board?: string;
  kind?: string;
  block_status?: string;
  milestone?: string;
};

/**
 * The card fields {@link pickupV2HoldReason} reads. Any keyed list that feeds
 * {@link firstEligible} has to project all of them.
 *
 * WHY THIS CONSTANT EXISTS (2026-09-07): `pickup claim-v2 --dry-run` returned
 * `result=claimed` for `fold-aws-ci-fallback-20260906`, a card carrying
 * `block_status=deferred`, while `pickup status` counted it parked and
 * `pickup explain` said `eligible_for_claim: NO` with two failing gates. The
 * selection code was not wrong about the card it saw — the todo projection
 * simply never fetched `block_status`, so the hold could not be seen and came
 * back `""` in the claim envelope too. The routine-local ready gate derives
 * readiness from that dry-run, so six pickup lanes were dispatched at work the
 * board itself forbids in `default/todo`.
 * Papercut: papercut-pickup-gate-dry-run-accepts-unattached-outcome-20260906.
 */
export const PICKUP_V2_ELIGIBILITY_FIELDS = [
  "board",
  "kind",
  "block_status",
  "milestone",
] as const;

export const HUMAN_BOARD_SLUG = "human";

/**
 * Field-local mirror of the `classifyPickupCard` rules that keep a card out of
 * the pickup lane, in the same order that classifier applies them.
 *
 * Deliberately field-local: every rule reads only fields already on the
 * candidate, so this adds ZERO node reads. `claim-v2` exists because
 * `pickup status` measured 86.8s against 2.74s for the keyed dry-run; a fix
 * that re-ran the full classifier would hand back the cost the cheap path was
 * built to avoid.
 *
 * Returns a human-readable reason, or `null` when nothing holds the card.
 * A field that was not projected (`undefined`) cannot hold the card — see
 * {@link PICKUP_V2_ELIGIBILITY_FIELDS}.
 */
export type PickupV2EligibilityOpts = {
  /**
   * Mirror of `cfg.enforceLivePrMilestone`, the same flag `classifyPickupCard`
   * reads as `requireLiveMilestone` and `move`/`add` pass to the write guard.
   * The unattached-outcome rule is POLICY, not a defect in the card, so it must
   * be enforced here exactly when the rest of the CLI enforces it. Hardcoding
   * it would swap one status/claim disagreement for its mirror image.
   */
  enforceLivePrMilestone?: boolean;
};

export function pickupV2HoldReason(
  card: PickupV2Card,
  opts?: PickupV2EligibilityOpts,
): string | null {
  if (card.board !== undefined && card.board === HUMAN_BOARD_SLUG) {
    return "card is parked on the human board";
  }

  if (card.block_status !== undefined) {
    const blockStatus = normalizeBlockStatus(card.block_status);
    if (blockStatus === "needs_human" || blockStatus === "design_first") {
      return `intentional hold: ${blockStatus}`;
    }
    if (blockStatus === "deferred") return "deferred hold";
  }

  if (card.kind !== undefined) {
    const kind = normalizeKind(card.kind);
    if (kind !== "pr") return `non-pickup kind: ${kind}`;
  }

  // Unattached outcome. `livePrMilestoneGate` is pure and field-local (slug,
  // kind, column, milestone), so asking it here costs nothing and keeps one
  // implementation of the rule. Pass no milestone state: without the milestone
  // map only the "no milestone at all" arm can fire, which is the arm that
  // matches this gate on an unhydrated projection. `classifyPickupCard` makes
  // the identical call when its milestone map is absent.
  if (
    opts?.enforceLivePrMilestone === true &&
    card.kind !== undefined &&
    card.milestone !== undefined
  ) {
    try {
      assertLivePrMilestone(
        {
          slug: card.slug,
          kind: card.kind,
          column: card.column,
          milestone: card.milestone,
        },
        false,
        { milestoneState: "", enforce: true },
      );
    } catch (err) {
      return err instanceof Error ? err.message : "unattached outcome";
    }
  }

  return null;
}

export type DependencyStatuses = Readonly<Record<string, boolean>>;

function normalizeSurface(surface: string): string {
  return surface.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Missing surfaces reserve the complete repository. */
export function effectiveSurfaces(card: Pick<PickupV2Card, "surfaces">): string[] {
  const surfaces: string[] = [];
  const seen = new Set<string>();
  for (const raw of card.surfaces) {
    const surface = normalizeSurface(raw);
    if (!surface || seen.has(surface)) continue;
    seen.add(surface);
    surfaces.push(surface);
  }
  return surfaces.length > 0 ? surfaces : ["**"];
}

function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[]/);
  if (wildcard < 0) return pattern;
  const raw = pattern.slice(0, wildcard);
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(0, slash + 1) : raw;
}

function bareSubsystemMatches(bare: string, other: string): boolean {
  if (!bare || bare.includes("/") || /[*?[]/.test(bare)) return false;
  if (other === bare || other.startsWith(`${bare}/`) || other.includes(`/${bare}/`)) return true;
  return other.split("/").some((segment) =>
    segment === bare || segment.replace(/\.[^.]+$/, "") === bare
  );
}

function patternsMayOverlap(left: string, right: string): boolean {
  if (left === right || left === "**" || right === "**") return true;
  if (bareSubsystemMatches(left, right) || bareSubsystemMatches(right, left)) return true;

  const leftPrefix = literalPrefix(left);
  const rightPrefix = literalPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/** Compare effective surfaces only when both cards name the same repository. */
export function surfacesOverlap(
  candidate: Pick<PickupV2Card, "repo" | "surfaces">,
  doing: Pick<PickupV2Card, "repo" | "surfaces">,
): boolean {
  const candidateRepo = candidate.repo.trim();
  const doingRepo = doing.repo.trim();
  if (!candidateRepo || candidateRepo !== doingRepo) return false;

  return effectiveSurfaces(candidate).some((left) =>
    effectiveSurfaces(doing).some((right) => patternsMayOverlap(left, right))
  );
}

function compareUnsignedIntegerStrings(left: string, right: string): number | null {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  return a.length - b.length || a.localeCompare(b);
}

export function comparePickupV2Cards(left: PickupV2Card, right: PickupV2Card): number {
  const leftPosition = left.position.trim() || "0";
  const rightPosition = right.position.trim() || "0";
  const integerOrder = compareUnsignedIntegerStrings(leftPosition, rightPosition);
  const positionOrder = integerOrder ?? Number(leftPosition) - Number(rightPosition);
  if (Number.isFinite(positionOrder) && positionOrder !== 0) return positionOrder;
  return left.created_at.localeCompare(right.created_at) || left.slug.localeCompare(right.slug);
}

/**
 * Why one todo card is not claimable under v2, or null when it is. The same
 * predicate {@link firstEligible} applies, in the same order, so a `none`
 * result can name the reason for every card it passed over
 * (papercut-kanban-pickup-claim-v2-ready-none-20260921).
 */
export function pickupV2IneligibleReason(
  candidate: PickupV2Card,
  doing: readonly PickupV2Card[],
  dependencyStatuses: DependencyStatuses,
  opts?: PickupV2EligibilityOpts,
): string | null {
  if (candidate.column !== "todo") return `not in todo (column=${candidate.column})`;
  if (candidate.repo.trim().length === 0) return "no structured repo";
  // A stored hold outranks board order. Without this the first card in the
  // range wins even when the board forbids it in `default/todo`, and an
  // ineligible card at the top also hides every ready card behind it.
  const hold = pickupV2HoldReason(candidate, opts);
  if (hold !== null) return hold;
  const openDeps = candidate.deps.filter((slug) => dependencyStatuses[slug] !== true);
  if (openDeps.length > 0) return `unfinished deps: ${openDeps.join(",")}`;
  const peer = doing.find((p) => p.column === "doing" && surfacesOverlap(candidate, p));
  if (peer) return `surface overlap with doing card ${peer.slug}`;
  return null;
}

/** Return the first eligible todo card in stable board order. */
export function firstEligible<T extends PickupV2Card>(
  todo: readonly T[],
  doing: readonly PickupV2Card[],
  dependencyStatuses: DependencyStatuses,
  opts?: PickupV2EligibilityOpts,
): T | undefined {
  const ordered = [...todo].sort(comparePickupV2Cards);
  return ordered.find((candidate) =>
    pickupV2IneligibleReason(candidate, doing, dependencyStatuses, opts) === null
  );
}
