// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  applyHeaderDerivation,
  blockedByHint,
  blockedByMessage,
  boardTerminalMap,
  cardToFields,
  depStatus,
  ensureColumn,
  findBoard,
  isDepEnforcedColumn,
  listBoards,
  listCardStatuses,
  nowIso,
  requireCard,
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
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  const board = await findBoard(opts.node, opts.cfg, card.board);
  const columns = board?.columns ?? [];
  ensureColumn(opts.column, columns);

  // Soft-block: refuse to complete/start a card while any dependency is
  // unfinished, unless --force. Backlog/todo (intake) moves are always ok. The
  // gated set is the default working columns (doing/review/done) PLUS the card's
  // own board's terminal column — so on a custom board a blocked card still
  // can't be moved into its completion column. Resolve dep done-ness, and the
  // gating column, against each board's terminal column (deps may live on other
  // boards), falling back to `done` for unresolvable boards.
  if (!opts.force) {
    const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
    if (isDepEnforcedColumn(opts.column, card.board, boardTerminal)) {
      const status = depStatus(card, await listCardStatuses(opts.node, opts.cfg), boardTerminal);
      if (status.blocked) {
        throw new FkanbanError({
          code: "card_blocked",
          message: blockedByMessage(card.slug, status.blockedBy),
          hint: blockedByHint(),
        });
      }
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
  // Promoting to todo (or backlog) is exactly when a card becomes pickup-eligible
  // — auto-derive the Repo:/Base: header from tags, or warn if it can't, so a
  // promoted card never silently strands.
  updated.body = applyHeaderDerivation(
    { slug: card.slug, body: updated.body, tags: updated.tags, title: updated.title, column: updated.column },
    console.error,
  );
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
  return { slug: card.slug, from, to: opts.column };
}
