import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  firstEligible,
  pickupV2IneligibleReason,
  PICKUP_V2_ELIGIBILITY_FIELDS,
  type DependencyStatuses,
} from "../pickup_v2.ts";
import {
  claimHoldReason,
  findCard,
  findCardsWithFields,
  listCardsByColumn,
  listDependencyStatusesForCards,
  TERMINAL_COLUMN,
  type Card,
} from "../record.ts";
import { claimCard, ClaimConflictError, ClaimHeldError } from "./move.ts";
import {
  boardCardSk,
  boardCardsHash,
  enqueueBoardCardJanitor,
  sweepBoardCardJanitor,
} from "../board-cards.ts";
import { mapWithConcurrency, POINT_READ_CONCURRENCY } from "../concurrency.ts";

// `PICKUP_V2_ELIGIBILITY_FIELDS` is spread in, not retyped: the projection and
// the predicate that reads it must not drift. `test/pickup-v2-eligibility.test.ts`
// pins that every eligibility field is present here, because a hold this list
// forgets is a hold `firstEligible` cannot see.
export const TODO_FIELDS = [
  "slug",
  "column",
  "position",
  "created_at",
  "repo",
  "deps",
  "surfaces",
  ...PICKUP_V2_ELIGIBILITY_FIELDS,
] as const;

const DOING_FIELDS = [
  "slug",
  "column",
  // Needed to address a phantom doing row for deletion (see verifyDoingRows).
  "position",
  "repo",
  "surfaces",
] as const;

export type PickupClaimV2Options = {
  cfg: Config;
  node: NodeClient;
  worker?: string;
  dryRun?: boolean;
  board?: string;
  /** Claim only this exact card; a refusal never selects another card. */
  onlyCard?: string;
};

export type PickupClaimV2Result =
  | {
      result: "claimed";
      card: Card;
      from: "todo";
      to: "doing";
      worker: string;
      dry_run: boolean;
    }
  | {
      result: "none";
      dry_run: boolean;
      /** Candidates considered: todo range size, or one exact card key. */
      scanned: number;
      /** Why each scanned card was passed over (first 20, board order). */
      skipped: Array<{ slug: string; reason: string }>;
    };

export type PickupClaimV2Error = {
  result: "error";
  code: string;
};

export function pickupClaimV2Error(err: unknown): PickupClaimV2Error {
  return {
    result: "error",
    code: err instanceof FkanbanError ? err.code : "internal_error",
  };
}

export function pickupClaimV2Payload(
  result: PickupClaimV2Result | PickupClaimV2Error,
): PickupClaimV2Result | PickupClaimV2Error {
  return JSON.parse(JSON.stringify(result)) as PickupClaimV2Result | PickupClaimV2Error;
}

export function formatPickupClaimV2(
  result: PickupClaimV2Result | PickupClaimV2Error,
  json = false,
): string {
  if (json) return JSON.stringify(pickupClaimV2Payload(result), null, 2);
  if (result.result === "error") return `pickup error: ${result.code}`;
  if (result.result === "none") {
    if (result.skipped.length === 0) return `no claim (scanned=${result.scanned} todo card(s))`;
    return [
      `no claim (scanned=${result.scanned} todo card(s)); passed over:`,
      ...result.skipped.map((s) => `  ${s.slug}: ${s.reason}`),
    ].join("\n");
  }
  return `${result.dry_run ? "would claim" : "claimed"}: ${result.card.slug}`;
}

function dependencyStatuses(todo: readonly Card[], statuses: readonly Card[]): DependencyStatuses {
  const bySlug = new Map(statuses.map((card) => [card.slug, card]));
  const result: Record<string, boolean> = {};
  for (const slug of new Set(todo.flatMap((card) => card.deps))) {
    result[slug] = bySlug.get(slug)?.column === TERMINAL_COLUMN;
  }
  return result;
}

