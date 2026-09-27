// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.
// Moving a card into its board's terminal column also opportunistically refills
// the default pickup queue: any default/backlog dependents that are now fully
// unblocked and pass the normal default/todo pickup policy are promoted to todo.

import { FkanbanError, type NodeClient, withDurableWrites } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import { recordFeatureFlowMutation } from "../flow-ledger.ts";
import {
  appendPosition,
  assertDefaultTodoWriteGuard,
  assertDepUnblocked,
  sanitizeDefaultTodoLaneMetadata,
  warnClearedTodoLaneMetadata,
  applyDbLocatorForWrite,
  assertDbLocatorMatchesCard,
  depStatus,
  claimHoldReason,
  doneAtForColumnTransition,
  firstDoingAtForColumnTransition,
  ensureBoardRecord,
  ensureColumn,
  findCard,
  findMilestone,
  listBoards,
  listCards,
  nowIso,
  requireCard,
  stampCardForWrite,
  terminalColumn,
  updateCardRecord,
  type Card,
} from "../record.ts";
import { purgeStaleBoardCardRows } from "../board-cards.ts";
import { assertSituationPreflightAllowed, type SituationPreflight } from "../situations.ts";
import { assertLifecycleMoveAllowed } from "../pipeline_status.ts";
import { planDoingClaim } from "../doing-claim.ts";
import { purgeOtherColumnRowsForSlug } from "../board-cards.ts";
import { activatePlannedMilestoneForDoing, type MilestoneActivationOutcome } from "../milestone_activation.ts";

export type MoveOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  column: string;
  expectColumn?: string;
  /** Atomic owner guard; column remains a point-read check. */
  expectAssignee?: string;
  position?: number;
  // Override the dependency soft-block when moving into a working column.
  force?: boolean;
  dbLocator?: string;
  situationPreflight?: SituationPreflight;
  /**
   * Claim stamp when moving into `doing`. Prefer `pickup claim --worker`.
   * Bare `move … doing` without assignee/env actor refuses unless
   * `allowUnclaimed` is set (see `planDoingClaim`).
   */
  assignee?: string;
  worker?: string;
  allowUnclaimed?: boolean;
  /** Test seam: override process.env for claim-actor resolution. */
  env?: Record<string, string | undefined>;
};

export type MoveResult = {
  membership_cleanup?: "deferred";
  slug: string;
  from: string;
  to: string;
  promotedDependents?: string[];
  /** Assignee after a claim stamp into doing (if any). */
  assignee?: string;
  claim?: "stamped" | "kept" | "unclaimed";
} & MilestoneActivationOutcome;

export class ClaimConflictError extends FkanbanError {
  readonly current: string;
  readonly expected: string;

  constructor(opts: { slug: string; expected: string; current: string }) {
    super({
      code: "claim_conflict",
      message: `claim_conflict: Card "${opts.slug}" is in "${opts.current}", expected "${opts.expected}".`,
    });
    this.current = opts.current;
    this.expected = opts.expected;
  }
}

/**
 * The card is in the expected column but carries a hold (block_status or a
 * body-declared human gate) that forbids an unattended claim.
 */
export class ClaimHeldError extends FkanbanError {
  readonly holdReason: string;

  constructor(opts: { slug: string; reason: string }) {
    super({
      code: "claim_held",
      message: `claim_held: Card "${opts.slug}" is held: ${opts.reason}.`,
    });
    this.holdReason = opts.reason;
  }
}

/**
 * The claim Card write landed, but a later claim side effect failed. The Card
 * carries a durable needs_human marker before this error reaches the caller.
 */
export class ClaimPostCommitError extends FkanbanError {
  constructor(opts: { slug: string; cause: unknown }) {
    super({
      code: "claim_post_commit_failed",
      message:
        `claim_post_commit_failed: Card "${opts.slug}" entered doing, but a later claim step failed. ` +
        "The card is marked needs_human for recovery.",
      cause: opts.cause,
    });
  }
}

/**
 * The claim Card write landed, but fkanban could not durably mark its later
 * failure after bounded recovery attempts. The caller must treat the card as
 * an orphan that needs direct inspection.
 */
export class ClaimPostCommitMarkerError extends FkanbanError {
  constructor(opts: { slug: string; cause: unknown }) {
    super({
      code: "claim_post_commit_marker_failed",
      message:
        `claim_post_commit_marker_failed: Card "${opts.slug}" entered doing, but fkanban could not mark ` +
        "the post-commit failure after 3 attempts. Inspect the card before recovery.",
      cause: opts.cause,
    });
  }
}

