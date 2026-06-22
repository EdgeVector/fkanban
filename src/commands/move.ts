// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  boardTerminalMap,
  cardToFields,
  depStatus,
  ensureColumn,
  findBoard,
  findCard,
  isWorkingColumn,
  listBoards,
  listCardStatuses,
  nowIso,
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

export type MoveResult = { slug: string; from: string; to: string };

export async function moveCmd(opts: MoveOptions): Promise<MoveResult> {
  const card = await findCard(opts.node, opts.cfg, opts.slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${opts.slug}".` });
  }
  const board = await findBoard(opts.node, opts.cfg, card.board);
  const columns = board?.columns ?? [];
  ensureColumn(opts.column, columns);

  // Soft-block: refuse to start a card (move into doing/review/done) while any
  // dependency is unfinished, unless --force. Backlog/todo moves are always ok.
  if (!opts.force && isWorkingColumn(opts.column)) {
    // Resolve dep done-ness against each dep board's terminal column (deps may
    // live on other boards), falling back to `done` for unresolvable boards.
    const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
    const status = depStatus(card, await listCardStatuses(opts.node, opts.cfg), boardTerminal);
    if (status.blocked) {
      throw new FkanbanError({
        code: "card_blocked",
        message: `Card "${card.slug}" is blocked by ${status.blockedBy
          .map((d) => `"${d}"`)
          .join(", ")} (not yet done).`,
        hint: `Move ${status.blockedBy.length > 1 ? "those" : "it"} to \`done\` first, or pass --force to override.`,
      });
    }
  }

  const from = card.column;
  const position = opts.position !== undefined ? String(opts.position) : appendPosition();

  const updated: Card = {
    ...card,
    column: opts.column,
    position,
    updated_at: nowIso(),
  };
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
  return { slug: card.slug, from, to: opts.column };
}