/** Keyed LastDB adapter for deterministic pickup v2. */
export async function pickupClaimV2Result(opts: PickupClaimV2Options): Promise<PickupClaimV2Result> {
  if (opts.onlyCard !== undefined) {
    const slug = opts.onlyCard.trim();
    if (!slug) {
      throw new FkanbanError({
        code: "invalid_only_card",
        message: "--only-card requires a non-empty card slug.",
      });
    }
    return pickupClaimV2OnlyCard(opts, slug);
  }
  const board = opts.board ?? "default";
  let todo = await listCardsByColumn(
    opts.node,
    opts.cfg,
    "todo",
    [...TODO_FIELDS],
    board,
    { projection: [...TODO_FIELDS] },
  );
  const doingRows = await listCardsByColumn(
    opts.node,
    opts.cfg,
    "doing",
    [...DOING_FIELDS],
    board,
    { projection: [...DOING_FIELDS] },
  );
  const doing = await verifyDoingRows(opts, board, doingRows);
  const knownStatuses = await listDependencyStatusesForCards(
    opts.node,
    opts.cfg,
    todo,
    [...todo, ...doing],
  );
  const statuses = dependencyStatuses(todo, knownStatuses);
  const liveDoing: Card[] = [...doing];
  const scanned = todo.length;
  const eligibilityOpts = { enforceLivePrMilestone: opts.cfg.enforceLivePrMilestone === true };
  /** Cards dropped at claim time (conflict or hold), with the reason. */
  const droppedAtClaim: Array<{ slug: string; reason: string }> = [];

  while (true) {
    const candidate = firstEligible(todo, liveDoing, statuses, eligibilityOpts);
    if (!candidate) {
      const skipped = [
        ...droppedAtClaim,
        ...todo.map((card) => ({
          slug: card.slug,
          reason: pickupV2IneligibleReason(card, liveDoing, statuses, eligibilityOpts) ?? "not selected",
        })),
      ].slice(0, 20);
      return { result: "none", dry_run: opts.dryRun === true, scanned, skipped };
    }

    if (opts.dryRun) {
      // Same last check the real claim runs in `claimCard`: the todo read is
      // body-free, so a body-only hold (a human gate, or merged code that only
      // awaits validation) is visible only on the point read. Without it the
      // dry-run said "claimed" for a card the real claim would drop.
      const full = await findCard(opts.node, opts.cfg, candidate.slug);
      const hold = full ? claimHoldReason(full) : null;
      if (hold) {
        droppedAtClaim.push({ slug: candidate.slug, reason: hold });
        todo = todo.filter((card) => card.slug !== candidate.slug);
        continue;
      }
      return {
        result: "claimed",
        card: candidate,
        from: "todo",
        to: "doing",
        worker: opts.worker?.trim() ?? "",
        dry_run: true,
      };
    }

    try {
      const claimed = await claimCard({
        cfg: opts.cfg,
        node: opts.node,
        slug: candidate.slug,
        worker: opts.worker ?? "",
      });
      return { ...claimed, dry_run: false };
    } catch (err) {
      if (err instanceof ClaimHeldError) {
        droppedAtClaim.push({ slug: candidate.slug, reason: err.holdReason });
        todo = todo.filter((card) => card.slug !== candidate.slug);
        continue;
      }
      if (!(err instanceof ClaimConflictError)) throw err;
      droppedAtClaim.push({ slug: candidate.slug, reason: `claim conflict (current=${err.current})` });
      // The claim point-read says the card left todo, so its todo row is stale.
      // Retire it now; otherwise every later pickup re-reads it, re-tries the
      // claim, and conflicts again until a heal runs.
      if (err.current !== "todo" && err.current !== "unknown") {
        await retireStaleRows(opts, board, [{ slug: candidate.slug, column: "todo", position: candidate.position }]);
      }
      todo = todo.filter((card) => card.slug !== candidate.slug);
      if (err.current === "doing" || err.current === "unknown") {
        liveDoing.push({ ...candidate, column: "doing" });
      }
    }
  }
}

