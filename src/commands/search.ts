// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  blockedSlugSet,
  boardTerminalMap,
  ensureColumn,
  listBoards,
  listCards,
  queryTerms,
  requireBoard,
  searchCards,
  sortCards,
  type Card,
} from "../record.ts";
import { capFlat, DEFAULT_SEARCH_LIMIT, renderSearchResults, resolveLimits } from "../board.ts";
import { renderFieldProjection } from "../field_projection.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

export type SearchOptions = {
  cfg: Config;
  node: NodeClient;
  query: string;
  board?: string;
  column?: string;
  json?: boolean;
  fields?: string[];
  // Flat cap on rendered matches (defaults to DEFAULT_SEARCH_LIMIT for text).
  // `all` removes the cap. Mirrors `list`'s `--limit`/`--all` contract.
  limit?: number;
  all?: boolean;
};

// Both the human text and the structured (`--json`) matches, from a single
// read. `searchCmd` (CLI) returns one; the MCP tool returns both.
//
// `cards` here is the COMPLETE match set — capping is the *caller's* job so each
// surface applies its own contract:
//   - The text view caps at DEFAULT_SEARCH_LIMIT as a display affordance only
//     (`renderSearchResults` applies it and prints a "… N more" footer).
//   - `searchCmd` (`--json`) applies an *explicit* `--limit` to the serialized
//     array via `capFlat` (`jsonLimit`); no flag → the full array (the CLI
//     `--json` consumer asked for it explicitly).
//   - The `fkanban_search` MCP tool caps the structured array BY DEFAULT
//     (DEFAULT_SEARCH_LIMIT, via `server.ts`'s `capCards`), because its consumer
//     is a token-bounded LLM: every match carries its full `body`, so returning
//     all of them on a real board (160+ cards) overflows the agent's context in
//     one call. It accepts `limit`/`all` to opt out and reports `total`/
//     `truncated` so the cap is never silent.
// `jsonLimit` is the CLI-only knob: 0 = no cap (default and `--all`); >0 =
// explicit `--limit` cap. Mirrors `list`'s contract exactly.
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
  const { textLimit, jsonLimit } = resolveLimits(opts, DEFAULT_SEARCH_LIMIT);
  // Resolve blocked status against ALL live cards so cross-board deps count,
  // counting a dep as done at its own board's terminal column (board slug →
  // last column), falling back to `done` for unresolvable boards.
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  const text = renderSearchResults(matches, opts.query, {
    blocked: blockedSlugSet(matches, allCards, boardTerminal),
    limit: textLimit,
  });
  return { text, cards: matches, jsonLimit };
}

export async function searchCmd(opts: SearchOptions): Promise<string> {
  const projectionFields = opts.fields ?? [];
  const { text, cards, jsonLimit } = await searchResult(opts);
  const out = jsonLimit > 0 ? capFlat(cards, jsonLimit) : cards;
  if (projectionFields.length > 0) return renderFieldProjection(out, projectionFields);
  if (!opts.json) return text;
  // Honor an explicit `--limit` on the machine-readable surface too: cap to the
  // same matches the text view shows. No explicit limit (jsonLimit 0) → the
  // full match array, unchanged.
  return JSON.stringify(out, null, 2);
}
