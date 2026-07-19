// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  blockedSlugSet,
  boardTerminalMap,
  CARD_DISPLAY_FIELDS,
  ensureColumn,
  findCard,
  listDependencyStatusesForCards,
  listBoards,
  listCardsByFilter,
  listCardsWithBodiesForSearch,
  queryTerms,
  requireBoard,
  cardMatchesQuery,
  searchCards,
  sortCards,
  type Card,
} from "../record.ts";
import { capFlat, DEFAULT_SEARCH_LIMIT, previewCardBodies, renderSearchResults, resolveLimits } from "../board.ts";
import { fieldProjectionNeedsFullCards, renderFieldProjection } from "../field_projection.ts";
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
  // Complete mode preserves the historical exhaustive substring search. The
  // default text command may use indexed/native candidates and body-free scans
  // so an interactive search does not download every full card body.
  complete?: boolean;
  // CLI compatibility escape hatch: `--full-body` asks for the historical
  // unpreviewed JSON surface. MCP has its own `full_body` option.
  fullBody?: boolean;
};

const NATIVE_INDEX_RESULT_CAP = 50;

type SearchPlan = "complete-scan" | "indexed-candidates";

function debugSearchPlan(plan: SearchPlan, detail: Record<string, unknown>): void {
  if (!process.env.FKANBAN_DEBUG_QUERY_PLAN) return;
  console.error(`fkanban: query-plan search ${plan} ${JSON.stringify(detail)}`);
}

function nativeIndexPath(query: string): string {
  const params = new URLSearchParams({
    q: query,
    include_internal: "true",
  });
  return `/api/native-index/search?${params.toString()}`;
}

