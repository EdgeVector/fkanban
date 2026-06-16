// `fkanban list` — render a board (default board unless --board) as columns
// of cards. `--json` dumps the raw cards instead.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { blockedSlugSet, findBoard, listCards, requireBoard, sortCards, type Card } from "../record.ts";
import { renderBoard, type RenderOptions } from "../board.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

// Cards shown per column before the rest collapse to a "… N more" line.
// Comfortably above a healthy active column; trims an unbounded `done`.
export const DEFAULT_COLUMN_LIMIT = 12;

export type ListOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
  json?: boolean;
  // Per-column cap (defaults to DEFAULT_COLUMN_LIMIT). `all` removes the cap.
  limit?: number;
  all?: boolean;
};

// Both the human text and the structured (`--json`) payload, built from a
// single board+cards read. `listCmd` (CLI) returns one or the other; the MCP
// tool returns both, so it computes the data once and hands the structured
// `cards` array straight to `structuredContent`.
export async function listResult(opts: ListOptions): Promise<{ text: string; cards: Card[] }> {
  const boardSlug = opts.board ?? "default";
  // An explicitly-passed board must exist — a typo'd name should error loudly
  // (matching `add`), not silently render an empty default-column board. The
  // no-`--board` path defaults to `default`, which always exists, so it stays
  // on the cheap `findBoard` lookup with no extra read on the hot path.
  const board =
    opts.board !== undefined
      ? await requireBoard(opts.node, opts.cfg, boardSlug)
      : await findBoard(opts.node, opts.cfg, boardSlug);
  const allCards = await listCards(opts.node, opts.cfg);
  const cards = sortCards(
    allCards.filter((c) => c.board === boardSlug && (!opts.column || c.column === opts.column)),
  );

  const resolvedBoard = board ?? {
    slug: boardSlug,
    title: boardSlug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "",
    updated_at: "",
  };
  // Resolve blocked status against ALL live cards so cross-board deps count.
  const limit = opts.all
    ? 0
    : Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : DEFAULT_COLUMN_LIMIT;
  const renderOpts: RenderOptions = { blocked: blockedSlugSet(cards, allCards), limit };
  if (opts.column) renderOpts.column = opts.column;
  return { text: renderBoard(resolvedBoard, cards, renderOpts), cards };
}

export async function listCmd(opts: ListOptions): Promise<string> {
  const { text, cards } = await listResult(opts);
  return opts.json ? JSON.stringify(cards, null, 2) : text;
}

export function summarize(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.column] = (out[c.column] ?? 0) + 1;
  return out;
}
