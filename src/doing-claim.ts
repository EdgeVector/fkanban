/**
 * Durable claim into `doing`.
 *
 * THE BUG. `kanban move <slug> doing` historically changed column only — no
 * assignee, no branch. Board closeout/groom treat empty doing + no PR after
 * grace as a zombie and bounce the card to todo while a human/agent is mid-
 * work (or while a PR is open but unstamped). Pickup then claims the same
 * slug and opens a competing PR. Recorded as
 * `papercut-kanban-move-claim-must-stamp-assignee` (member:
 * `papercut-kanban-move-alone-claims-a-card-that-still-looks-like-a-zombie`).
 *
 * CONTRACT. Moving into a board's working column (`doing` on default boards)
 * is a CLAIM: stamp an assignee (explicit flag, or actor from env). Bare
 * unclaimed doing requires an explicit escape hatch. Sweeps should not treat
 * a card with assignee set as an empty zombie solely for missing pr_url during
 * the soft grace window — see `shouldSoftReclaimUnclaimedDoing`.
 *
 * Pure helpers stay offline-testable so CI can pin the compound without a node.
 */

import { normalizeCreatedBy, resolveCreatedBy } from "./record.ts";

/** Resolve who owns a claim into doing. Prefer explicit worker/assignee. */
export function resolveClaimActor(
  explicit?: string | null,
  env: Record<string, string | undefined> = process.env,
): string {
  const direct = normalizeCreatedBy(explicit ?? undefined);
  if (direct) return direct;
  // Same provenance chain as create-time created_by, but never invent "unknown"
  // as a durable claim — empty means "no actor available."
  const fromEnv = resolveCreatedBy(undefined, env);
  return fromEnv === "unknown" ? "" : fromEnv;
}

export type DoingClaimPlan =
  | { kind: "keep"; assignee: string }
  | { kind: "stamp"; assignee: string }
  | { kind: "refuse"; message: string };

/**
 * Decide how a move into `doing` should treat assignee.
 *
 * - already assigned → keep (still a durable claim)
 * - explicit / env actor → stamp
 * - allowUnclaimed → leave empty (operator opt-out)
 * - else refuse silent unclaimed doing
 */
export function planDoingClaim(input: {
  currentAssignee?: string | null;
  explicitActor?: string | null;
  allowUnclaimed?: boolean;
  env?: Record<string, string | undefined>;
}): DoingClaimPlan {
  const current = normalizeCreatedBy(input.currentAssignee ?? undefined);
  if (current) return { kind: "keep", assignee: current };

  const actor = resolveClaimActor(input.explicitActor, input.env ?? process.env);
  if (actor) return { kind: "stamp", assignee: actor };

  if (input.allowUnclaimed) return { kind: "keep", assignee: "" };

  return {
    kind: "refuse",
    message:
      "move_into_doing_requires_claim: bare `move … doing` is not a claim. " +
      "Pass --assignee <id> / --worker <id>, set LASTGIT_ACTOR or AUTOMATION_ID " +
      "(with DRIVEN_BY=routine), or use `pickup claim --worker <id>`. " +
      "To force an unclaimed doing column (not recommended), pass --allow-unclaimed.",
  };
}

/**
 * Soft zombie reclaim predicate for empty-PR doing cards (board closeout /
 * groom). Pure so compound tests can pin it without spawning the sweep binary.
 *
 * A durable claim (non-empty assignee) is NOT reclaimed solely for missing
 * pr_url while still inside the grace window. After grace, other signals
 * (live worker, WIP commits) still protect real work; unclaimed empty doing
 * remains reclaimable once grace expires.
 */
export function shouldSoftReclaimUnclaimedDoing(input: {
  assignee?: string | null;
  ageMs: number;
  graceMs: number;
  hasPr: boolean;
  hasLiveWorker: boolean;
  hasBranchCommits: boolean;
  skipZombie?: boolean;
}): boolean {
  if (input.skipZombie) return false;
  if (input.hasPr) return false;
  if (input.ageMs < input.graceMs) return false;
  if (input.hasLiveWorker) return false;
  // WIP commits after grace: reclaim path still rolls back (separate flag), but
  // that is not "unclaimed empty" — callers decide. This predicate answers only
  // the empty-zombie case (no PR, no worker, no commits).
  if (input.hasBranchCommits) return false;

  const assignee = normalizeCreatedBy(input.assignee ?? undefined);
  // Durable claim: do not treat as empty zombie solely for missing pr_url.
  // Soft grace already elapsed, but assignee proves someone owns the column.
  // Abandoned claims are cleared by the agent/watch path (or human), not by
  // pretending the card was never claimed.
  if (assignee) return false;

  return true;
}