export type AtomicClaimResult = {
  result: "claimed";
  card: Card;
  from: "todo";
  to: "doing";
  worker: string;
} & MilestoneActivationOutcome;

function claimFailureReason(cause: unknown): string {
  if (cause instanceof FkanbanError) return `${cause.code}: ${cause.message}`;
  if (cause instanceof Error) return cause.message;
  return String(cause);
}

/**
 * Mark an already-claimed card without replaying the index work that may have
 * failed. The Card record is what `kanban show` reads, so this durable patch
 * makes an orphan visible even while a membership index needs repair.
 */
const CLAIM_FAILURE_MARK_ATTEMPTS = 3;

async function markClaimPostCommitFailure(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  worker: string;
  cause: unknown;
}): Promise<void> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= CLAIM_FAILURE_MARK_ATTEMPTS; attempt += 1) {
    try {
      const claimed = await findCard(opts.node, opts.cfg, opts.slug);
      if (!claimed || claimed.column !== "doing" || claimed.assignee !== opts.worker) {
        throw new FkanbanError({
          code: "claim_post_commit_marker_verification_failed",
          message: `Cannot verify that worker "${opts.worker}" still owns doing card "${opts.slug}".`,
        });
      }
      await withDurableWrites(opts.node).updateRecord({
        schemaHash: schemaHashFor("card", opts.cfg),
        keyHash: opts.slug,
        // The node evaluates this CAS field from the write payload. Carry the
        // expected owner so we never mark a card a later worker reclaimed.
        fields: {
          assignee: opts.worker,
          block_status: "needs_human",
          block_reason: `claim post-commit failure: ${claimFailureReason(opts.cause)}`,
          updated_at: nowIso(),
        },
        expected: { type: "value", field: "assignee", value: opts.worker },
      });
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw new ClaimPostCommitMarkerError({ slug: opts.slug, cause: lastError });
}

/**
 * Claim one admitted todo card without lifecycle policy or board repair.
 *
 * The Card point read supplies the complete record for the write. The CAS
 * condition and the assignee stamp share the same Card mutation.
 */
export async function claimCard(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  worker: string;
  expectedColumn?: "todo";
}): Promise<AtomicClaimResult> {
  const expectedColumn = opts.expectedColumn ?? "todo";
  const worker = opts.worker.trim();
  if (!worker) {
    throw new FkanbanError({
      code: "missing_worker",
      message: "Pickup claim requires a worker identity.",
    });
  }

  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  if (card.column !== expectedColumn) {
    throw new ClaimConflictError({
      slug: card.slug,
      expected: expectedColumn,
      current: card.column,
    });
  }
  const hold = claimHoldReason(card);
  if (hold) throw new ClaimHeldError({ slug: card.slug, reason: hold });

  const claimedAt = nowIso();
  const updated: Card = {
    ...card,
    column: "doing",
    position: appendPosition(),
    assignee: worker,
    updated_at: claimedAt,
    done_at: "",
    // KEEPS an earlier stamp. A claim is not proof of fresh work: pickup claims
    // a card back after every watch re-dispatch, and that is exactly the case
    // the stall clock must see through.
    first_doing_at: firstDoingAtForColumnTransition(card, "doing", claimedAt),
  };

  try {
    // Durable: the claim is the pickup lease (see withDurableWrites). The
    // point read above is the final authority check before this CAS write;
    // BoardCards may still show an old column after a move.
    await updateCardRecord(
      { cfg: opts.cfg, node: withDurableWrites(opts.node) },
      updated,
      { type: "value", field: "column", value: expectedColumn },
      card,
    );

  } catch (err) {
    // This CAS belongs to the claim write itself. Do not attempt an orphan
    // marker: another invocation can have won the same worker's claim first.
    if (err instanceof FkanbanError && err.code === "cas_conflict") {
      const cause = err.cause;
      const actual = typeof cause === "object" && cause !== null
        ? (cause as { actual?: unknown }).actual
        : undefined;
      throw new ClaimConflictError({
        slug: card.slug,
        expected: expectedColumn,
        current: typeof actual === "string" ? actual : "unknown",
      });
    }
    throw err;
  }

  try {
    await recordFeatureFlowMutation({
      cfg: opts.cfg,
      node: opts.node,
      previous: card,
      next: updated,
    });
    const claimBoard = await ensureBoardRecord(opts.node, opts.cfg, updated.board);
    await purgeOtherColumnRowsForSlug(
      opts.node,
      opts.cfg,
      updated.board,
      updated.slug,
      updated.column,
      claimBoard.columns,
    );
  } catch (err) {
    // A Card mutation can fail after it persists, for example while its
    // membership or flow-ledger side effects run. The durable claim write
    // completed above, so a retry of the owner-guarded marker is safe.
    await markClaimPostCommitFailure({ ...opts, worker, cause: err });
    throw new ClaimPostCommitError({ slug: card.slug, cause: err });
  }

  // The milestone follows its cards: a claim is the first sign of work, so a
  // `planned` milestone becomes `active` here. Best effort — never fails the claim.
  const activation = await activatePlannedMilestoneForDoing(opts, updated);

  return {
    result: "claimed",
    card: updated,
    from: "todo",
    to: "doing",
    worker,
    ...activation,
  };
}