/** Exact-card mode never repairs peers or falls back to the global todo range. */
async function pickupClaimV2OnlyCard(
  opts: PickupClaimV2Options,
  slug: string,
): Promise<PickupClaimV2Result> {
  const board = opts.board ?? "default";
  const none = (reason: string): PickupClaimV2Result => ({
    result: "none",
    dry_run: opts.dryRun === true,
    scanned: 1,
    skipped: [{ slug, reason }],
  });
  const [candidate, doingRows] = await Promise.all([
    findCard(opts.node, opts.cfg, slug),
    listCardsByColumn(opts.node, opts.cfg, "doing", [...DOING_FIELDS], board, {
      projection: [...DOING_FIELDS],
    }),
  ]);
  if (!candidate) return none("card not found");
  if (candidate.board !== board) return none(`not on board ${board} (board=${candidate.board})`);

  // Collect every peer/dependency key before one native multi-key read. Peer
  // verification is read-only; this narrow claim must not run the board janitor.
  const keys = [...new Set([...doingRows.map((row) => row.slug), ...candidate.deps])]
    .filter((key) => key !== candidate.slug);
  const cards = await findCardsWithFields(opts.node, opts.cfg, keys, [
    "slug", "board", "column", "repo", "surfaces",
  ]);
  const bySlug = new Map(cards.flatMap((card) => card ? [[card.slug, card] as const] : []));
  bySlug.set(candidate.slug, candidate);
  const doing = doingRows.flatMap((row) => {
    const truth = bySlug.get(row.slug);
    // Missing membership fields cannot prove that this peer left doing.
    if (!truth || !truth.column.trim() || !truth.board.trim()) return [row];
    if (truth.column !== "doing" || truth.board !== board) return [];
    // A missing repo cannot free the known repo's surfaces. Empty canonical
    // surfaces already reserve that complete repo through effectiveSurfaces.
    return [{ ...truth, repo: truth.repo.trim() ? truth.repo : row.repo }];
  });
  const statuses = dependencyStatuses([candidate], [...bySlug.values()]);
  const reason = pickupV2IneligibleReason(candidate, doing, statuses, {
    enforceLivePrMilestone: opts.cfg.enforceLivePrMilestone === true,
  }) ?? claimHoldReason(candidate);
  if (reason) return none(reason);
  if (opts.dryRun) {
    return {
      result: "claimed",
      card: candidate,
      from: "todo",
      to: "doing",
      worker: opts.worker?.trim() ?? "",
      dry_run: true,
    };
  }
  try {
    const claimed = await claimCard({
      cfg: opts.cfg, node: opts.node, slug, worker: opts.worker ?? "",
    });
    return { ...claimed, dry_run: false };
  } catch (err) {
    if (err instanceof ClaimHeldError) return none(err.holdReason);
    if (err instanceof ClaimConflictError) return none(`claim conflict (current=${err.current})`);
    throw err;
  }
}

/**
 * Keep only the doing rows whose Card point read still says `doing`.
 *
 * The doing partition is a second copy of each card's column, written by a
 * separate mutation after the Card write, and the two drift on a busy node
 * (papercut-kanban-live-todo-card-absent-from-pickup-partition-20260924). A
 * phantom doing row is not harmless: `firstEligible` treats it as live work,
 * so every todo card whose surfaces overlap it is skipped — a whole serial
 * chain on one surface stops behind a card that is already done.
 *
 * Doing is small (single digits on the live board), and a Card point read is
 * O(1) and read-your-write, so this costs a handful of point gets. A point read
 * that fails keeps its row: unproven is not phantom.
 */
async function verifyDoingRows(
  opts: PickupClaimV2Options,
  board: string,
  rows: Card[],
): Promise<Card[]> {
  const verdicts = await mapWithConcurrency(rows, async (row) => {
    try {
      const truth = await findCard(opts.node, opts.cfg, row.slug);
      return truth?.column === "doing" ? "live" : "phantom";
    } catch {
      return "live";
    }
  }, POINT_READ_CONCURRENCY);
  const phantoms = rows.filter((_, i) => verdicts[i] === "phantom");
  if (phantoms.length > 0) {
    await retireStaleRows(
      opts,
      board,
      phantoms.map((row) => ({ slug: row.slug, column: "doing", position: row.position })),
    );
  }
  return rows.filter((_, i) => verdicts[i] === "live");
}

/**
 * Delete board rows a point read proved stale. Best effort and never in a dry
 * run: the claim decision already excludes these rows, so a failed delete only
 * leaves the list wrong for longer (the janitor logs it), not the claim.
 *
 * Each row is re-checked by point read immediately before its delete. A card
 * can move back to the same address (`kanban move <slug> todo --position 0`
 * after a claim) between the first read and this one, and deleting its live
 * row would hide it from pickup — the worse of the two drift directions.
 */
async function retireStaleRows(
  opts: PickupClaimV2Options,
  board: string,
  rows: Array<{ slug: string; column: string; position: string }>,
): Promise<void> {
  const schemaHash = boardCardsHash(opts.cfg);
  if (opts.dryRun || !schemaHash) return;
  for (const row of rows) {
    if (!row.slug || !row.position) continue;
    try {
      const truth = await findCard(opts.node, opts.cfg, row.slug);
      if (truth && truth.column === row.column && truth.position === row.position) continue;
      enqueueBoardCardJanitor([{ schemaHash, board, sk: boardCardSk(row.column, row.position, row.slug) }]);
      await sweepBoardCardJanitor(opts.node);
    } catch {
      // Logged per row by the janitor; the claim result does not depend on it.
    }
  }
}
