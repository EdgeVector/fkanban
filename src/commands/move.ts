// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.
// Moving a card into its board's terminal column also opportunistically refills
// the default pickup queue: any default/backlog dependents that are now fully
// unblocked and pass the normal default/todo pickup policy are promoted to todo.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { checkpointCardCompletion } from "../brain_checkpoint.ts";
import {
  appendPosition,
  assertDefaultTodoPickupReady,
  assertDepUnblocked,
  boardTerminalMap,
  depStatus,
  doneAtForColumnTransition,
  ensureBoardRecord,
  ensureColumn,
  listBoards,
  listCards,
  nowIso,
  requireCard,
  stampCardForWrite,
  terminalColumn,
  updateCardRecord,
  type Card,
} from "../record.ts";

export type MoveOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  column: string;
  position?: number;
  // Override the dependency soft-block when moving into a working column.
  force?: boolean;
};

export type MoveResult = { slug: string; from: string; to: string; promotedDependents?: string[] };

function isExpectedPromotionSkip(err: unknown): boolean {
  return err instanceof FkanbanError &&
    (err.code === "default_todo_not_pickup_ready" || err.code === "card_blocked");
}

async function promoteUnblockedBacklogDependents(opts: {
  cfg: Config;
  node: NodeClient;
  dependency: Card;
}): Promise<string[]> {
  const dependencySlug = opts.dependency.slug;
  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const boardTerminal = boardTerminalMap(boards);
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

  for (const candidate of candidates) {
    if (depStatus(candidate, cardsWithMovedDependency, boardTerminal).blocked) continue;

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
      assertDefaultTodoPickupReady(updated, false, rawBody);
      await assertDepUnblocked(opts.node, opts.cfg, updated, false);
    } catch (err) {
      if (isExpectedPromotionSkip(err)) continue;
      throw err;
    }
    await updateCardRecord(opts, updated);
    promoted.push(updated.slug);

    const idx = cardsWithMovedDependency.findIndex((c) => c.slug === updated.slug);
    if (idx >= 0) cardsWithMovedDependency[idx] = updated;
  }

  return promoted;
}

export async function moveCmd(opts: MoveOptions): Promise<MoveResult> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  const board = await ensureBoardRecord(opts.node, opts.cfg, card.board);
  const columns = board.columns;
  ensureColumn(opts.column, columns);

  const from = card.column;
  const position = opts.position !== undefined ? String(opts.position) : appendPosition();
  const now = nowIso();

  const updated: Card = {
    ...card,
    column: opts.column,
    position,
    updated_at: now,
    done_at: doneAtForColumnTransition(card, opts.column, columns, now),
  };
  const rawBody = updated.body;
  await stampCardForWrite(opts.node, opts.cfg, updated, {
    warn: !opts.force && updated.board === "default" && updated.column === "todo" ? () => {} : undefined,
  });
  assertDefaultTodoPickupReady(updated, opts.force, rawBody);
  await assertDepUnblocked(opts.node, opts.cfg, updated, opts.force);
  await checkpointCardCompletion({
    cfg: opts.cfg,
    node: opts.node,
    card: updated,
    boardColumns: columns,
    reason: "done-transition",
  });
  await updateCardRecord(opts, updated);
  const promotedDependents =
    opts.column === terminalColumn(columns)
      ? await promoteUnblockedBacklogDependents({ cfg: opts.cfg, node: opts.node, dependency: updated })
      : [];
  return {
    slug: card.slug,
    from,
    to: opts.column,
    ...(promotedDependents.length > 0 ? { promotedDependents } : {}),
  };
}
