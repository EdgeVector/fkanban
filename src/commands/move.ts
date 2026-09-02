// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.
// Moving a card into its board's terminal column also opportunistically refills
// the default pickup queue: any default/backlog dependents that are now fully
// unblocked and pass the normal default/todo pickup policy are promoted to todo.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
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
  doneAtForColumnTransition,
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
import { assertSituationPreflightAllowed, type SituationPreflight } from "../situations.ts";
import { assertLifecycleMoveAllowed } from "../pipeline_status.ts";
import { planDoingClaim } from "../doing-claim.ts";

export type MoveOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  column: string;
  expectColumn?: string;
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
  slug: string;
  from: string;
  to: string;
  promotedDependents?: string[];
  /** Assignee after a claim stamp into doing (if any). */
  assignee?: string;
  claim?: "stamped" | "kept" | "unclaimed";
};

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

export type AtomicClaimResult = {
  result: "claimed";
  card: Card;
  from: "todo";
  to: "doing";
  worker: string;
};

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

  const updated: Card = {
    ...card,
    column: "doing",
    position: appendPosition(),
    assignee: worker,
    updated_at: nowIso(),
    done_at: "",
  };

  try {
    await updateCardRecord(
      { cfg: opts.cfg, node: opts.node },
      updated,
      { type: "value", field: "column", value: expectedColumn },
      card,
    );
  } catch (err) {
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

  await recordFeatureFlowMutation({
    cfg: opts.cfg,
    node: opts.node,
    previous: card,
    next: updated,
  });

  return {
    result: "claimed",
    card: updated,
    from: "todo",
    to: "doing",
    worker,
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
  assertDbLocatorMatchesCard(card, opts.dbLocator, "move");
  const board = await ensureBoardRecord(opts.node, opts.cfg, card.board);
  const columns = board.columns;
  ensureColumn(opts.column, columns);

  const from = card.column;
  if (opts.expectColumn !== undefined && from !== opts.expectColumn) {
    throw new ClaimConflictError({ slug: opts.slug, expected: opts.expectColumn, current: from });
  }
  const position = opts.position !== undefined ? String(opts.position) : appendPosition();
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
  };
  applyDbLocatorForWrite(updated, opts.dbLocator, "move");
  const rawBody = updated.body;
  await stampCardForWrite(opts.node, opts.cfg, updated, {
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
  const msSlug = (updated.milestone ?? "").trim();
  if (msSlug) {
    const ms = await findMilestone(opts.node, opts.cfg, msSlug);
    if (ms) milestoneState = ms.state;
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
    await updateCardRecord(
      opts,
      updated,
      opts.expectColumn !== undefined
        ? { type: "value", field: "column", value: opts.expectColumn }
        : undefined,
      card,
    );
  } catch (err) {
    if (err instanceof FkanbanError && err.code === "cas_conflict" && opts.expectColumn !== undefined) {
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
  };
}
