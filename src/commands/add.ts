// `fkanban add <slug>` — create or update a card. Body can come from --body
// or stdin. Column defaults to the board's first column; position appends to
// the end of that column.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  cardToFields,
  ensureColumn,
  findBoard,
  findCard,
  listCards,
  nowIso,
  validateSlug,
  type Card,
} from "../record.ts";

export type AddOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  board?: string;
  column?: string;
  assignee?: string;
  tags?: string[];
  body?: string;
};

export type AddResult = { slug: string; action: "created" | "updated"; board: string; column: string };

export async function addCmd(opts: AddOptions): Promise<AddResult> {
  validateSlug(opts.slug);
  const boardSlug = opts.board ?? "default";
  const board = await findBoard(opts.node, opts.cfg, boardSlug);
  if (!board) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `Board "${boardSlug}" does not exist.`,
      hint: `Create it first: \`fkanban board create ${boardSlug}\` (or use the default board).`,
    });
  }
  const columns = board.columns;
  const column = opts.column ?? columns[0] ?? "backlog";
  ensureColumn(column, columns);

  const hash = schemaHashFor("card", opts.cfg);
  const existing = await findCard(opts.node, opts.cfg, opts.slug);
  const now = nowIso();

  if (existing) {
    const updated: Card = {
      ...existing,
      title: opts.title ?? existing.title,
      body: opts.body ?? existing.body,
      board: boardSlug,
      column: opts.column ?? existing.column,
      assignee: opts.assignee ?? existing.assignee,
      tags: opts.tags ?? existing.tags,
      updated_at: now,
    };
    if (opts.column) ensureColumn(updated.column, columns);
    await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: opts.slug });
    return { slug: opts.slug, action: "updated", board: boardSlug, column: updated.column };
  }

  const position = await nextPosition(opts.node, opts.cfg, boardSlug, column);
  const card: Card = {
    slug: opts.slug,
    title: opts.title ?? opts.slug,
    body: opts.body ?? "",
    board: boardSlug,
    column,
    position: String(position),
    assignee: opts.assignee ?? "",
    tags: opts.tags ?? [],
    created_at: now,
    updated_at: now,
  };
  await opts.node.createRecord({ schemaHash: hash, fields: cardToFields(card), keyHash: opts.slug });
  return { slug: opts.slug, action: "created", board: boardSlug, column };
}

// Append: 10 past the current max position among live cards in that column,
// leaving gaps so a card can be inserted between two others later.
export async function nextPosition(
  node: NodeClient,
  cfg: Config,
  board: string,
  column: string,
): Promise<number> {
  const cards = await listCards(node, cfg);
  const inCol = cards.filter((c) => c.board === board && c.column === column);
  let max = 0;
  for (const c of inCol) {
    const n = parseInt(c.position, 10);
    if (Number.isFinite(n) && n > max) max = n;
  }
  return max + 10;
}
