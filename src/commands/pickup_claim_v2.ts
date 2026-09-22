import { FkanbanError, type NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  firstEligible,
  pickupV2IneligibleReason,
  PICKUP_V2_ELIGIBILITY_FIELDS,
  type DependencyStatuses,
} from "../pickup_v2.ts";
import {
  listCardsByColumn,
  listDependencyStatusesForCards,
  TERMINAL_COLUMN,
  type Card,
} from "../record.ts";
import { claimCard, ClaimConflictError, ClaimHeldError } from "./move.ts";

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
  "repo",
  "surfaces",
] as const;

export type PickupClaimV2Options = {
  cfg: Config;
  node: NodeClient;
  worker?: string;
  dryRun?: boolean;
  board?: string;
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
      /** Todo cards scanned on the board. */
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
  const board = opts.board ?? "default";
  let todo = await listCardsByColumn(
    opts.node,
    opts.cfg,
    "todo",
    [...TODO_FIELDS],
    board,
    { projection: [...TODO_FIELDS] },
  );
  const doing = await listCardsByColumn(
    opts.node,
    opts.cfg,
    "doing",
    [...DOING_FIELDS],
    board,
    { projection: [...DOING_FIELDS] },
  );
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
      todo = todo.filter((card) => card.slug !== candidate.slug);
      if (err.current === "doing" || err.current === "unknown") {
        liveDoing.push({ ...candidate, column: "doing" });
      }
    }
  }
}