function nativeCardSlugs(json: unknown, cardSchemaHash: string): string[] {
  if (typeof json !== "object" || json === null) return [];
  const results = (json as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of results) {
    if (typeof hit !== "object" || hit === null) continue;
    const h = hit as Record<string, unknown>;
    const schemaName = typeof h.schema_name === "string" ? h.schema_name : "";
    const schemaDisplayName = typeof h.schema_display_name === "string" ? h.schema_display_name : "";
    const schemaMatches = cardSchemaHash.length > 0
      ? schemaName === cardSchemaHash
      : schemaDisplayName === "Card" || schemaDisplayName === "fkanban/Card";
    if (!schemaMatches) {
      continue;
    }
    const keyValue = h.key_value;
    if (typeof keyValue !== "object" || keyValue === null) continue;
    const slug = (keyValue as Record<string, unknown>).hash;
    if (typeof slug !== "string" || slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

async function nativeIndexCandidateSlugs(opts: SearchOptions): Promise<{ slugs: string[]; saturated: boolean } | null> {
  const res = await opts.node.rawCall("GET", nativeIndexPath(opts.query));
  if (res.status !== 200) return null;
  const slugs = nativeCardSlugs(res.json, opts.cfg.schemaHashes.card ?? "");
  return {
    slugs,
    saturated: slugs.length >= NATIVE_INDEX_RESULT_CAP,
  };
}

async function indexedSearchCards(
  opts: SearchOptions,
): Promise<{ cards: Card[]; allCards: Card[]; fallbackReason?: string }> {
  const filter: Record<string, string> = {};
  if (opts.board) filter.board = opts.board;
  if (opts.column) filter.column = opts.column;

  const displayRead = await listCardsByFilter(opts.node, opts.cfg, filter, CARD_DISPLAY_FIELDS, {
    allowFullScanFallback: false,
  });

  let native: { slugs: string[]; saturated: boolean } | null = null;
  try {
    native = await nativeIndexCandidateSlugs(opts);
  } catch {
    native = null;
  }

  const scopedDisplay = displayRead.cards.filter(
    (c) => (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column),
  );
  const statusCards = await listDependencyStatusesForCards(opts.node, opts.cfg, scopedDisplay);
  const bySlug = new Map<string, Card>();
  for (const card of scopedDisplay) {
    if (cardMatchesQuery(card, opts.query)) bySlug.set(card.slug, card);
  }

  const hydrated = await Promise.all((native?.slugs ?? []).map((slug) => findCard(opts.node, opts.cfg, slug)));
  for (const card of hydrated) {
    if (!card) continue;
    if (opts.board && card.board !== opts.board) continue;
    if (opts.column && card.column !== opts.column) continue;
    if (cardMatchesQuery(card, opts.query)) bySlug.set(card.slug, card);
  }

  debugSearchPlan("indexed-candidates", {
    displayCards: scopedDisplay.length,
    displayIndexed: displayRead.indexed,
    nativeCandidates: native?.slugs.length ?? 0,
    hydratedCandidates: hydrated.filter(Boolean).length,
    saturated: native?.saturated ?? false,
    fullBodyScan: false,
  });
  return {
    cards: sortCards([...bySlug.values()]),
    allCards: statusCards,
    fallbackReason: native?.saturated ? "native-index returned its cap" : undefined,
  };
}

// Both the human text and the structured (`--json`) matches, from a single
// read. `searchCmd` (CLI) returns one; the MCP tool returns both.
//
// `cards` here is the complete match set — capping is the *caller's* job so each
// surface applies its own contract:
//   - The text view caps at DEFAULT_SEARCH_LIMIT as a display affordance only
//     (`renderSearchResults` applies it and prints a "… N more" footer).
//   - `searchCmd` (`--json`) applies an explicit `--limit`, and also applies a
//     safe DEFAULT_SEARCH_LIMIT cap + body previews for broad all-column JSON
//     reads unless the caller requests `--all` or `--full-body`. JSON alone
//     does not force a deprecated complete-body scan; routine dedupe uses JSON.
//   - The `fkanban_search` MCP tool caps the structured array BY DEFAULT
//     (DEFAULT_SEARCH_LIMIT, via `server.ts`'s `capCards`), because its consumer
//     is a token-bounded LLM: every match carries its full `body`, so returning
//     all of them on a real board (160+ cards) overflows the agent's context in
//     one call. It accepts `limit`/`all` to opt out and reports `total`/
//     `truncated` so the cap is never silent.
// `jsonLimit` is the CLI-only explicit-limit knob: 0 = no explicit cap; >0 =
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
      message: "Missing search query — usage: kanban search <query>",
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
  const complete = opts.complete ?? false;
  let allCards: Card[];
  let matches: Card[];
  if (complete) {
    // One admin Card scan with bodies (search must match body text). Not N+1.
    const all = await listCardsWithBodiesForSearch(opts.node, opts.cfg);
    allCards = all;
    const scoped = allCards.filter(
      (c) => (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column),
    );
    matches = sortCards(searchCards(scoped, opts.query));
    debugSearchPlan("complete-scan", {
      scopedCards: scoped.length,
      filterIndexed: false,
      fullBodyScan: true,
    });
  } else {
    const indexed = await indexedSearchCards(opts);
    if (indexed.fallbackReason !== undefined) {
      debugSearchPlan("indexed-candidates", { reason: indexed.fallbackReason, fullBodyScan: false });
      allCards = indexed.allCards;
      matches = indexed.cards;
    } else {
      allCards = indexed.allCards;
      matches = indexed.cards;
    }
  }

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
  const complete = Boolean(opts.fullBody || fieldProjectionNeedsFullCards(projectionFields));
  const { text, cards, jsonLimit } = await searchResult({ ...opts, complete });
  const broadJson = opts.column === undefined;
  const implicitJsonLimit =
    opts.json && broadJson && !opts.all && !opts.fullBody && opts.limit === undefined ? DEFAULT_SEARCH_LIMIT : 0;
  const effectiveJsonLimit = jsonLimit > 0 ? jsonLimit : implicitJsonLimit;
  const capped = effectiveJsonLimit > 0 ? capFlat(cards, effectiveJsonLimit) : cards;
  if (projectionFields.length > 0) return renderFieldProjection(capped, projectionFields);
  if (!opts.json) return text;
  const out = broadJson || opts.fullBody ? previewCardBodies(capped, opts.fullBody ?? false) : capped;
  return JSON.stringify(out, null, 2);
}
