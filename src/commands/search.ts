// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { FkanbanError, type AppSearchHit, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  blockedSlugSet,
  CARD_DISPLAY_FIELDS,
  ensureColumn,
  findCard,
  listCardSearchSurfaces,
  listDependencyStatusesForCards,
  listCardsByFilter,
  listCardsWithBodies,
  queryTerms,
  requireBoard,
  cardMatchesQuery,
  searchSurfaceMatchesQuery,
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
import { type WarnSink, renderJsonPage, warnIfTruncated } from "../truncation_notice.ts";

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
  // Legacy bare-array stdout (`--json-array`). Default is the envelope.
  jsonArray?: boolean;
  // Complete mode preserves the historical exhaustive substring search: one
  // admin scan over every Card, INCLUDING cards that are not on any board. The
  // default path is scoped to board membership, so it is the narrower — and for
  // a board search, the more accurate — surface. Both match body text.
  complete?: boolean;
  // CLI compatibility escape hatch: `--full-body` asks for the historical
  // unpreviewed JSON surface. MCP has its own `full_body` option.
  fullBody?: boolean;
  // Sink for the capped-page notice on the CLI `--json-array` path. See list.ts.
  warn?: WarnSink;
  // Meaning-based search instead of substring: rank by the semantic plane and
  // do NOT re-filter through `cardMatchesQuery`.
  //
  // A separate mode rather than a change to the default, deliberately. The
  // default path's contract is literal substring recall, and quietly widening
  // it to "cards that mean something similar" would change every existing
  // caller's results underneath them. This mode is the capability; whether it
  // becomes the default is a product decision with evidence behind it, not a
  // side effect of the plane getting good.
  semantic?: boolean;
};


