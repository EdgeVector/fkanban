// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { FkanbanError, type AppSearchHit, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  blockedSlugSet,
  boardTerminalMap,
  CARD_DISPLAY_FIELDS,
  ensureColumn,
  findCard,
  listCardBodies,
  listDependencyStatusesForCards,
  listBoards,
  listCardsByFilter,
  listCardsWithBodies,
  queryTerms,
  requireBoard,
  cardMatchesQuery,
  searchCards,
  sortCards,
  withLoadedBody,
  type Card,
} from "../record.ts";
import { capFlat, DEFAULT_SEARCH_LIMIT, previewCardBodies, renderSearchResults, resolveLimits } from "../board.ts";
import { fieldProjectionNeedsFullCards, renderFieldProjection } from "../field_projection.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import { querySearchPlane } from "../search-plane.ts";

const NATIVE_INDEX_RESULT_CAP = 50;

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
  // Complete mode preserves the historical exhaustive substring search: one
  // admin scan over every Card, INCLUDING cards that are not on any board. The
  // default path is scoped to board membership, so it is the narrower — and for
  // a board search, the more accurate — surface. Both match body text.
  complete?: boolean;
  // CLI compatibility escape hatch: `--full-body` asks for the historical
  // unpreviewed JSON surface. MCP has its own `full_body` option.
  fullBody?: boolean;
};


type SearchPlan = "complete-scan" | "indexed-candidates";

function debugSearchPlan(plan: SearchPlan, detail: Record<string, unknown>): void {
  if (!process.env.FKANBAN_DEBUG_QUERY_PLAN) return;
  console.error(`fkanban: query-plan search ${plan} ${JSON.stringify(detail)}`);
}
function appSearchCardSlugs(results: AppSearchHit[], cardSchemaHash: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const hit of results) {
    const schemaName = hit.schema_name;
    const schemaDisplayName = hit.schema_display_name;
    const schemaMatches = cardSchemaHash.length > 0
      ? schemaName === cardSchemaHash
      : schemaDisplayName === "Card" || schemaDisplayName === "fkanban/Card";
    if (!schemaMatches) {
      continue;
    }
    const slug = hit.key_value.hash;
    if (typeof slug !== "string" || slug.length === 0 || seen.has(slug)) continue;
    seen.add(slug);
    out.push(slug);
  }
  return out;
}

function nativeIndexPath(query: string): string {
  const params = new URLSearchParams({
    q: query,
    include_internal: "true",
  });
  return `/api/native-index/search?${params.toString()}`;
}

function legacyNativeCardSlugs(json: unknown, cardSchemaHash: string): string[] {
  if (typeof json !== "object" || json === null) return [];
  const results = (json as Record<string, unknown>).results;
  if (!Array.isArray(results)) return [];
  return appSearchCardSlugs(results.map(legacyNativeHitToAppSearchHit).filter((h): h is AppSearchHit => h !== null), cardSchemaHash);
}

function legacyNativeHitToAppSearchHit(hit: unknown): AppSearchHit | null {
  if (typeof hit !== "object" || hit === null) return null;
  const h = hit as Record<string, unknown>;
  const keyValue = h.key_value;
  if (typeof keyValue !== "object" || keyValue === null) return null;
  const key = keyValue as Record<string, unknown>;
  return {
    key_value: {
      hash: typeof key.hash === "string" ? key.hash : null,
      range: typeof key.range === "string" ? key.range : null,
    },
    fields: typeof h.fields === "object" && h.fields !== null ? h.fields as AppSearchHit["fields"] : {},
    metadata: h.metadata,
    author_pub_key: typeof h.author_pub_key === "string" ? h.author_pub_key : "",
    schema_name: typeof h.schema_name === "string" ? h.schema_name : "",
    schema_display_name: typeof h.schema_display_name === "string" ? h.schema_display_name : "",
    score: typeof h.score === "number" ? h.score : 0,
  };
}

