// `fkanban move <slug> <column>` — move a card to a different column on its
// board. Optionally pin a position; otherwise it appends to the target column.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  cardToFields,
  ensureColumn,
  findBoard,
  findCard,
  nowIso,
  type Card,
} from "../record.ts";
import { nextPosition } from "./add.ts";

export type MoveOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  column: string;
  position?: number;
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

  const from = card.column;
  const position =
    opts.position !== undefined
      ? opts.position
      : await nextPosition(opts.node, opts.cfg, card.board, opts.column);

  const updated: Card = {
    ...card,
    column: opts.column,
    position: String(position),
    updated_at: nowIso(),
  };
  const hash = schemaHashFor("card", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: card.slug });
  return { slug: card.slug, from, to: opts.column };
}
