// `fkanban list` — render a board (default board unless --board) as columns
// of cards. `--json` dumps the raw cards instead.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { blockedSlugSet, findBoard, listCards, sortCards, type Card } from "../record.ts";
import { renderBoard, type RenderOptions } from "../board.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

export type ListOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
  json?: boolean;
};

export async function listCmd(opts: ListOptions): Promise<string> {
  const boardSlug = opts.board ?? "default";
  const board = await findBoard(opts.node, opts.cfg, boardSlug);
  const allCards = await listCards(opts.node, opts.cfg);
  const cards = allCards.filter(
    (c) => c.board === boardSlug && (!opts.column || c.column === opts.column),
  );

  if (opts.json) {
    return JSON.stringify(sortCards(cards), null, 2);
  }

  const resolvedBoard = board ?? {
    slug: boardSlug,
    title: boardSlug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "",
    updated_at: "",
  };
  // Resolve blocked status against ALL live cards so cross-board deps count.
  const renderOpts: RenderOptions = { blocked: blockedSlugSet(cards, allCards) };
  if (opts.column) renderOpts.column = opts.column;
  return renderBoard(resolvedBoard, cards, renderOpts);
}

export function summarize(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.column] = (out[c.column] ?? 0) + 1;
  return out;
}