async function nativeIndexCandidateSlugs(opts: SearchOptions): Promise<{ slugs: string[]; saturated: boolean } | null> {
  const cardHash = opts.cfg.schemaHashes.card ?? "";
  // Primary: first-party Search app plane (shared with brain).
  const plane = await querySearchPlane({
    query: opts.query,
    k: NATIVE_INDEX_RESULT_CAP,
    schemas: cardHash ? [cardHash, "fkanban/Card", "Card"] : undefined,
  });
  if (plane !== null && plane.length > 0) {
    const slugs: string[] = [];
    const seen = new Set<string>();
    for (const h of plane) {
      const schemaOk =
        !cardHash ||
        h.schema_name === cardHash ||
        h.schema_name === "fkanban/Card" ||
        h.schema_name === "Card";
      if (!schemaOk) continue;
      const slug = h.key_hash;
      if (!slug || seen.has(slug)) continue;
      seen.add(slug);
      slugs.push(slug);
    }
    if (slugs.length > 0) {
      return {
        slugs,
        saturated: plane.length >= NATIVE_INDEX_RESULT_CAP,
      };
    }
  }

  if (opts.node.search) {
    const hits = await opts.node.search(opts.query, { k: NATIVE_INDEX_RESULT_CAP });
    return {
      slugs: appSearchCardSlugs(hits, cardHash),
      saturated: hits.length >= NATIVE_INDEX_RESULT_CAP,
    };
  }
  const res = await opts.node.rawCall("GET", nativeIndexPath(opts.query));
  if (res.status !== 200) return null;
  const slugs = legacyNativeCardSlugs(res.json, cardHash);
  return {
    slugs,
    saturated: slugs.length >= NATIVE_INDEX_RESULT_CAP,
  };
}


/**
 * The default search path: the board's cards, scoped, matched against their
 * REAL bodies.
 *
 * This used to match a body-free display read and then hydrate up to 50
 * candidate slugs from the semantic index with one wide point-read each. That
 * was worse on both axes it was supposed to trade between, measured on the live
 * primary against the board's 367 live cards:
 *
 *   - RECALL. Body text could only match for cards the semantic index happened
 *     to return, so the command silently missed 35-65% of live matching cards
 *     ("board": 27 matches where the exhaustive scan found 77, 50 of the misses
 *     live board cards). It never invented a match — it was a strict subset.
 *   - COST. 62 queries / 7.3s of node time, against 2 queries / 1.1s for the
 *     `--complete` scan it existed to avoid. Point reads cost ~110ms each here;
 *     a scan amortizes to ~1.7ms/row.
 *   - BODIES. 127 of 153 matches came back with `body: ""`, because the
 *     display-matched cards were returned exactly as read — while the
 *     `fkanban_search` MCP contract promises every match carries its full body.
 *
 * One narrow slug+body scan (413ms) answers the body question for the whole
 * board, so every match is found and every match is whole.
 *
 * The semantic-index candidate path is KEPT, demoted to the fallback for a node
 * that refuses the scan (no `allowFullScan` capability, or no display indexes
 * provisioned). On such a node it is the only way to reach a body match at all,
 * so removing it would cost a real capability in exactly the degraded
 * configuration that can least afford it. When the scan is available the
 * fallback does not run — which is every healthy deployment.
 *
 * Worth recording why it cannot be the PRIMARY path: every hit it returns must
 * still pass `cardMatchesQuery`, a literal substring test, so a
 * semantically-similar card that does not contain the terms is discarded
 * anyway. It never contributed recall beyond substring matching — it just cost
 * 50 point reads to not contribute it. Semantic RANKING is a real feature, but
 * it needs a path that can actually return semantic matches.
 */
