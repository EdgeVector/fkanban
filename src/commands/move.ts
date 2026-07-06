// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.

import { type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  assertDepUnblocked,
  cardToFields,
  doneAtForColumnTransition,
  ensureBoardRecord,
  ensureColumn,
  nowIso,
  requireCard,
  stampCardForWrite,
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
  await stampCardForWrite(opts.node, opts.cfg, updated);
  await assertDepUnblocked(opts.node, opts.cfg, updated, opts.force);
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
  return { slug: card.slug, from, to: opts.column };
}