function isExpectedPromotionSkip(err: unknown): boolean {
  return err instanceof FkanbanError &&
    (err.code === "default_todo_not_pickup_ready" ||
      err.code === "card_blocked" ||
      err.code === "live_pr_milestone_required" ||
      err.code === "live_pr_milestone_abandoned");
}

async function promoteUnblockedBacklogDependents(opts: {
  cfg: Config;
  node: NodeClient;
  dependency: Card;
}): Promise<string[]> {
  const dependencySlug = opts.dependency.slug;
  const boards = await listBoards(opts.node, opts.cfg);
  const cards = await listCards(opts.node, opts.cfg, { boards });
  const cardsWithMovedDependency = cards.map((c) => c.slug === dependencySlug ? opts.dependency : c);
  const candidates = cardsWithMovedDependency.filter((c) =>
    c.slug !== dependencySlug &&
    c.board === "default" &&
    c.column === "backlog" &&
    c.deps.includes(dependencySlug)
  );
  if (candidates.length === 0) return [];

  const defaultBoard = await ensureBoardRecord(opts.node, opts.cfg, "default");
  ensureColumn("todo", defaultBoard.columns);
  const promoted: string[] = [];

  for (const thin of candidates) {
    if (depStatus(thin, cardsWithMovedDependency).blocked) continue;

    // `candidates` come from the body-free board list, and everything below
    // this line needs the body: the pickup-readiness gate reads the brief, and
    // the write carries the whole record. Without this hydrate the gate saw an
    // empty body on EVERY dependent, threw `default_todo_not_pickup_ready`,
    // and `isExpectedPromotionSkip` swallowed it — so dependency
    // auto-promotion silently never fired on a board with BoardCards. One
    // point-read per unblocked dependent, not per card on the board.
    const candidate = await findCard(opts.node, opts.cfg, thin.slug);
    if (!candidate) continue;

    const updated: Card = {
      ...candidate,
      column: "todo",
      position: appendPosition(),
      updated_at: nowIso(),
    };
    const rawBody = updated.body;
    try {
      await stampCardForWrite(opts.node, opts.cfg, updated, {
        previousBody: candidate.body,
        warn: () => {},
      });
      let milestoneState = "";
      const msSlug = (updated.milestone ?? "").trim();
      if (msSlug) {
        const ms = await findMilestone(opts.node, opts.cfg, msSlug);
        if (ms) milestoneState = ms.state;
      }
      assertDefaultTodoWriteGuard(updated, false, rawBody, {
        milestoneState,
        enforceLivePrMilestone: opts.cfg.enforceLivePrMilestone === true,
      });
      await assertDepUnblocked(opts.node, opts.cfg, updated, false);
    } catch (err) {
      if (isExpectedPromotionSkip(err)) continue;
      throw err;
    }
    await updateCardRecord(opts, updated, undefined, candidate);
    promoted.push(updated.slug);

    const idx = cardsWithMovedDependency.findIndex((c) => c.slug === updated.slug);
    if (idx >= 0) cardsWithMovedDependency[idx] = updated;
  }

  return promoted;
}

