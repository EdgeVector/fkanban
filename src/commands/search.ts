// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  blockedSlugSet,
  ensureColumn,
  listCards,
  queryTerms,
  requireBoard,
  searchCards,
  sortCards,
  type Card,
} from "../record.ts";
import { renderSearchResults } from "../board.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

export type SearchOptions = {
  cfg: Config;
  node: NodeClient;
  query: string;
  board?: string;
  column?: string;
  json?: boolean;
};

// Both the human text and the structured (`--json`) matches, from a single
// read. `searchCmd` (CLI) returns one; the MCP tool returns both.
export async function searchResult(opts: SearchOptions): Promise<{ text: string; cards: Card[] }> {
  // A query with zero effective terms (truly empty, or whitespace-only like
  // "   ") is a usage error, not a match-everything wildcard. Guard here — the
  // single entry point for both the CLI (`searchCmd`) and the MCP
  // `fkanban_search` tool — so both surfaces reject uniformly instead of
  // dumping the entire board. Reuse `missing_arg` so the CLI catch maps it to
  // exit 2 (the usage-error code from PR #44).
  if (queryTerms(opts.query).length === 0) {
    throw new FkanbanError({
      code: "missing_arg",
      message: "Missing search query — usage: fkanban search <query>",
    });
  }
  // An explicitly-passed board must exist — a typo'd name should error loudly
  // (matching `add`), not silently report "No cards match". Without `--board`
  // the search spans all boards, so there's nothing to validate.
  const board = opts.board !== undefined ? await requireBoard(opts.node, opts.cfg, opts.board) : null;
  // An explicitly-passed `--column` must be a real column — a typo'd name
  // should error loudly (matching `list --column` via the shared `ensureColumn`),
  // not silently filter every card out and report "No cards match". With
  // `--board` we validate against that board's columns; cross-board search
  // (no `--board`) validates against the canonical `DEFAULT_COLUMNS`, mirroring
  // `list`'s default-board behavior. Only checked when `--column` is set, so the
  // no-`--column` hot path is unchanged.
  if (opts.column !== undefined) {
    ensureColumn(opts.column, board?.columns ?? [...DEFAULT_COLUMNS]);
  }
  const allCards = await listCards(opts.node, opts.cfg);
  const scoped = allCards.filter(
    (c) => (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column),
  );
  const matches = sortCards(searchCards(scoped, opts.query));

  // Resolve blocked status against ALL live cards so cross-board deps count.
  const text = renderSearchResults(matches, opts.query, { blocked: blockedSlugSet(matches, allCards) });
  return { text, cards: matches };
}

export async function searchCmd(opts: SearchOptions): Promise<string> {
  const { text, cards } = await searchResult(opts);
  return opts.json ? JSON.stringify(cards, null, 2) : text;
}