async function indexedSearchCards(
  opts: SearchOptions,
): Promise<{ cards: Card[]; allCards: Card[]; fallbackReason?: string }> {
  const filter: Record<string, string> = {};
  if (opts.board) filter.board = opts.board;
  if (opts.column) filter.column = opts.column;

  // Independent reads — the body scan must not sit behind the display read on
  // the critical path (the mistake run (j) made with the portfolio board read).
  const [displayRead, bodies] = await Promise.all([
    listCardsByFilter(opts.node, opts.cfg, filter, CARD_DISPLAY_FIELDS, {
      allowFullScanFallback: false,
    }),
    listCardBodies(opts.node, opts.cfg).catch(() => null),
  ]);

  const inScope = (c: Card): boolean =>
    (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column);
  const scopedDisplay = displayRead.cards.filter(inScope);

  const bySlug = new Map<string, Card>();
  for (const card of scopedDisplay) {
    // `withLoadedBody` is the marker-clearing half of the BODY_OMITTED
    // contract: a card whose body we genuinely read is no longer "unread".
    //
    // AN EMPTY SCAN BODY IS NOT A READ. `listBoardCardsWithBodies` holds this
    // same scan to that rule already; this is its other consumer, and clearing
    // the marker on `""` was the laundering step the sweep fix named — it turns
    // "the scan told me nothing" into "I read it, and it was empty".
    //
    // Here that DEFEATS a defence that is already in place. `fkanban_search`
    // hydrates its capped page (`hydrateCardBodies` on ≤20 cards, mcp/server.ts)
    // so every returned match carries a real body — and `hydrateCardBodies`
    // correctly refuses to re-read a body someone claimed to have read. A card
    // whose scan body was empty therefore skipped the very read that exists to
    // fill it.
    //
    // Keeping the marker costs this path nothing: no read is issued here, and
    // `cardMatchesQuery` sees `body: ""` either way. It only re-arms the bounded
    // hydration downstream. Deliberately NOT hydrating the whole board here —
    // measured on the live primary 2026-08-01, that is 12 point reads / 257ms on
    // a 1139ms read phase for zero recall today
    // (`scripts/probe-search-empty-body-denial.ts`), and the page-bounded read
    // MCP already does is the proportionate place to pay it.
    const body = bodies?.get(card.slug);
    const whole = body === undefined || body.length === 0 ? card : withLoadedBody(card, body);
    if (cardMatchesQuery(whole, opts.query)) bySlug.set(whole.slug, whole);
  }

  // Fallback only, on either half of the degraded case:
  //   - the scan was refused, so no card has a body to match against; or
  //   - the display read could not ENUMERATE the board (no display indexes
  //     provisioned), so there is no card list for the bodies to attach to —
  //     slug+body alone cannot render a result.
  // With both halves healthy the scan has already matched every card this could
  // reach, so spending up to 50 point reads to re-derive a subset is pure cost.
  // That is what the pre-fix default path did on EVERY search.
  let native: { slugs: string[]; saturated: boolean } | null = null;
  if (bodies === null || scopedDisplay.length === 0) {
    try {
      native = await nativeIndexCandidateSlugs(opts);
    } catch {
      native = null;
    }
    const hydrated = await mapWithConcurrency(native?.slugs ?? [], (slug) =>
      findCard(opts.node, opts.cfg, slug),
    );
    for (const card of hydrated) {
      if (!card || !inScope(card)) continue;
      if (cardMatchesQuery(card, opts.query)) bySlug.set(card.slug, card);
    }
  }

  const matches = sortCards([...bySlug.values()]);

  // Dep status for the MATCHES, seeded with the board read — not for the whole
  // board.
  //
  // `listDependencyStatusesForCards` point-reads every dep edge that points OFF
  // its input set, so the scope of its first argument IS the read count. This
  // used to pass `scopedDisplay` (the entire board), and the sole consumer of
  // the result is `blockedSlugSet(matches, allCards, …)` in `searchResult`,
  // which asks `depStatus` about the MATCHES alone. Every dep of a non-matching
  // card was fetched, mapped into a `Map`, and dropped unread.
  //
  // Passing the board as `knownCards` keeps the answer identical rather than
  // merely close: a dep already on the board still resolves from that set with
  // no read, so the only edges that reach the node are the ones a printed
  // verdict can actually depend on.
  //
  // Measured live, `scripts/probe-search-dep-scope-cost.ts`, 7 interleaved reps
  // on a 191-card board (26 board-wide off-set deps):
  //
  // | query | matches | board-wide | match-scoped |
  // |---|---|---|---|
  // | `lastdb` | 127 | 932ms | **195ms** |
  // | `milestone` | 82 | 969ms | **197ms** |
  // | (no match) | 0 | 976ms | **0ms** |
  //
  // and `blockedSlugSet` returned the identical blocked set for every query.
  // The no-match row is the one that names the old shape: a search that finds
  // nothing spent a full second resolving dependencies for an empty answer.
  //
  // Issued AFTER the fallback block on purpose — cards recovered by the native
  // path are matches too, and the old placement resolved deps before they
  // existed, so their blocked status went unresolved in exactly the degraded
  // configuration that path exists to serve.
  const statusCards = await listDependencyStatusesForCards(
    opts.node,
    opts.cfg,
    matches,
    scopedDisplay,
  );

  debugSearchPlan("indexed-candidates", {
    displayCards: scopedDisplay.length,
    displayIndexed: displayRead.indexed,
    bodiesRead: bodies?.size ?? 0,
    bodyScanUnavailable: bodies === null,
    nativeCandidates: native?.slugs.length ?? 0,
    fullBodyScan: false,
  });
  return {
    cards: matches,
    allCards: statusCards,
    // Only the degraded path can be incomplete now: with bodies AND a board
    // enumeration the scan matches every board card, so a saturated native cap
    // is no longer a partial answer to report.
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
    const all = await listCardsWithBodies(opts.node, opts.cfg);
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