export async function moveCmd(opts: MoveOptions): Promise<MoveResult> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  if (opts.expectAssignee !== undefined) {
    if (!opts.expectAssignee.trim() || opts.force ||
        !opts.expectColumn || !['backlog','doing'].includes(opts.expectColumn) ||
        !['backlog','doing'].includes(opts.column)) {
      throw new FkanbanError({code:'guarded_move_scope',message:'Guarded recovery requires a nonempty owner, --from backlog|doing, destination backlog|doing, and no --force.'});
    }
    if (card.assignee !== opts.expectAssignee) {
      throw new FkanbanError({ code: "owner_conflict", message: `Card "${opts.slug}" no longer has the expected assignee.` });
    }
    if (opts.worker !== undefined || opts.assignee !== undefined || opts.allowUnclaimed) {
      throw new FkanbanError({ code: "guarded_owner_change", message: "An owner-guarded move must preserve the current assignee; omit worker, assignee and allow-unclaimed." });
    }
  }
  assertDbLocatorMatchesCard(card, opts.dbLocator, "move");
  const board = await ensureBoardRecord(opts.node, opts.cfg, card.board);
  const columns = board.columns;
  ensureColumn(opts.column, columns);

  const from = card.column;
  if (opts.expectColumn !== undefined && from !== opts.expectColumn) {
    throw new ClaimConflictError({ slug: opts.slug, expected: opts.expectColumn, current: from });
  }
  const position = opts.position !== undefined ? String(opts.position)
    : opts.expectAssignee !== undefined && from === opts.column ? card.position : appendPosition();
  const now = nowIso();

  // Claim contract: entering `doing` without durable ownership is how sweeps
  // reopen a card under a second agent. Prefer `pickup claim --worker`.
  let claimMeta: { assignee?: string; claim?: "stamped" | "kept" | "unclaimed" } = {};
  let assigneeForWrite = card.assignee;
  if (opts.column === "doing" && from !== "doing") {
    const plan = planDoingClaim({
      currentAssignee: card.assignee,
      explicitActor: opts.worker ?? opts.assignee,
      allowUnclaimed: opts.allowUnclaimed === true,
      env: opts.env,
    });
    if (plan.kind === "refuse") {
      throw new FkanbanError({ code: "move_into_doing_requires_claim", message: plan.message });
    }
    if (plan.kind === "stamp") {
      assigneeForWrite = plan.assignee;
      claimMeta = { assignee: plan.assignee, claim: "stamped" };
    } else if (plan.assignee) {
      claimMeta = { assignee: plan.assignee, claim: "kept" };
    } else {
      claimMeta = { claim: "unclaimed" };
    }
  }

  const updated: Card = {
    ...card,
    column: opts.column,
    position,
    assignee: assigneeForWrite,
    updated_at: now,
    done_at: doneAtForColumnTransition(card, opts.column, columns, now),
    first_doing_at: firstDoingAtForColumnTransition(card, opts.column, now),
  };
  applyDbLocatorForWrite(updated, opts.dbLocator, "move");
  const rawBody = updated.body;
  await stampCardForWrite(opts.node, opts.cfg, updated, {
    previousBody: card.body,
    warn: !opts.force && updated.board === "default" && updated.column === "todo" ? () => {} : undefined,
  });
  // A requeue into default/todo drops in-flight metadata by design. Say which
  // fields went: the operator moving a card back is exactly who needs to know
  // the PR link no longer hangs off it, and `move` prints nothing else about it.
  warnClearedTodoLaneMetadata({
    slug: updated.slug,
    cleared: sanitizeDefaultTodoLaneMetadata(updated),
    previousPrUrl: card.pr_url,
  });
  let milestoneState = "";
  let milestoneFound = false;
  const msSlug = (updated.milestone ?? "").trim();
  if (msSlug) {
    const ms = await findMilestone(opts.node, opts.cfg, msSlug);
    if (ms) {
      milestoneState = ms.state;
      milestoneFound = true;
    }
  }
  assertDefaultTodoWriteGuard(updated, opts.force, rawBody, {
    milestoneState,
    enforceLivePrMilestone: opts.cfg.enforceLivePrMilestone === true,
  });
  await assertSituationPreflightAllowed(updated, opts.situationPreflight);
  await assertDepUnblocked(opts.node, opts.cfg, updated, opts.force);
  // Opt-in LastgitCiStatus gate: only cards with Requires-Status / Requires-Deploy
  // headers are checked when moving into the board's terminal column.
  await assertLifecycleMoveAllowed({
    node: opts.node,
    card: updated,
    targetColumn: opts.column,
    terminalColumn: terminalColumn(columns),
    force: opts.force,
  });
  try {
    // A worker claim into doing is the pickup lease: ask for a durable ack so
    // an unclean daemon stop cannot drop it (see withDurableWrites).
    const claimWrite = opts.worker !== undefined && opts.column === "doing";
    await updateCardRecord(
      claimWrite ? { ...opts, node: withDurableWrites(opts.node) } : opts,
      updated,
      opts.expectAssignee !== undefined
        ? { type: "value", field: "assignee", value: opts.expectAssignee }
        : opts.expectColumn !== undefined
        ? { type: "value", field: "column", value: opts.expectColumn }
        : undefined,
      card,
    );
  } catch (err) {
    if (err instanceof FkanbanError && err.code === "cas_conflict" && opts.expectColumn !== undefined && opts.expectAssignee === undefined) {
      const cause = err.cause;
      const actual = typeof cause === "object" && cause !== null
        ? (cause as { actual?: unknown }).actual
        : undefined;
      throw new ClaimConflictError({
        slug: opts.slug,
        expected: opts.expectColumn,
        current: typeof actual === "string" ? actual : "unknown",
      });
    }
    throw err;
  }
  // The milestone follows its cards: entering `doing` is the first sign of
  // work, so a `planned` milestone becomes `active`. After the card write and
  // best effort — a failure is a warning, never a failed move.
  const activation: MilestoneActivationOutcome =
    opts.column === "doing" && from !== "doing" && milestoneFound
      ? await activatePlannedMilestoneForDoing(opts, updated, milestoneState)
      : {};
  if (opts.expectAssignee !== undefined) {
    return { slug: card.slug, from, to: opts.column, ...claimMeta, ...activation, membership_cleanup: "deferred" };
  }
  // A move states where this card belongs, so it is also the repair for a card
  // that reads as belonging in two places at once.
  //
  // `updateCardRecord` retires only the row the CALLER knew about — the address
  // built from the Card point read it was handed. A drifted card has a row the
  // Card record cannot name (the 2026-09-05 `doing` lane held 9 such rows of
  // 13), so the documented repair `kanban move <slug> <truth-column> --force`
  // exited 0, printed `done -> done`, and left the phantom row first in the
  // listing. Agents reported a repair they had not made:
  // `papercut-kanban-move-to-truth-column-does-not-clear-the-stale-listing-row-20260905`.
  //
  // Only the partition knows every row a slug holds, so the repair has to ask
  // it. Best-effort: the card is already written and already correct, and a
  // failure here leaves exactly the duplicate that existed a moment ago.
  try {
    await purgeStaleBoardCardRows(opts.node, opts.cfg, updated);
  } catch (err) {
    // The move succeeded; a failed reap leaves exactly the duplicate that
    // existed a moment ago, so it must not fail the command. It must not be
    // SILENT either: an operator running this as the phantom-row repair needs
    // to know the repair half did not run.
    console.error(
      `kanban: move wrote ${updated.slug} but could not retire its stale membership rows: ` +
        `${err instanceof Error ? err.message : String(err)}. ` +
        `Re-run the move, or use \`kanban groom board-cards-heal\`.`,
    );
  }
  // AFTER the write, never before. A completion checkpoint is a durable, one-way
  // append into Brain that nothing in this codebase retracts, so ordering it
  // ahead of the write means a refused write — a `service_timeout` on a busy
  // node, or the CAS conflict the line above exists to catch — leaves Brain
  // permanently claiming a completion the board never made, down to a
  // "Candidate complete" line about the owning North Star.
  //
  // The reverse failure is bounded: this call never throws (it warns and skips
  // when Brain is unreachable), and a card that reached the terminal column
  // without a checkpoint is caught by the `delete-backstop` in `rm` / `board rm`
  // before it can leave the board. Those two sites keep the opposite order on
  // purpose — there the checkpoint MUST precede the delete.
  //
  // Pinned by `test/brain-checkpoint-write-ordering.test.ts`.
  await checkpointCardCompletion({
    cfg: opts.cfg,
    node: opts.node,
    card: updated,
    boardColumns: columns,
    reason: "done-transition",
  });
  await recordFeatureFlowMutation({
    cfg: opts.cfg,
    node: opts.node,
    previous: card,
    next: updated,
    terminalColumn: terminalColumn(columns),
  });
  // Previous-SK janitor only knows the tip SK. Leftover rows in other columns
  // (the live todo+doing dual-list bug) need prefix deletes on those columns.
  await purgeOtherColumnRowsForSlug(
    opts.node,
    opts.cfg,
    updated.board,
    updated.slug,
    updated.column,
    columns,
  );
  const promotedDependents =
    opts.column === terminalColumn(columns)
      ? await promoteUnblockedBacklogDependents({ cfg: opts.cfg, node: opts.node, dependency: updated })
      : [];
  return {
    slug: card.slug,
    from,
    to: opts.column,
    ...(promotedDependents.length > 0 ? { promotedDependents } : {}),
    ...claimMeta,
    ...activation,
  };
}
