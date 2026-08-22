import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { firstEligible, type DependencyStatuses } from "../pickup_v2.ts";
import {
  listCardsByColumn,
  listDependencyStatusesForCards,
  TERMINAL_COLUMN,
  type Card,
} from "../record.ts";
import { claimCard, ClaimConflictError } from "./move.ts";

const TODO_FIELDS = [
  "slug",
  "column",
  "position",
  "created_at",
  "repo",
  "deps",
  "surfaces",
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
    };

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

  while (true) {
    const candidate = firstEligible(todo, liveDoing, statuses);
    if (!candidate) return { result: "none", dry_run: opts.dryRun === true };

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
      if (!(err instanceof ClaimConflictError)) throw err;
      todo = todo.filter((card) => card.slug !== candidate.slug);
      if (err.current === "doing" || err.current === "unknown") {
        liveDoing.push({ ...candidate, column: "doing" });
      }
    }
  }
}
