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

import type { NodeClient } from "./client.ts";
import type { Config } from "./config.ts";
import { findCard, normalizeCreatedBy, resolveCreatedBy, type Card } from "./record.ts";

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

/**
 * Does a keyed Card read reflect a claim that already succeeded?
 *
 * `pickup claim` writes the claim under a CAS on `column`, so a successful
 * write is settled. The keyed point read is a SEPARATE question: Mini acks off
 * resident state and the read path can still serve the pre-write record, so
 * `show` — which is nothing but that point read — can answer `todo` with a
 * blank assignee for a card the claim response, `list --column doing`, and the
 * durable record all agree is claimed
 * ([[papercut-fkanban-show-lags-pickup-claim-projection]], eight witnesses
 * between 2026-08-18 and 2026-08-20).
 *
 * The predicate is deliberately about the CLAIM, not about equality with the
 * written record: `updated_at` and `position` are ours to move and a peer may
 * legitimately edit an unrelated field between the write and the read. Column
 * and assignee are the two the claim asserts, so they are the two that decide.
 *
 * An expected assignee of `""` (no worker id available) asserts nothing about
 * ownership, so only the column is checked.
 */
export function cardReflectsClaim(
  read: { column?: string | null; assignee?: string | null },
  expect: { column: string; assignee?: string | null },
): boolean {
  if ((read.column ?? "") !== expect.column) return false;
  const wantAssignee = normalizeCreatedBy(expect.assignee ?? undefined);
  if (!wantAssignee) return true;
  return normalizeCreatedBy(read.assignee ?? undefined) === wantAssignee;
}

/**
 * The read-after-write budget for a claim, in milliseconds per attempt.
 *
 * Deliberately the same SHAPE as the search-visibility budget in
 * `board-cards.ts` — geometric backoff, first attempt free — but a much shorter
 * total. The two waits answer different questions: search visibility waits on
 * an INDEX to be rebuilt, while this waits on the read path to serve a record
 * that is already durable, and every witness in
 * [[papercut-fkanban-show-lags-pickup-claim-projection]] that resolved at all
 * resolved inside a second. A claim that has to wait longer than this is one
 * the caller should be TOLD about rather than one it should keep blocking on:
 * pickup's next act is a multi-minute build, so the warning reaches a log the
 * operator reads and the wait does not delay the work.
 */
const CLAIM_VISIBLE_BACKOFF_MS = [0, 25, 50, 100, 200, 300, 500];
const CLAIM_VISIBLE_ATTEMPTS = CLAIM_VISIBLE_BACKOFF_MS.length;

/** The claim read-after-write budget — exported so a test can pin the number. */
export const CLAIM_VISIBLE_BUDGET_MS = CLAIM_VISIBLE_BACKOFF_MS.reduce((a, b) => a + b, 0);

function claimDelay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What {@link awaitCardClaimVisible} learned about the keyed read. */
export type ClaimVisibility = {
  /** True once a keyed read reflected the claim within the budget. */
  reflects: boolean;
  /**
   * The last keyed read, or `null` when every read inside the budget failed or
   * the card could not be read back at all. NEVER a substitute for the written
   * record when `reflects` is false — a stale snapshot is what callers must not
   * build their next write from.
   */
  card: Card | null;
};

/**
 * Block until the keyed Card read reflects a claim that already succeeded.
 *
 * ## Why a successful write needs a wait at all
 *
 * `kanban show` is a keyed Card point read and nothing else. `pickup claim`
 * CAS-writes the claim and returns; between those two facts sits a window in
 * which the point read still answers with the pre-claim record. Measured on the
 * primary across eight runs (2026-08-18 → 2026-08-20,
 * [[papercut-fkanban-show-lags-pickup-claim-projection]]): `claimed=true,
 * from=todo, to=doing` followed immediately by `show` reporting `column=todo`
 * and a blank assignee, while `list --column doing` reported the claim
 * correctly. So the divergence is between two READS of the same durable write,
 * not between two writes.
 *
 * ## Why the caller is told rather than failed
 *
 * The write is settled — it passed a CAS on `column` — so throwing here would
 * turn a slow read into a lost claim, and rolling back would hand the card to a
 * second worker while the first is already isolating a worktree. A bounded wait
 * plus an explicit `reflects: false` lets the caller report the authoritative
 * claim and warn, which is what the papercut's witnesses needed and did not get.
 *
 * A read that THROWS is shed or busy — unknown, not a miss — and does not end
 * the wait early; it just costs an attempt like any other.
 *
 * @param sleep test seam. The budget is short but not free, and a test that
 *   exercises the exhausted path through the real timer pays it in wall clock.
 */
export async function awaitCardClaimVisible(
  node: NodeClient,
  cfg: Config,
  slug: string,
  expect: { column: string; assignee?: string | null },
  opts?: { sleep?: (ms: number) => Promise<void> },
): Promise<ClaimVisibility> {
  const sleep = opts?.sleep ?? claimDelay;
  let last: Card | null = null;
  for (let attempt = 0; attempt < CLAIM_VISIBLE_ATTEMPTS; attempt++) {
    const wait = CLAIM_VISIBLE_BACKOFF_MS[attempt];
    if (wait !== undefined && wait > 0) await sleep(wait);
    let card: Card | null;
    try {
      card = await findCard(node, cfg, slug);
    } catch {
      // Shed / busy / transient socket. Unknown, not a miss — keep the previous
      // read (if any) and spend the attempt.
      continue;
    }
    if (card) last = card;
    if (card && cardReflectsClaim(card, expect)) return { reflects: true, card };
  }
  return { reflects: false, card: last };
}

/**
 * What an operator is told when a claim is durable but the keyed read has not
 * caught up.
 *
 * Named and exported for the same reason as
 * `searchVisibilityTimeoutWarning`: the two call sites must not word it
 * differently, and a test should pin the sentence rather than a substring.
 * Silence here is the whole defect — every witness in the papercut is a run
 * that read `todo`, believed it, and either retried or wrote the stale row back.
 */
export function claimVisibilityTimeoutWarning(slug: string, column: string): string {
  return (
    `warning: "${slug}" was claimed into ${column} and the write is durable, but ` +
    `the keyed card read still reported the pre-claim state after ` +
    `${CLAIM_VISIBLE_BUDGET_MS}ms. \`show\` may lag until the read path catches ` +
    "up; do not treat that stale read as current state."
  );
}
