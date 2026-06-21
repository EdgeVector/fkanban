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
import { capFlat, DEFAULT_SEARCH_LIMIT, renderSearchResults } from "../board.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

export type SearchOptions = {
  cfg: Config;
  node: NodeClient;
  query: string;
  board?: string;
  column?: string;
  json?: boolean;
  // Flat cap on rendered matches (defaults to DEFAULT_SEARCH_LIMIT for text).
  // `all` removes the cap. Mirrors `list`'s `--limit`/`--all` contract.
  limit?: number;
  all?: boolean;
};

// Both the human text and the structured (`--json`) matches, from a single
// read. `searchCmd` (CLI) returns one; the MCP tool returns both.
//
// `cards` is the COMPLETE match set — the default text cap
// (DEFAULT_SEARCH_LIMIT) is a display affordance only (`renderSearchResults`
// applies it and prints a "… N more" footer; the structured array stays
// complete so the MCP tool and other machine consumers get every match). An
// *explicit* `--limit`/`--all` is intentional and should mean the same thing on
// both surfaces, so it's surfaced as `jsonLimit` for `searchCmd` to apply to the
// serialized array via `capFlat`. `jsonLimit`: 0 = no cap (default and `--all`);
// >0 = explicit `--limit` cap. Mirrors `list`'s contract exactly.
export async function searchResult(
  opts: SearchOptions,
): Promise<{ text: string; cards: Card[]; jsonLimit: number }> {
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

  // Text render cap: an explicit `--limit` (always >= 1 after flag parsing),
  // `--all` removes the cap (0), and the no-flag default falls back to
  // DEFAULT_SEARCH_LIMIT so a long match list collapses to a "… N more" line.
  const limit = opts.all
    ? 0
    : Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : DEFAULT_SEARCH_LIMIT;
  // Resolve blocked status against ALL live cards so cross-board deps count.
  const text = renderSearchResults(matches, opts.query, {
    blocked: blockedSlugSet(matches, allCards),
    limit,
  });
  // JSON cap: ONLY an *explicit* `--limit` caps the structured array; `--all`
  // and the no-flag default leave it complete (0).
  const jsonLimit =
    !opts.all && Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : 0;
  return { text, cards: matches, jsonLimit };
}

export async function searchCmd(opts: SearchOptions): Promise<string> {
  const { text, cards, jsonLimit } = await searchResult(opts);
  if (!opts.json) return text;
  // Honor an explicit `--limit` on the machine-readable surface too: cap to the
  // same matches the text view shows. No explicit limit (jsonLimit 0) → the
  // full match array, unchanged.
  const out = jsonLimit > 0 ? capFlat(cards, jsonLimit) : cards;
  return JSON.stringify(out, null, 2);
}