type SearchPlan = "complete-scan" | "indexed-candidates" | "semantic";

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
  // Primary: the first-party semantic plane (shared with brain).
  //
  // Scope on the configured hash ALONE. The old call also passed
  // `"fkanban/Card"` and `"Card"` as extra spellings to try, which was
  // harmless against a plane that silently dropped terms it could not resolve
  // — and is exactly wrong against one that does not. LastSeek fails a query
  // whose scope term resolves to nothing, on purpose, so a speculative
  // spelling is no longer a free guess: it would fail every card search.
  //
  // Nothing is lost. LastSeek resolves `bc941dbc…` through its Schema Service
  // table and answers with every identity that key names, which is what the
  // extra spellings were reaching for.
  const plane = await querySearchPlane({
    query: opts.query,
    k: NATIVE_INDEX_RESULT_CAP,
    schemas: cardHash ? [cardHash] : undefined,
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
 * that refuses the key-list drain (no `listRecordKeys`, or no display indexes
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
/**
 * Meaning-based search: the semantic plane ranks, and its hits are NOT
 * re-filtered by `cardMatchesQuery`.
 *
 * That single sentence is the whole reason this function exists separately.
 * `indexedSearchCards` passes every plane candidate through a literal substring
 * test, so a semantically-similar card that does not contain the query's words
 * is discarded — which is why the comment above that function records that the
 * plane "never contributed recall beyond substring matching" and that semantic
 * ranking "needs a path that can actually return semantic matches". This is that
 * path. A hit from a schema-scoped k-NN query IS a match; re-asking whether the
 * words appear is asking the question the ranker was called to answer.
 *
 * Measured on the live board: `--semantic "stop the database from being wiped"`
 * ranks the purge/delete cards first, and none of them contains the word
 * "wiped". The default path returns nothing for that query.
 *
 * Scoped to the Card schema, so this only ever searches kanban's own records.
 * An unresolvable scope term propagates as an error rather than an empty
 * result — see `lastseek-plane.ts`.
 */
async function semanticSearchCards(
  opts: SearchOptions,
): Promise<{ cards: Card[]; allCards: Card[]; fallbackReason?: string }> {
  const native = await nativeIndexCandidateSlugs(opts);
  const inScope = (c: Card): boolean =>
    (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column);

  // Plane order IS the ranking, so hydrate in it and keep it. `sortCards` is
  // deliberately not applied: it would re-order by board position and throw
  // away the only thing this mode is for.
  const hydrated = await mapWithConcurrency(native?.slugs ?? [], (slug) =>
    findCard(opts.node, opts.cfg, slug),
  );
  const matches: Card[] = [];
  const seen = new Set<string>();
  for (const card of hydrated) {
    if (!card || !inScope(card) || seen.has(card.slug)) continue;
    seen.add(card.slug);
    matches.push(card);
  }

  const statusCards = await listDependencyStatusesForCards(
    opts.node,
    opts.cfg,
    matches,
    matches,
  );

  debugSearchPlan("semantic", {
    planeCandidates: native?.slugs.length ?? 0,
    matches: matches.length,
    saturated: native?.saturated ?? false,
  });

  return {
    cards: matches,
    allCards: statusCards,
    fallbackReason:
      native === null
        ? "semantic plane unavailable — install lastseek or drop --semantic"
        : native.saturated
          ? "semantic plane returned its cap"
          : undefined,
  };
}

async function indexedSearchCards(
  opts: SearchOptions,
): Promise<{ cards: Card[]; allCards: Card[]; fallbackReason?: string }> {
  const filter: Record<string, string> = {};
  if (opts.board) filter.board = opts.board;
  if (opts.column) filter.column = opts.column;

  // Independent reads — the key-list read must not sit behind the display read
  // on the critical path (the mistake run (j) made with the portfolio board
  // read).
  //
  // `listCardSearchSurfaces`, not `listCardBodies`: the SAME one key-list read,
  // projected to every field `cardMatchesQuery` reads instead of `body` alone.
  // The extra fields cost no round trip (that read already point-gets each card
  // hash) and they are what lets the recovery pass below decide a match for a
  // card the display index never enumerated — including one whose only match is
  // its title.
  const [displayRead, surfaces] = await Promise.all([
    listCardsByFilter(opts.node, opts.cfg, filter, CARD_DISPLAY_FIELDS, {
      allowKeyListFallback: false,
    }),
    listCardSearchSurfaces(opts.node, opts.cfg).catch(() => null),
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
    const body = surfaces?.get(card.slug)?.body;
    const whole = body === undefined || body.length === 0 ? card : withLoadedBody(card, body);
    if (cardMatchesQuery(whole, opts.query)) bySlug.set(whole.slug, whole);
  }

  // Cards the Card KEY LIST covers and the display index did not ENUMERATE.
  //
  // The loop above reads two different things from two different places and
  // only one of them decides membership: `surfaces` is the Card key list (the
  // source of truth `show` point-gets), but the card set being matched is
  // `scopedDisplay` — the BoardCards display index alone. A slug present in the
  // key list and absent from that index is therefore unreachable by `search` at
  // ANY query, while `show <slug>` returns it in full. The key-list read walks
  // straight past it: `surfaces.get(card.slug)` is keyed BY the display read,
  // so a surface with no display row is never looked up.
  //
  // That is the 2026-08-21 dogfood finding (`show` read
  // `kstress-1787297879-3095-s1`, `search kdogtok1787297933` missed it), and it
  // is not rare. Measured on the live primary 2026-08-23,
  // `scripts/probe-search-enumeration-gap.ts`: display read 178 cards, key list
  // 338 slugs, gap 176 — of which **8 were real placed board cards**
  // (`default/todo`, `default/doing`, bodies 2415–31994 chars) that no query
  // could reach. `kanban search "Arm bounded gc-atoms from the daemon sync
  // cycle"` returned 0 against a `todo` card whose title is that exact string.
  //
  // The native fallback below cannot rescue this: it fires only when the read
  // is WHOLLY degraded (`surfaces === null` or an empty display read). One
  // missing row in an otherwise healthy read never trips it.
  //
  // The recovery is bounded by the QUERY, not by the gap: a gap slug is
  // point-read only when the surface the key list already supplies ALREADY
  // matches, judged by `searchSurfaceMatchesQuery` — the same terms, haystack
  // and AND semantics as `cardMatchesQuery`, over the same fields, so the
  // pre-filter cannot under-select and silently re-hide a card. Non-matching
  // gap slugs cost nothing: 0 reads for a no-match query on the board above, 17
  // for `lastdb`, 40 for `kanban`, against 176 keyed reads measured at 38ms
  // concurrent on a 309ms read phase. No cap — a cap here would drop matches
  // while still reading as "search found everything".
  //
  // An EMPTY query recovers nothing. It means "every card on the board", and
  // board membership is exactly what a card with no BoardCards row does not
  // have; answering it from the key list would widen the default board-scoped
  // surface into `--complete`'s job. `searchResult` already rejects an empty
  // query as a usage error before any read, so this guard is the local
  // statement of that contract rather than the thing enforcing it.
  //
  // The point read is authoritative, and it decides membership as well as
  // content: only a card that comes back PLACED (both `board` and `column` set)
  // is one the display index owed us. An off-board Card record stays
  // `--complete`'s to return. `cardMatchesQuery` then runs on the whole card,
  // so one predicate stays in charge of the final answer.
  if (surfaces !== null && queryTerms(opts.query).length > 0) {
    const enumerated = new Set(displayRead.cards.map((c) => c.slug));
    const candidates: string[] = [];
    for (const [slug, surface] of surfaces) {
      if (enumerated.has(slug)) continue;
      if (searchSurfaceMatchesQuery(surface, opts.query)) candidates.push(slug);
    }
    const recovered = await mapWithConcurrency(candidates, (slug) =>
      findCard(opts.node, opts.cfg, slug),
    );
    for (const card of recovered) {
      if (!card || !card.board || !card.column) continue;
      if (!inScope(card)) continue;
      if (cardMatchesQuery(card, opts.query)) bySlug.set(card.slug, card);
    }
  }

  // Fallback only, on either half of the degraded case:
  //   - the key-list read was refused, so no card has a body to match against; or
  //   - the display read could not ENUMERATE the board (no display indexes
  //     provisioned), so there is no card list for the bodies to attach to —
  //     slug+body alone cannot render a result.
  // With both halves healthy, the display read plus the key-list recovery pass
  // above have between them matched every card this could reach, so spending up
  // to 50 more point reads to re-derive a subset is pure cost. (Before that
  // recovery pass existed this comment claimed the same thing of the scan
  // alone, and it was wrong in exactly the way the pass fixes: the key-list
  // read supplies CONTENT, it never supplied MEMBERSHIP.)
  let native: { slugs: string[]; saturated: boolean } | null = null;
  if (surfaces === null || scopedDisplay.length === 0) {
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
    displayServedBy: displayRead.servedBy,
    bodiesRead: surfaces?.size ?? 0,
    bodyScanUnavailable: surfaces === null,
    nativeCandidates: native?.slugs.length ?? 0,
    fullBodyScan: false,
  });
  return {
    cards: matches,
    allCards: statusCards,
    // Only the degraded path can be incomplete now: with the key-list read AND
    // a board enumeration, the display match plus the recovery pass reach every
    // board card, so a saturated native cap is no longer a partial answer.
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
  } else if (opts.semantic) {
    const sem = await semanticSearchCards(opts);
    allCards = sem.allCards;
    matches = sem.cards;
    if (sem.fallbackReason !== undefined) {
      // Surfaced rather than swallowed: "no cards match" and "the plane you
      // asked for isn't there" are different answers, and this mode exists
      // because conflating them is the family of bug it was built to close.
      opts.warn?.(`note: ${sem.fallbackReason}`);
    }
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
  const text = renderSearchResults(matches, opts.query, {
    blocked: blockedSlugSet(matches, allCards),
    limit: textLimit,
    // Semantic order is the answer, not an artifact of how the cards were
    // fetched. Re-sorting it by board position and then capping would print a
    // top-10 of the wrong ten.
    preserveOrder: Boolean(opts.semantic),
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
  const total = cards.length;
  // Bare-array escape hatch keeps the stderr notice; envelope reports structurally.
  if (opts.jsonArray && implicitJsonLimit > 0 && jsonLimit === 0) {
    warnIfTruncated("search", capped.length, total, opts.warn ?? console.error);
  }
  if (projectionFields.length > 0) return renderFieldProjection(capped, projectionFields);
  if (!opts.json) return text;
  const out = broadJson || opts.fullBody ? previewCardBodies(capped, opts.fullBody ?? false) : capped;
  return renderJsonPage("cards", out, total, { jsonArray: opts.jsonArray });
}
