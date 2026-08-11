// BoardCards HashRange helpers — Dynamo-style membership: hash=board,
// range=column#position#slug. Thin projection only (no body).
//
// List/pickup: one partition query per board (filter HashKey=board).
// Move on same board: delete old sk + put new sk.
// Show: still Card HashKey(slug) for body — never hydrate body on list.
//
// Invariant: at most one BoardCards row per (board, slug). Upserts purge other
// sks for the same slug so column list previews cannot diverge from show.
//
// Hot-path cost (Tom 2026-07-31 profile): BoardCards HashKey(default) was the
// #2 wall-time bucket under client=kanban (avg ~820ms, 500–780 rows, loads=0).
// Cost scales with projected field count (measured: 24-field done-column seed
// 1299ms vs 7-field DEP_SEED 416ms). List paths must project only what the
// caller needs — never default the full 24-field write shape.

import type { Config } from "./config.ts";
import { FkanbanError, type NodeClient, type QueryFilter } from "./client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "./schemas.ts";
import {
  mapWithConcurrency,
  PARTITION_READ_CONCURRENCY,
  POINT_READ_CONCURRENCY,
} from "./concurrency.ts";
import { padPositionSegment, unpadPositionSegment } from "./position_key.ts";
import type { Card } from "./record.ts";
import { toCardSummary, type CardSummary } from "./card-list-index.ts";

export { BOARD_CARDS_LAYOUT };

const LEGACY_BOARD_CARDS_FIELDS = BOARD_CARDS_FIELDS.filter((field) => field !== "created_by");

function isCreatedByFieldMiss(err: unknown): boolean {
  return err instanceof FkanbanError &&
    err.code === "unknown_fields" &&
    err.message.includes("created_by");
}

/**
 * The membership SPINE: the display base shared by every BoardCards read that
 * renders a row, and the set a row was ASSUMED to be guaranteed to carry —
 * because `board` is the partition, `sk` is the range key, and
 * column/position/slug are the three components `sk` is built from.
 *
 * That assumption is false, and {@link BOARD_CARDS_ADDRESS_FIELDS} exists
 * because of it: `board` and `sk` are payload COPIES of the key, not the key.
 * The key is `QueryRow.key.hash` / `.range`, and a write that lands some atoms
 * and not others leaves the row keyed into the partition with no copy of its
 * own address. This set is therefore a display projection like any other — do
 * not read it to answer "did I see every row?".
 *
 * Why this exists — LastDB projection semantics (measured on the primary,
 * 2026-07-30, rule corrected 2026-08-01). A field missing from the *schema* is
 * a loud `unknown_fields` error (see `isCreatedByFieldMiss`); a field missing
 * from a *row* is a SILENT DROP of the whole row — no error, no null, the row
 * simply is not in `results`.
 *
 * This block used to say the drop happens when ANY projected field lacks an
 * atom. It does not: the field that LEADS the projection gates the row, and
 * `milestone` gates from any position. See
 * {@link listBoardCardsPartitionComplete} for the four probes that measured it.
 * The correction does not change what this constant is for — one field still
 * drops less than five — but it does mean this is a filter on `slug`, not a
 * complete read, and callers that need completeness want that function.
 *
 * That bit us for real: the 2026-07-23 multi-key catalog expand added
 * `milestone` to this index and never backfilled it, so on the live board
 * `HashKey=default` returned 896 rows projecting `slug` and 761 projecting
 * `slug,milestone`. The 135-row difference was invisible to every wide read —
 * including `board-cards-heal`, whose whole job is to reap orphan rows and
 * which therefore reported `missing_card: 0` while 58 orphans sat in the
 * partition it had just enumerated.
 *
 * So: anything that must see EVERY row (reconcilers, orphan reaping, parity
 * checks) reads {@link BOARD_CARDS_ADDRESS_FIELDS}. Display paths keep the wide
 * projection — a card missing a display field is worth hiding, a row missing
 * one is not worth losing.
 */
export const BOARD_CARDS_SPINE_FIELDS = [
  "board",
  "sk",
  "slug",
  "column",
  "position",
] as const;

/**
 * The narrowest useful projection for "did I see every row?".
 *
 * Everything a {@link BoardCardSpineRow} needs is carried by the KEY: `board`
 * is the partition (the caller passes it as the filter), and `sk` is the range
 * key, from which `parseBoardCardSk` recovers column/position/slug. So the
 * projected field's CONTENT is never consumed here — only its drop rate
 * matters, and one field drops less than five.
 *
 * The counterpart to {@link MILESTONE_CARDS_ADDRESS_FIELDS}, which made this
 * same move on MilestoneCards; BoardCards is the busiest of the three
 * membership indexes and was the last still reading its spine wide.
 *
 * ## Measured, live primary `HashKey=default`, 2026-08-01
 *
 * (`scripts/probe-spine-hash-field-denial.ts`)
 *
 * | projection | rows |
 * |---|---|
 * | `["title"]` | 358 |
 * | `["slug"]` (this) | 357 |
 * | `["board","sk","slug","column","position"]` (the old spine) | **338** |
 * | `[]` | **338** |
 *
 * 19 rows carry `slug`/`column`/`position`/`title` atoms but no `board`, `sk`,
 * `milestone` or `layout` — partial-write residue, keyed into the partition and
 * addressable by range key, invisible to a read that projects a copy of the key.
 * 18 of the 19 have no Card record (orphans `board-cards heal` exists to reap);
 * the 19th, `lastgit-blob-inventory-primary-cutover`, is a live `needs_human`
 * card that `kanban show` renders and `kanban list` could not see.
 *
 * Two traps worth keeping written down:
 *
 *  - **`[]` is not "no projection"** — it is the WORST projection. The node
 *    falls back to the full field set, so an empty array measures identically
 *    to the old five-field spine.
 *  - **No projection is drop-free.** `title` sees one row `slug` does not, so
 *    this is the narrowest available read, not a complete one. The old doc
 *    claimed completeness (*"this one cannot [drop rows], because a row that
 *    lacks a spine field could not have been keyed into the partition"*) and
 *    that claim is why nobody re-measured it for two days.
 */
export const BOARD_CARDS_ADDRESS_FIELDS = ["slug"] as const;

/** The result of {@link sweepBoardCardsPartition}: rows reached, and gaps. */
export type BoardCardsPartitionSweep = {
  /** Every row reachable under some leading field, deduped by range key. */
  rows: BoardCardSpineRow[];
  /**
   * Leads the node refused. Non-empty means `rows` is a LOWER BOUND on the
   * partition, and any caller whose correctness needs "I saw every row" must
   * treat that as a failure rather than a clean result.
   */
  failedLeads: Array<{ field: string; error: string }>;
};

export type BoardCardSpineRow = {
  board: string;
  sk: string;
  slug: string;
  column: string;
  position: string;
};

/**
 * The membership SPINE plus the two fields a *dependency verdict* reads.
 *
 * `list --column <x>` seeds finished dependencies by reading the board's
 * terminal column, and everything downstream of that read consumes exactly
 * seven fields: `depStatus` reads slug/board/column/kind, `isHiddenCard` reads
 * tags, and `sk`/`position` are the row's own address. Nothing renders a
 * terminal card, so the other 17 fields are fetched and dropped.
 *
 * That is not a rounding error. Measured on the live board (567 `done` rows,
 * same HashRangePrefix, interleaved reps): 1299ms at the 24-field projection
 * against 416ms here, because LastDB resolves a projected field per row. And
 * `done` is an append-only archive — the wide read makes the cost of listing an
 * ACTIVE column scale with everything the board has ever finished.
 */
export const BOARD_CARDS_DEP_SEED_FIELDS = [
  ...BOARD_CARDS_SPINE_FIELDS,
  "tags",
  "kind",
] as const;

/**
 * The membership SPINE plus `tags` — everything the `list` navigation footer
 * consumes, and nothing else.
 *
 * The footer ("ℹ 2 other boards have cards: x (46)") is a per-board COUNT of
 * live cards on boards you are not looking at. It reads `board` to group and
 * `tags` to drop tombstones (`isHiddenCard`); it renders no card, so the other
 * 18 BoardCards fields are fetched and thrown away.
 *
 * Narrowing here is right for COST. It is not automatically less droppable:
 * this list and the wide one both lead with `board`, so they return the same
 * rows — what makes the footer more accurate is dropping `milestone`, which
 * gates from any position (measured 2026-08-01,
 * `scripts/probe-projection-rule-regression.ts`: 351 -> 332 on THIS index when
 * `milestone` is added). On `MilestoneCards` the same shape returns a PARTIAL
 * row instead, and on `BoardMilestones` a field no row has drops nothing at
 * all. Do not carry any of it to another index without measuring that index.
 */
export const BOARD_CARDS_FOOTER_FIELDS = [
  ...BOARD_CARDS_SPINE_FIELDS,
  "tags",
] as const;

/**
 * Text-board render projection: fields `renderBoard` / dep 🔒 status need, plus
 * `milestone` for `--group-by-milestone`. About half of BOARD_CARDS_FIELDS —
 * the measured cost driver on HashKey(default).
 */
export const BOARD_CARDS_DISPLAY_FIELDS = [
  ...BOARD_CARDS_SPINE_FIELDS,
  "title",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "kind",
  "created_at",
  "created_by",
  "milestone",
] as const;

/**
 * Product list / pickup / JSON MCP projection: every dual-written BoardCards
 * field a body-free list consumer reads, minus write-only `layout` and the
 * rarely listed `db` locator (show still point-reads Card for db).
 */
export const BOARD_CARDS_LIST_FIELDS = [
  ...BOARD_CARDS_DISPLAY_FIELDS,
  "updated_at",
  "repo",
  "base",
  "block_status",
  "block_reason",
  "north_star",
  "pr_url",
  "branch",
] as const;

const BOARD_CARDS_FIELD_SET = new Set<string>(BOARD_CARDS_FIELDS);

/**
 * Map a Card-side field want-list to a BoardCards projection.
 *
 * Always includes the membership spine (`board`/`sk`/column/position/slug) so
 * rows stay addressable. Drops `body` (never stored on BoardCards) and
 * `layout` (write marker). Unknown fields are ignored.
 */
export function boardCardsProjectionForCardFields(
  cardFields: readonly string[],
): string[] {
  const want = new Set(cardFields);
  const out: string[] = [];
  const seen = new Set<string>();
  const push = (f: string) => {
    if (seen.has(f) || !BOARD_CARDS_FIELD_SET.has(f)) return;
    if (f === "layout") return;
    seen.add(f);
    out.push(f);
  };
  for (const f of BOARD_CARDS_SPINE_FIELDS) push(f);
  for (const f of cardFields) {
    if (f === "body") continue;
    push(f);
  }
  // Multi-board merge dedupe (preferFresherBoardCard) needs updated_at when
  // the caller asked for a broad product list (anything beyond pure display).
  if (want.has("updated_at") || want.has("block_status") || want.has("repo")) {
    push("updated_at");
  }
  return out;
}

/** Sort key: column#pos(8)#slug — ordered, column-prefix filterable. */
export function boardCardSk(column: string, position: string | number, slug: string): string {
  return `${column}#${padPositionSegment(position)}#${slug}`;
}

export function parseBoardCardSk(
  sk: string,
): { column: string; position: string; slug: string } | null {
  const i = sk.indexOf("#");
  if (i < 0) return null;
  const j = sk.indexOf("#", i + 1);
  if (j < 0) return null;
  return {
    column: sk.slice(0, i),
    position: unpadPositionSegment(sk.slice(i + 1, j)),
    slug: sk.slice(j + 1),
  };
}

export function boardCardsHash(cfg: Config): string | null {
  const h = cfg.schemaHashes?.["board_cards"];
  return h && h.length > 0 ? h : null;
}

/** Config key used while a board-keyed BoardCards identity is being backfilled. */
export const BOARD_CARDS_REKEY_TARGET = "board_cards_rekey_target";

/**
 * Every BoardCards identity a mutation must maintain during a staged rekey.
 * Reads intentionally continue through `board_cards` until the background
 * backfill proves the target complete and atomically swaps the config pin.
 */
export function boardCardsWriteHashes(cfg: Config): string[] {
  const active = boardCardsHash(cfg);
  const target = cfg.schemaHashes?.[BOARD_CARDS_REKEY_TARGET];
  return [...new Set([active, target].filter((h): h is string => Boolean(h && h.length > 0)))];
}

/** One-hash view used by write helpers so a staged target never recurses. */
function boardCardsConfigForHash(cfg: Config, hash: string): Config {
  const schemaHashes: Record<string, string> = { ...cfg.schemaHashes, board_cards: hash };
  delete schemaHashes[BOARD_CARDS_REKEY_TARGET];
  return { ...cfg, schemaHashes };
}

export function boardCardFieldsFromCard(card: Card | CardSummary): Record<string, unknown> {
  const summary = toCardSummary(card as Card);
  const sk = boardCardSk(summary.column, summary.position, summary.slug);
  return {
    board: summary.board || "default",
    sk,
    slug: summary.slug,
    title: summary.title,
    column: summary.column,
    position: String(summary.position),
    assignee: summary.assignee,
    tags: summary.tags,
    deps: summary.deps,
    surfaces: summary.surfaces,
    created_at: summary.created_at,
    created_by: summary.created_by ?? "unknown",
    updated_at: summary.updated_at,
    db: summary.db,
    repo: summary.repo,
    base: summary.base,
    kind: summary.kind,
    block_status: summary.block_status,
    block_reason: summary.block_reason,
    north_star: summary.north_star,
    milestone: summary.milestone ?? "",
    pr_url: summary.pr_url,
    branch: summary.branch,
    layout: BOARD_CARDS_LAYOUT,
  };
}

export function cardFromBoardCardFields(fields: Record<string, unknown>): Card {
  const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
  const arr = (k: string): string[] => {
    const v = fields[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [];
  };
  return {
    slug: str("slug"),
    title: str("title"),
    body: "", // never stored on BoardCards
    board: str("board") || "default",
    column: str("column"),
    position: str("position"),
    assignee: str("assignee"),
    tags: arr("tags"),
    deps: arr("deps"),
    surfaces: arr("surfaces"),
    created_at: str("created_at"),
    created_by: str("created_by") || "unknown",
    updated_at: str("updated_at"),
    done_at: "",
    db: str("db"),
    repo: str("repo"),
    base: str("base"),
    kind: str("kind"),
    block_status: str("block_status"),
    block_reason: str("block_reason"),
    north_star: str("north_star"),
    milestone: str("milestone"),
    pr_url: str("pr_url"),
    branch: str("branch"),
  };
}

/**
 * Spine fields a BoardCards read does not need to project, because the row's
 * own range key carries them losslessly.
 *
 * `sk` IS `QueryRow.key.range`; `parseBoardCardSk` slices `column` off its head
 * and `slug` off its tail, both exactly.
 *
 * `position` is deliberately NOT here, and the reason CHANGED on 2026-08-03.
 * It used to be that `parseBoardCardSk` un-padded through `String(Number(...))`
 * and turned a lexical position into `"NaN"` — that is now fixed
 * ({@link parseBoardCardSk}), so the key does recover `position` for every
 * value the key can represent.
 *
 * What is left is the narrower gap that `padStart` itself cannot close: a
 * position whose string form starts with `0` (`"007"`) is indistinguishable in
 * the key from `"7"`. Deriving `position` from the key would silently rewrite
 * those, and unlike `slug`/`column` there is no projected copy left to check
 * the derivation against — dropping the field IS giving up the only witness. So
 * the field stays projected and the key-derived value stays a cross-check, not
 * a source. `board` is excluded too, but for a different reason: it leads the
 * projection, and the leading field gates the row set when the hash field is
 * absent — which on this index means when `milestone` is absent, NOT `board`.
 * See {@link boardCardsWireProjection}.
 */
const BOARD_CARDS_KEY_DERIVED_FIELDS = ["sk", "slug", "column"] as const;

/**
 * The wire projection for a read whose spine will be recovered from the KEY.
 *
 * Three of the five spine fields — `sk`, `slug`, `column` — are payload copies
 * of the range key, and {@link parseBoardCardSk} reproduces them exactly.
 * `board` is the caller's own filter argument. So most of the spine is
 * derivable without projecting any of it, which
 * {@link spineRowsFromQueryRows} has relied on since 2026-08-01.
 *
 * What is NOT free is dropping the field the row set is gated on. Measured on
 * the live primary 2026-08-04 against constructed rows with known atom sets
 * (`scripts/probe-projection-rule-constructed.ts`, 204 judgements, every other
 * candidate falsified), the node applies **HASH-ELSE-LEAD**: the gate is the
 * HASH field when the projection contains it, and the LEADING field otherwise.
 *
 * **The hash field of this schema is `milestone`, not `board`.** That is not a
 * typo and not a bug to fix: the 2026-07-23 multi-key expand bound BoardCards
 * and MilestoneCards to one schema, and the node's catalog reports
 * `key: {hash_field: "milestone", range_field: "sk"}` for the hash this config
 * pins as `board_cards` (`GET /api/schema/{hash}`, primary, 2026-08-04). Rows
 * are still KEYED by board slug and `HashKey=<board>` still answers — the
 * declared partition works. It is the projection GATE that follows the catalog.
 *
 * Measured here rather than inferred from the sibling index
 * (`scripts/probe-boardcards-hash-gate-constructed.ts`, four constructed rows
 * with known atom sets):
 *
 * | projection | rows returned |
 * |---|---|
 * | `[board,title]` | only rows WITH a `board` atom |
 * | `[title,board]` | **all four** — `board` does not gate off-lead |
 * | `[milestone,title]` | only rows with a `milestone` atom |
 * | `[title,milestone]` | **same** — `milestone` gates from any position |
 * | `[board,milestone]` | the `milestone` set, not the `board` set |
 *
 * So `board` is an ordinary field that gates only when it LEADS, and
 * `milestone` gates from anywhere. That is HASH-ELSE-LEAD
 * ([[lastdb-projection-rule-is-hash-else-lead-not-lead]]) with `milestone` as
 * the hash — the rule generalises; only which field it names had to be looked up.
 *
 * So preserving `fields[0]` verbatim, which this does, is necessary but is not
 * by itself what keeps the row set identical. Two things do:
 *
 *  - `fields[0]` is preserved, which holds the gate steady in the no-hash case;
 *  - `milestone` — this schema's catalog HASH field — is NOT in
 *    {@link BOARD_CARDS_KEY_DERIVED_FIELDS}, so a projection that contained it
 *    still contains it afterwards and one that did not still does not. The
 *    narrowing therefore never moves a read across the hash/no-hash boundary,
 *    which is the only way the gate could change identity.
 *
 * Both conditions are load-bearing; adding `milestone` to the key-derived list
 * would satisfy the first and break the second. (Adding `board` would be safe
 * on the second count and is still wrong on the first, since it leads.) The row
 * set is identical to the un-narrowed read by construction — but by that
 * construction, not by the lead-only argument this comment carried until the
 * rule was measured.
 *
 * The consequence for these reads: {@link BOARD_CARDS_LIST_FIELDS} and
 * {@link BOARD_CARDS_DISPLAY_FIELDS} both project `milestone`, so both are
 * gated on it and a row carrying no `milestone` atom is silently absent from
 * the product board. Not live today — all 127 rows in `HashKey=default` carry
 * one, and `doctor`'s projection-parity check compares against an all-leads
 * sweep and is green (`scripts/probe-boardcards-hash-gate.ts`). It was live on
 * 2026-08-01, when the expand had added the field and nothing had backfilled
 * it. `board` was never the exposure: dropping it from these projections
 * recovers nothing, which the constructed probe shows directly (2/4 either way).
 *
 * ## Why bother — measured, live primary `HashKey=default`, 186 rows, 2026-08-03
 *
 * (`scripts/probe-boardcards-per-field-cost.ts`,
 * `scripts/probe-boardcards-spine-drop-cost.ts`, 7 interleaved reps)
 *
 * | projection | with spine | spine from key | |
 * |---|---|---|---|
 * | {@link BOARD_CARDS_LIST_FIELDS} | 496ms | **386ms** | -110ms |
 * | {@link BOARD_CARDS_DISPLAY_FIELDS} | 335ms | 310ms | -25ms |
 * | {@link BOARD_CARDS_DEP_SEED_FIELDS} | 366ms | **219ms** | -147ms |
 *
 * Row sets identical (186/186, zero extra, zero missing) and the reconstructed
 * `slug`/`column`/`position` agreed with the projected copies on every shared
 * row, which is what makes this a cost change and not a behaviour change.
 *
 * This also retires the "narrowing is not the lever" reading recorded on
 * {@link listAllBoardCards}. That conclusion came from aggregate width probes
 * where 7 fields measured SLOWER than 14 — impossible if cost tracked field
 * COUNT, and the per-field probe says why: cost is per-field but wildly
 * uneven, and the dep seed is 5/7 spine, so it paid almost pure overhead. The
 * lever was never width. It was which fields.
 */
export function boardCardsWireProjection(fields: readonly string[]): string[] {
  if (fields.length === 0) return [];
  const lead = fields[0]!;
  const out = [lead];
  for (const f of fields.slice(1)) {
    if (f === lead) continue;
    if ((BOARD_CARDS_KEY_DERIVED_FIELDS as readonly string[]).includes(f)) continue;
    out.push(f);
  }
  return out;
}

/**
 * A `Card` from one BoardCards row, taking the spine from the row's REAL key
 * and the payload from the projected fields.
 *
 * Same identity order as {@link spineRowsFromQueryRows}, for the same reason:
 * the range key IS the address, a projected `sk`/`slug`/`column`/`position` is
 * a copy, and on a partially-written row the copy is exactly what went missing.
 * The payload copies remain as a fallback for a wire that carried no key.
 */
export function cardFromBoardCardRow(
  row: { fields?: unknown; key?: { hash: string | null; range: string | null } },
  board: string,
): Card {
  const fields = (row.fields ?? {}) as Record<string, unknown>;
  const base = cardFromBoardCardFields(fields);
  const sk = typeof row.key?.range === "string" && row.key.range.length > 0
    ? row.key.range
    : typeof fields.sk === "string"
      ? fields.sk
      : "";
  const parsed = parseBoardCardSk(sk);
  return {
    ...base,
    board: board || base.board,
    slug: parsed?.slug ?? base.slug,
    column: parsed?.column ?? base.column,
    // `position` stays whatever the row projected — see
    // BOARD_CARDS_KEY_DERIVED_FIELDS for why the key cannot supply it.
    position: base.position,
  };
}

async function deleteBoardCardSk(
  node: NodeClient,
  schemaHash: string,
  board: string,
  sk: string,
): Promise<void> {
  try {
    await node.deleteRecord({
      schemaHash,
      keyHash: board,
      rangeKey: sk,
    });
  } catch {
    // best-effort: stale sk may already be gone
  }
}

/**
 * Retire many sks from ONE partition with the fewest write-gate acquisitions —
 * the delete-side twin of {@link upsertBoardCardsBatch}.
 *
 * Same gate arithmetic: a BoardCards write gates per `(molecule, hash-half)`,
 * so every row of one board shares one gate and a per-row reap takes it once
 * per row. Batched on the live primary that is 2.59x/4.88x cheaper for 48 rows
 * (`scripts/probe-boardcards-batch-delete.ts`) — see {@link NodeClient.deleteRecords}
 * for the table and for why the node accepted this all along.
 *
 * Best-effort per row, exactly like {@link deleteBoardCardSk}, because every
 * caller is reaping rows that are ALREADY superseded: a row that is missing is
 * the outcome the caller wanted. A rejected chunk therefore falls back to
 * per-row deletes — the node names the batch, never the item, so asking for the
 * other 47 separately is the only way to reap them — and each of those swallows
 * its own failure.
 *
 * Returns the number of sks it attempted, matching the per-row callers'
 * long-standing "attempts, not confirmed deletes" contract. Nothing here reads
 * the partition back to count survivors, and callers must not either: the
 * BoardCards index lags its own ack, so the most recently deleted row reads as
 * present for ~half a second after it is gone.
 */
async function deleteBoardCardSksBatched(
  node: NodeClient,
  schemaHash: string,
  board: string,
  sks: readonly string[],
): Promise<number> {
  const targets = sks.filter((sk) => sk);
  if (targets.length === 0) return 0;

  // A client with no batch delete verb (the ad-hoc test fakes) still has to
  // reap. Per-row is what this used to do everywhere, so falling back to it is
  // a loss of speed and nothing else.
  const batch = node.deleteRecords?.bind(node);

  for (let i = 0; i < targets.length; i += BOARD_CARDS_WRITE_BATCH) {
    const chunk = targets.slice(i, i + BOARD_CARDS_WRITE_BATCH);
    try {
      if (!batch) throw new Error("node client exposes no batch delete");
      await batch(chunk.map((sk) => ({ schemaHash, keyHash: board, rangeKey: sk })));
    } catch {
      for (const sk of chunk) {
        await deleteBoardCardSk(node, schemaHash, board, sk);
      }
    }
  }
  return targets.length;
}

/**
 * Delete every BoardCards row for `slug` on `board` whose sk is not `keepSk`
 * (when keepSk is set). When keepSk is null, delete all rows for the slug.
 * Returns how many delete attempts ran.
 *
 * This is the ONLY mechanism that stops one slug from holding two rows in a
 * partition, so a row it cannot address is stale membership nothing can ever
 * remove — no later purge sees it either.
 *
 * **Why it reads the address spine.** It used to read
 * {@link BOARD_CARDS_SPINE_FIELDS} and then rebuild each row's range key from
 * the payload copies it read back. Both halves are measured hazards on this
 * index, and the module's own rule (see {@link BOARD_CARDS_ADDRESS_FIELDS})
 * already named this a reaping path that must read
 * {@link BOARD_CARDS_ADDRESS_FIELDS}:
 *
 *  - the five-field spine projects `board` and `sk`, which are payload COPIES
 *    of the key. A partial write leaves a row keyed into the partition
 *    carrying neither, and LastDB drops any row missing an atom for a
 *    projected field — so the read denies exactly the damaged rows.
 *  - `boardCardSk(row.column, row.position, row.slug)` reconstructs an address
 *    from copies that can drift, when `QueryRow.key.range` IS the address.
 *
 * Measured on the live primary 2026-08-01
 * (`scripts/probe-boardcard-purge-reach.ts`), `HashKey=default`: the spine read
 * returned 335 rows in 652ms, the address read 336 in 195ms. The one row only
 * the address read could see was a SECOND membership row for
 * `lastgit-blob-inventory-primary-cutover` — a live card, duplicated in the
 * partition, that every purge since had walked past. Narrowing is both the
 * complete read and the cheap one; there is no trade here.
 *
 * The sibling `purgeOtherMilestoneCardRows` made this move already
 * (`listMilestoneCardsPartitionSpine`); this path was the one left behind.
 */
export async function purgeOtherBoardCardRows(
  node: NodeClient,
  cfg: Config,
  board: string,
  slug: string,
  keepSk: string | null,
): Promise<number> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash || !slug) return 0;
  const part = await listBoardCardsPartitionSpine(node, cfg, board);
  if (!part) return 0;
  const doomed: string[] = [];
  for (const row of part) {
    if (row.slug !== slug) continue;
    // `row.sk` is the row's real range key, not a rebuild of it.
    if (keepSk !== null && row.sk === keepSk) continue;
    doomed.push(row.sk);
  }
  return await deleteBoardCardSksBatched(node, schemaHash, board, doomed);
}

/**
 * For ONE slug in ONE partition: which of its rows is whole, and which are
 * sparse duplicates that can be retired?
 *
 * `board-cards heal` dedupes its row set by SLUG, so a slug holding both a
 * whole row and a sparse one keeps only the whole one and the sparse sibling is
 * skipped. That was documented as safe because the sibling stayed "reachable on
 * a later pass once the visible one converges" — but convergence is exactly
 * when heal stops acting: a whole row reports no drift, so the slug is never
 * revisited and "later" never arrives. Measured on the live `default` partition
 * 2026-08-01, after a heal run reached `drifted=0 healed=0 missing_card=0`:
 * `["slug"]` returned 340 rows and the five-field spine 339, the difference
 * being a second, sparse membership row for a healthy card.
 *
 * One permanently unreachable row is not itself a user-visible fault. The cost
 * is that `doctor`'s BoardCards parity check can never read clean again, and a
 * check with a standing non-zero floor is one nobody reads — which is how the
 * 19-row gap of 2026-08-01 survived two days behind a check reporting
 * `spine agrees`.
 *
 * Retiring a sparse DUPLICATE is a strictly safer question than the orphan reap
 * heal already performs: the orphan reap must establish that no Card wants this
 * membership, whereas here the card's membership provably survives the delete
 * because a whole sibling row carries it.
 *
 * Refuses (returns `null`) unless there is exactly ONE whole row:
 *
 *  - zero whole rows → every row for the slug is sparse. Not a duplicate
 *    question; heal's existing orphan / thin-field-drift paths own it.
 *  - two or more whole rows → genuine ambiguity about which membership is
 *    current. Deleting either could drop the live one, so this refuses and
 *    leaves it for a human or the drift path.
 *
 * Takes the slug's row addresses from the CALLER rather than re-listing the
 * partition. A caller that has already enumerated the partition end to end
 * knows every sk the slug holds, and re-reading once per duplicate slug would
 * make partition reads scale with the number of rows repaired — the exact cost
 * regression `heal-orphan-reap-partition-rescan.test.ts` pins against. So this
 * costs only one point read per candidate row, and only for slugs measured to
 * hold more than one.
 *
 * Wholeness is decided by {@link readWholeBoardCardRow} — "all 24 fields, and
 * not returned means not whole". This is that function's only remaining caller,
 * and the only one it is sound for: a stale answer makes this REFUSE, never
 * delete. It must never be used as a diff basis for a write.
 */
export async function classifyBoardCardDuplicateRows(
  node: NodeClient,
  cfg: Config,
  board: string,
  slug: string,
  sks: readonly string[],
): Promise<{ keepSk: string; sparseSks: string[] } | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash || !slug) return null;
  const unique = [...new Set(sks.filter((sk) => sk.length > 0))];
  // One row (or none) is not a duplicate question.
  if (unique.length < 2) return null;
  const whole: string[] = [];
  const sparse: string[] = [];
  for (const sk of unique) {
    if (await readWholeBoardCardRow(node, cfg, board, sk)) whole.push(sk);
    else sparse.push(sk);
  }
  if (whole.length !== 1) return null;
  return { keepSk: whole[0]!, sparseSks: sparse };
}

/**
 * Delete BoardCards rows by their REAL range keys, with no partition read.
 *
 * For a caller that already holds the addresses — {@link classifyBoardCardDuplicateRows}
 * hands back exactly the sparse ones — and must not pay
 * {@link purgeOtherBoardCardRows}'s partition scan per row.
 */
export async function deleteBoardCardRowsBySk(
  node: NodeClient,
  cfg: Config,
  board: string,
  sks: readonly string[],
): Promise<number> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return 0;
  return await deleteBoardCardSksBatched(node, schemaHash, board, sks);
}

/**
 * Read exactly one BoardCards row, keyed by its full sk, at the WIDE
 * projection — and treat "not returned" as "not safe to write narrowly".
 *
 * LastDB projections are filters under **HASH-ELSE-LEAD** (gate = hash field
 * when projected, else leading field — see `test/fake-node.ts`). The
 * superseded `any_missing` claim ("EVERY projected field has an atom") is not
 * current node truth. On BoardCards the live catalog hash is often the sparse
 * multi-key field `milestone`, so a wide projection that includes that gate can
 * still drop under-projected rows (see {@link BOARD_CARDS_SPINE_FIELDS} and
 * the 2026-07-23 incident). A `null` return means absent or ungated — every
 * caller's response is the same: do not patch narrowly.
 *
 * Measured cost: **3-6ms** on the post-2026-08-05T15:40Z binary
 * (`scripts/probe-prewrite-read-vs-blind-wide.ts`, 24 samples). The 207ms
 * median once recorded here was the pre-2026-08-05 binary
 * (`scripts/probe-boardcard-point-read.ts`). Projection width barely moves a
 * single-row read, so there is no cheaper variant of this check worth having.
 *
 * ## The one thing a caller must not do with the row it returns
 *
 * This reads the BoardCards INDEX, and that index CAN serve pre-write state,
 * because the write acks off resident and defers the durable put while this read
 * consults durable storage only. A row created moments ago reads `<absent>`
 * rather than partial — the durable molecule has no record for the key yet, so
 * there is nothing partial to return. A torn row would read partial; a deferred
 * one reads absent.
 *
 * **The window is per FIELD, not per row — and only one field on this row has
 * one.** Measured 2026-08-05, `scripts/probe-per-field-readback-freshness.ts`:
 * one write, then all 24 fields polled off that single write, 3/3 reps.
 * Seventeen of the eighteen varied fields read fresh at **5ms**. `milestone`
 * alone reads stale for **935-1798ms**.
 *
 * That is what the two contradictory figures on record were both measuring.
 * `scripts/probe-boardcard-read-after-write-lag.ts` polled `milestone` and
 * reported ~0.8-2.4s; `scripts/probe-write-shape-vs-readback-freshness.ts`
 * polled `tags` and reported 2-9ms fresh, 11/11. Both are correct and NEITHER
 * generalizes to the row. `scripts/probe-freshness-bisect-raw-vs-real-path.ts`
 * ran the five-rung ladder between the two configurations and found, 15/15,
 * that the seed path and the write path move the number not at all — the
 * polled field is the whole variable. So the earlier explanations, write shape
 * and hammering-one-slot, are both retired: `probe-followon-write-drains-
 * deferred-put.ts` measured repeated same-slot writes as FASTER to fresh, not
 * slower, and an extra follow-on write as no help.
 *
 * It is not field position — `pr_url` and `branch` sit after `milestone` in the
 * projection and are fresh. What `milestone` is, and no other field on this row
 * is, is the node's declared partition key: the live `board_cards` pin reports
 * `key.hash_field = "milestone"` (read off the catalog on today's binary; see
 * `checkPinnedSchemaIdentity` in schemas.ts for why the multi-key expand leaves
 * it that way), while every row is written with `keyHash = board`. That is a
 * CORRELATION with a named cause, not a proven mechanism, and the obvious
 * mechanism is already ruled out: `scripts/probe-partition-key-field-is-the-
 * stale-one.ts` predicted the row would be re-placed into a `milestone`-keyed
 * partition and found it is never in one at all (`HashKey=<milestone>` returns
 * nothing, before or after). Do not restate the correlation as re-placement.
 *
 * The correlation has since been NARROWED by a control arm, and the narrowing
 * is what makes it actionable: `scripts/probe-per-field-freshness-matched-key-
 * schema.ts` runs the identical sweep on `milestone_cards`, whose catalog pin
 * declares `hash_field = "milestone"` and which the app SUPPLIES `milestone`
 * for — the same 24 field names, the same HashRange shape, the same write
 * path, differing only in which of `{board, milestone}` is the supplied key.
 * There, all 18 varied fields read fresh at 4-8ms, `board` included, while a
 * BoardCards control taken minutes later on the same binary reproduced
 * `milestone` at 1479/1923/621ms. So the lag is NOT a property of declared key
 * fields in general, and it is NOT symmetric across the multi-key pair: it
 * needs the catalog to declare a hash_field the client does not supply. That
 * makes it an artifact of the expand, owned by the node, not a general
 * read-path property of this schema shape.
 *
 * Never quote a freshness figure for this schema without naming the field it
 * was polled on.
 *
 * That is survivable for existence-and-wholeness, which is why the remaining
 * caller is sound: {@link classifyBoardCardDuplicateRows} only ever needs
 * "absent or not whole", answered conservatively, and a stale `null` makes it
 * refuse rather than delete.
 *
 * It is NOT survivable as a **diff basis**, and no caller may use it as one. A
 * caller that subtracts this row from what it intends to write gets a diff
 * against pre-write state: a field whose stale value already matches the
 * intended value is dropped from the write even when the row's CURRENT value
 * differs, and the write can no longer correct it. {@link upsertBoardCard} did
 * exactly this until 2026-08-05 and was measured doing it; that path is gone
 * and its replacement writes wide with no read at all.
 */
async function readWholeBoardCardRow(
  node: NodeClient,
  cfg: Config,
  board: string,
  sk: string,
): Promise<{ fields: Record<string, unknown>; projected: readonly string[] } | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  // HashRangePrefix is a fold HashRangeFilter object; QueryFilter's TS type is
  // string-map only — cast at the edge (runtime accepts the object), same as
  // listBoardCardsPartition.
  const filter = { HashRangePrefix: { hash: board, prefix: sk } } as unknown as QueryFilter;
  const read = async (projected: readonly string[]) => {
    const res = await node.queryAll({ schemaHash, fields: [...projected], filter });
    for (const r of res.results) {
      const fields = r.fields as Record<string, unknown>;
      // HashRangePrefix is a PREFIX: one sk can prefix a longer one when a
      // slug is a prefix of another slug. Match the exact row.
      if (fields.sk !== sk) continue;
      // Re-check wholeness here rather than inferring it from the row having
      // been returned at all. The node's projection drop is what makes an
      // incomplete row invisible, but relying on that alone makes this
      // function's contract depend on a behaviour nothing local asserts —
      // and a node that started returning partial rows would silently turn
      // every narrow write into a hole-preserving patch.
      if (projected.some((f) => fields[f] === undefined || fields[f] === null)) return null;
      return { fields, projected };
    }
    return null;
  };
  try {
    return await read(BOARD_CARDS_FIELDS);
  } catch (err) {
    if (!isCreatedByFieldMiss(err)) throw err;
    return await read(LEGACY_BOARD_CARDS_FIELDS);
  }
}

export type BoardCardWriteOptions = {
  /**
   * Skip the defensive orphan-purge rescan for this slug.
   *
   * The purge is a whole-partition read, so it costs the same whether it finds
   * an orphan or nothing. That is the right default for one-card writes (add,
   * move, metadata) which have no idea what else is in the partition.
   *
   * It is the WRONG default for a bulk reconciler that already enumerated
   * every partition up front: `groom board-cards-heal` re-listed the partition
   * once per card, turning an O(cards) repair into O(cards) full-partition
   * reads. Only pass this when the caller has the partition contents in hand
   * and has already accounted for every row belonging to the slug.
   */
  skipOrphanPurge?: boolean;
};

/**
 * Upsert thin BoardCards row. When board/column/position change, the previous
 * sk is deleted (same-board move or board transfer) — but only once the
 * destination row is durable, so a failed write can never leave the card with
 * no membership row at all (see `retireSupersededRows` below). Also purges any
 * other rows for the same slug on the destination board so list cannot keep a
 * stale column membership after a successful card update — see
 * `BoardCardWriteOptions.skipOrphanPurge` for the bulk-reconciler opt-out.
 *
 * ## Why this no longer reads before it writes
 *
 * Until 2026-08-05 every non-move, non-create write took a NARROW path: read
 * the stored row, diff it against the intended fields, send only the
 * difference, skip the write entirely when nothing differed. Two arguments held
 * it up, and both were retired by measurement rather than by preference.
 *
 * **The saving was an artefact.** The table it was built on showed cost scaling
 * with fields SENT (24-changed 5376ms, 24-sent-2-changed 4695ms,
 * 4-sent-2-changed 1197ms, byte-identical 140ms). Three of those four numbers
 * came from `scripts/probe-partial-write-cost.ts` while it ran its arms in a
 * FIXED order, which left arm and slot the same variable, at a 3-sample median
 * reported to the millisecond. Re-run with the arms shuffled per rep and each
 * arm's precondition established rather than inherited, 10 samples/arm on the
 * post-2026-08-05T15:40Z binary:
 *
 * | update | ms |
 * |---|---|
 * | 24 fields, every value changed | 1983 |
 * | 24 fields sent, 2 actually changed | 1768 |
 * | 4 fields sent, 2 changed (the narrow path) | 1806 |
 * | 24 fields, every value byte-identical | **48** |
 * | noise floor (median within-arm IQR) | 229 |
 *
 * The first three are ONE number: payload width and changed-field count do not
 * drive BoardCards write cost. Confirmed end to end on a 180-row partition —
 * read+narrow 2309ms vs blind-wide 2455ms, inside the floor
 * (`scripts/probe-prewrite-read-vs-blind-wide.ts`).
 *
 * **The diff basis could be stale, which made the pattern unsound.** The read
 * hits the BoardCards INDEX ({@link readWholeBoardCardRow}), and diffing against
 * pre-write state has two failure modes, both silent:
 *
 *   - Wasted write: handed a byte-identical row, the diff "found" a change that
 *     was not one and wrote anyway in 16 of 16 samples — ~2.3s for what the
 *     node skips whole-record in ~48ms. So the one real cliff in the table above
 *     was a discount the narrow path structurally could not collect, and a wide
 *     write collects it for free by sending the unchanged row.
 *   - **Missed write**: a field whose STALE value already equalled the intended
 *     value was dropped from the narrow write EVEN WHEN the row's current value
 *     differed — so the write could not correct it, and nothing errored. A wide
 *     write has no such mode.
 *
 * **Neither was measured happening to real board traffic, and that is worth
 * stating plainly.** The wasted-write mode needs a byte-identical no-op, and
 * every production caller of this path stamps `updated_at: nowIso()`
 * (`writeCardPatch`, move, add, groom, pickup claim, migrate) while the callers
 * that did not — heal, the batch fall-back, milestone `writePayload:false` — all
 * opted out of narrowing anyway. The missed-write mode needs a stale read, and
 * `scripts/probe-narrow-write-drops-a-toggled-field.ts` drove the exact toggle
 * that would hit it through the pre-fix tree: 3/3 the path's own read came back
 * FRESH 3-6ms after the prior ack and sent `tags` correctly. The 1.2-2.4s
 * staleness on record is real for the shape it was measured on and does not
 * carry here — see {@link readWholeBoardCardRow}.
 *
 * So this is a soundness fix, not an incident fix: writing wide is cheaper on
 * no-ops, the same on real changes (inside the floor, measured twice), one round
 * trip fewer, and strictly safer — a wide write creates a missing row whole and
 * heals a holed one, which is what the narrow path's own fall-through already
 * relied on. Deciding a write from a read that CAN lag is the pattern being
 * removed; how wide the lag happens to be today is not the argument. Evidence:
 * `papercut-kanban-prewrite-read-narrows-against-a-stale-index`; the law it
 * follows from is `decision-2026-08-05-no-stale-reads-after-ack`.
 *
 * The general rule this leaves behind, and the reason the flag it replaced is
 * gone rather than defaulted: **do not read a partition back to decide what to
 * write.** The comment inside this function said exactly that about its
 * callers, one branch above a path that did it. Pinned by
 * `test/board-cards-wide-write.test.ts`.
 */
async function upsertBoardCardOnHash(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous?: Card | CardSummary | null,
  opts: BoardCardWriteOptions = {},
): Promise<void> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return;

  const nextFields = boardCardFieldsFromCard(card);
  const nextBoard = String(nextFields.board);
  const nextSk = String(nextFields.sk);
  const slug = String(nextFields.slug);

  // Retire the rows this write supersedes — AFTER the destination row is
  // durable, never before.
  //
  // ## Why the order is the whole point
  //
  // A move changes the sk (`column#position#slug`), so the destination is a
  // DIFFERENT row from the source: the card has to be written to one key and
  // removed from another, and LastDB gives us no transaction spanning the two.
  // Something is therefore observable in between, and the only choice we get is
  // WHICH something.
  //
  // Deleting first makes that in-between state "the card has no BoardCards row
  // on any board". Every board read is BoardCards-backed — `list`, `pickup`,
  // `overlap`, `rank`, `milestone portfolio`, dep seeding, the board footer —
  // so for the duration of the destination write the card is simply off the
  // board, and if that write fails (a deadline expiry on a busy node is the
  // ordinary case, not an exotic one) it STAYS off until `groom
  // board-cards-heal` next runs. A move is a wide 24-field write, measured at
  // ~5.4s on the live primary: that is a multi-second hole per move, on the
  // hot path, and the card's disappearance looks exactly like a card that was
  // never there.
  //
  // Writing first makes the in-between state "the card has two rows" — and
  // that state is one this codebase already handles on purpose:
  // `listAllBoardCards` dedupes by slug through `preferFresherBoardCard`, and
  // every mutation that reaches here bumps `updated_at`, so the winner is the
  // row we just wrote, by construction. A failed destination write now leaves
  // the card exactly where it was instead of nowhere; a failed cleanup leaves
  // a duplicate that reads correctly and that heal reaps.
  //
  // Both failures are recoverable. Only one of them is invisible while it
  // waits, so prefer the visible one.
  //
  // ## The premise that argument rests on, now measured
  //
  // Everything above assumes the destination row is READABLE once its write
  // acks. It is not. On the live primary
  // (`scripts/probe-readback-lag-by-schema.ts`, 2026-08-03):
  //
  //   | schema     | key shape           | readable on first read | lag  |
  //   |------------|---------------------|------------------------|------|
  //   | Card       | Hash, by hash       | **6/6**                | 104ms|
  //   | BoardCards | HashRange partition | **0/6**                | 514ms|
  //
  // So a BoardCards write is durable but unreadable for ~half a second after
  // its own ack, while a Card point read is read-your-write. The INDEX lags;
  // the record does not. Nothing here polls, and it does not need to — but two
  // consequences are load-bearing:
  //
  //   1. The delete below MUST NOT be issued until the write above has
  //      resolved. Overlapping them (the `Promise.all` reflex) drops the source
  //      row while the destination is still invisible, which is the "card on no
  //      board" state this whole comment exists to prevent — and it would be a
  //      real hole, not a theoretical one, for the length of the lag. Pinned by
  //      `test/board-cards-move-durability.test.ts`, which asserts COMPLETION
  //      order specifically because the issue-order assertion cannot see it.
  //   2. Sequenced as written, the ordering holds: measured over 10 real moves
  //      with a concurrent poller (`scripts/probe-move-visibility-hole.ts`),
  //      **0 of 183 samples** saw the card on zero rows, and 78 saw the
  //      intended transient duplicate. The trade documented above is the one
  //      actually being made.
  //
  // Callers inherit this: any path that writes a BoardCards row and then reads
  // a partition back to decide something is reading pre-write state. `move` and
  // `add` end at the write and `pickup claim` CAS-claims the Card rather than
  // re-reading the board — keep it that way.
  //
  // This function was the exception while asserting it was not: until
  // 2026-08-05 the narrow path below read the partition back and decided what
  // to write from it, one branch away from the comment warning against it. That
  // path is gone; there is now no read on this write path at all. The window it
  // was diffing against is 1.2-2.4s, not the ~514ms recorded above
  // (`scripts/probe-boardcard-read-after-write-lag.ts`) — the 514ms figure
  // answered a different question, whether the FIRST read back is fresh.
  const retireSupersededRows = async () => {
    if (previous) {
      const prevBoard = previous.board || "default";
      const prevSk = boardCardSk(previous.column, previous.position, previous.slug);
      if (prevBoard !== nextBoard || prevSk !== nextSk) {
        // Targeted delete of the known previous sk only. A whole-partition
        // orphan scan here (purgeOtherBoardCardRows) re-lists every BoardCards
        // row on the board on every move/tag — multi-second under HashGroup
        // thrash (papercut-fkanban-move-pays-whole-partition-orphan-scan).
        // Multi-orphan drift is repaired by `groom board-cards-heal`, not the
        // hot write path.
        await deleteBoardCardSk(node, schemaHash, prevBoard, prevSk);
      }
      return;
    }
    if (!opts.skipOrphanPurge) {
      // No previous sk: callers that omit it (legacy/add/metadata) can leave
      // orphan column#pos rows. Scan once and drop every sk except nextSk.
      // Brand-new creates pass skipOrphanPurge (createCardRecord).
      await purgeOtherBoardCardRows(node, cfg, nextBoard, slug, nextSk);
    }
  };

  const write = async (fields: Record<string, unknown>) => {
    try {
      await node.updateRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    } catch (updateErr) {
      if (isCreatedByFieldMiss(updateErr)) throw updateErr;
      await node.createRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    }
  };

  // One write, always the full 24-field shape. No pre-write read: see the
  // docstring's "why this no longer reads before it writes".
  try {
    await write(nextFields);
  } catch (err) {
    if (!isCreatedByFieldMiss(err)) throw err;
    const legacyFields = { ...nextFields };
    delete legacyFields.created_by;
    await write(legacyFields);
  }
  await retireSupersededRows();
}

export async function upsertBoardCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous?: Card | CardSummary | null,
  opts: BoardCardWriteOptions = {},
): Promise<void> {
  for (const hash of boardCardsWriteHashes(cfg)) {
    await upsertBoardCardOnHash(
      node,
      boardCardsConfigForHash(cfg, hash),
      card,
      previous,
      opts,
    );
  }
}

/**
 * How many BoardCards rows ride in one `/api/mutations/batch` request.
 *
 * Measured, not chosen by feel (`probe-boardcards-batch-size.ts`, 48 rows into
 * one partition on the live primary):
 *
 * | chunk | requests | per-write | largest request |
 * |-------|----------|-----------|-----------------|
 * | 1     | 48       | 1282ms    | 1 KiB           |
 * | 4     | 12       | 539ms     | 3 KiB           |
 * | 12    | 4        | 313ms     | 8 KiB           |
 * | 24    | 2        | 236ms     | 15 KiB          |
 * | 48    | 1        | **160ms** | 30 KiB          |
 *
 * The curve had NOT flattened at 48, so this is a balance point rather than a
 * measured optimum — say so plainly rather than implying an elbow that the data
 * does not show. What bounds it is the two costs that grow with the chunk:
 *
 *   - a batch is all-or-nothing, so a failing chunk is a chunk to retry
 *     one-at-a-time, and 48 is the most work one bad row can cost
 *   - one request holds the partition's write gate for its whole duration
 *     (~7.7s at 48), and every other kanban process writing that board queues
 *     behind it
 *
 * The second reads like an argument for a small chunk and is in fact the
 * opposite: batching cuts TOTAL gate-hold for the same work by the same 8x.
 * A 331-card seed holds the gate ~55s across 7 requests instead of ~6 minutes
 * across 331. Longer individual holds, far less of them.
 */
export const BOARD_CARDS_WRITE_BATCH = 48;

/**
 * Write many BoardCards rows with the fewest partition-gate acquisitions.
 *
 * ## The measurement this exists for
 *
 * The node gates a write per `(molecule, hash)`, and for a HashRange field the
 * key is built from the hash HALF only (`ChangedKey::disk_hash()`), so every
 * row of one board shares one gate. On the live primary
 * (`probe-boardcards-write-lock-contention.ts`) that makes concurrent writes
 * into one partition **0.91x** of serial — the fan-out is a net loss, not a
 * wash — while the identical work in one batch is 2.10x.
 *
 * So this does NOT fan out. It sends chunks, in order, and each chunk pays the
 * gate once.
 *
 * ## Why it falls back instead of failing
 *
 * The node rejects a whole batch on any item's failure, and the callers here
 * are repair paths whose entire value is finishing: `seedBoardCards` learned
 * that the hard way when one unwritable card abandoned the seed for every card
 * after it. A rejected chunk is therefore retried ONE ROW AT A TIME through
 * {@link upsertBoardCard}, which restores exactly the per-item isolation the
 * batch gives up — the slow path costs what today already costs, and only for
 * the chunk that actually failed.
 *
 * `onError` sees each individually-failed row so callers keep their own
 * best-effort accounting; a caller that omits it gets the row skipped.
 *
 * Rows are written WIDE (every field) and with no orphan purge: both callers
 * are writing current truth for a card whose superseded rows are either
 * provably absent or `groom board-cards-heal`'s job. Do not reach for this on
 * the interactive path — a `move` must retire its source sk, which is a
 * per-card decision this deliberately does not make.
 */
export async function upsertBoardCardsBatch(
  node: NodeClient,
  cfg: Config,
  cards: Array<Card | CardSummary>,
  onError?: (card: Card | CardSummary, err: unknown) => void,
): Promise<void> {
  const schemaHashes = boardCardsWriteHashes(cfg);
  if (schemaHashes.length === 0 || cards.length === 0) return;

  // A client with no batch verb (the ad-hoc test fakes) still has to write.
  // Per-row is what this used to do everywhere, so falling back to it is a loss
  // of speed and nothing else.
  const batch = node.updateRecords?.bind(node);

  for (const schemaHash of schemaHashes) {
    const oneHashCfg = boardCardsConfigForHash(cfg, schemaHash);
    for (let i = 0; i < cards.length; i += BOARD_CARDS_WRITE_BATCH) {
      const chunk = cards.slice(i, i + BOARD_CARDS_WRITE_BATCH);
      try {
        if (!batch) throw new Error("node client exposes no batch write");
        await batch(
          chunk.map((card) => {
            const fields = boardCardFieldsFromCard(card);
            return {
              schemaHash,
              fields,
              keyHash: String(fields.board),
              rangeKey: String(fields.sk),
            };
          }),
        );
      } catch {
        // Per-row from here. The batch told us the CHUNK failed, never which row,
        // so the only way to write the other 47 is to ask for them separately.
        for (const card of chunk) {
          try {
            await upsertBoardCardOnHash(node, oneHashCfg, card, null, {
              skipOrphanPurge: true,
            });
          } catch (err) {
            onError?.(card, err);
          }
        }
      }
    }
  }
}

export async function removeBoardCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  opts: BoardCardWriteOptions = {},
): Promise<void> {
  const board = card.board || "default";
  const sk = boardCardSk(card.column, card.position, card.slug);
  for (const schemaHash of boardCardsWriteHashes(cfg)) {
    const oneHashCfg = boardCardsConfigForHash(cfg, schemaHash);
    await deleteBoardCardSk(node, schemaHash, board, sk);
    // Also purge any orphan sks for the same slug (stale column membership).
    if (card.slug && !opts.skipOrphanPurge) {
      await purgeOtherBoardCardRows(node, oneHashCfg, board, card.slug, null);
    }
  }
}

/**
 * The two key ranges that bracket one column, i.e. everything in a partition
 * EXCEPT `column`.
 *
 * The sort key is `column#pos#slug`, so a column occupies the single contiguous
 * span `[column#, column$)` — `$` is the byte after `#`, so the upper bound is
 * exclusive of every `column#…` key and inclusive of nothing else. Its
 * complement is therefore exactly two ranges, whatever the board's column list
 * is; this does NOT scale with column count the way naming the wanted columns
 * would.
 *
 * That distinction is the whole reason this shape exists. Reading the ACTIVE
 * COLUMNS by name (six `HashRangePrefix` queries) was measured on 2026-08-02
 * and LOST to one whole-partition read, 797ms vs 522ms — a kanban read pays for
 * round trips, not rows, so six of them cannot win by dropping rows. Two do:
 * measured on the live `default` partition (170 rows, 141 of them `done`),
 * whole-partition-then-filter 449ms vs these two ranges concurrently 214ms,
 * winning 7/7 interleaved reps with identical results
 * (`scripts/probe-nonterminal-range-vs-whole.ts`).
 */
function excludeColumnRanges(board: string, column: string): [QueryFilter, QueryFilter] {
  const below = { HashRangeRange: { hash: board, start: "", end: `${column}#` } };
  const above = { HashRangeRange: { hash: board, start: `${column}$`, end: "￿" } };
  return [below as unknown as QueryFilter, above as unknown as QueryFilter];
}

/**
 * One keyed BoardCards query (no body).
 * - board only → HashKey partition (all columns on that board)
 * - board + column → HashRangePrefix column# (server-side column pushdown)
 * - board + excludeColumn → two HashRangeRange reads around that column
 *
 * No HashKey + client-filter fallback when the prefix path fails. A broken
 * HashRangePrefix must surface as an error (or empty fields → empty list),
 * not silently degrade to a full partition scan that papers over the bug.
 *
 * `opts.fields` narrows the projection for a caller that does not render the
 * rows (see {@link BOARD_CARDS_DEP_SEED_FIELDS}). Narrowing is strictly
 * cheaper. It is NOT strictly less droppable, which this said until
 * 2026-08-01: the row set is decided by the LEADING field, so dropping trailing
 * fields changes nothing about which rows come back, and reordering the list
 * changes everything. The one exception is `milestone`, which gates from any
 * position — removing it can only ADD rows. See
 * {@link listBoardCardsPartitionComplete}.
 */
export async function listBoardCardsPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
  opts?: { column?: string; excludeColumn?: string; fields?: readonly string[] },
): Promise<Card[] | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  const column = opts?.column?.trim();
  const excluded = opts?.excludeColumn?.trim();
  const projection = opts?.fields;
  // HashRangePrefix / HashRangeRange are fold HashRangeFilter objects;
  // QueryFilter's TS type is string-map only — cast at the edge (runtime
  // accepts the object).
  const filters: QueryFilter[] =
    column && column.length > 0
      ? [{ HashRangePrefix: { hash: board, prefix: `${column}#` } } as unknown as QueryFilter]
      : excluded && excluded.length > 0
        ? excludeColumnRanges(board, excluded)
        : [{ HashKey: board } as unknown as QueryFilter];
  const readOne = async (filter: QueryFilter) => {
    try {
      return await node.queryAll({
        schemaHash,
        fields: boardCardsWireProjection([...(projection ?? BOARD_CARDS_FIELDS)]),
        filter,
      });
    } catch (err) {
      // Schema drift only (created_by optional) — not a list-path fallback.
      if (!isCreatedByFieldMiss(err)) throw err;
      return await node.queryAll({
        schemaHash,
        fields: boardCardsWireProjection(
          [...(projection ?? LEGACY_BOARD_CARDS_FIELDS)].filter(
            (field) => field !== "created_by",
          ),
        ),
        filter,
      });
    }
  };
  // The two exclude-ranges are independent, so they overlap — the same reason
  // `listAllBoardCards` fans its partitions out. A single filter still makes
  // exactly one round trip.
  const responses = await Promise.all(filters.map(readOne));
  return responses
    .flatMap((res) => res.results)
    // `board` is the filter argument, not a payload copy — same choice, and the
    // same reasoning, as `spineRowsFromQueryRows`.
    .map((r) => cardFromBoardCardRow(r, board))
    .filter((c) => c.slug.length > 0)
    .filter((c) => !column || c.column === column)
    // Belt-and-braces against a node that widens a range bound: the caller
    // asked for "not this column" and must never be handed one.
    .filter((c) => !excluded || c.column !== excluded);
}

/**
 * Every row in a board partition, projecting only
 * {@link BOARD_CARDS_ADDRESS_FIELDS} and addressing each row by its REAL key.
 *
 * The narrowest available read, and the right one wherever "did I see every
 * row?" is the question — but not a drop-free one, and it used to say it was.
 * See {@link BOARD_CARDS_ADDRESS_FIELDS} for the measurement that retired that
 * claim: projecting the five-field spine cost 19 of 357 rows on the live
 * `default` partition, because `board` and `sk` are payload copies of the key
 * and a partial write leaves a row keyed with neither.
 *
 * Identity comes from `QueryRow.key` first and the payload copies only as a
 * fallback — the same order `listMilestoneCardsPartitionSpine` and
 * `listBoardMilestonesPartitionSpine` already use. The range key IS the row's
 * address; a copy of it is just a copy, and on precisely the damaged rows this
 * read exists to surface, the copy is what went missing.
 */
export async function listBoardCardsPartitionSpine(
  node: NodeClient,
  cfg: Config,
  board: string,
  opts?: { column?: string },
): Promise<BoardCardSpineRow[] | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  const column = opts?.column?.trim();
  const filter = (
    column && column.length > 0
      ? { HashRangePrefix: { hash: board, prefix: `${column}#` } }
      : { HashKey: board }
  ) as QueryFilter;
  const res = await node.queryAll({
    schemaHash,
    fields: [...BOARD_CARDS_ADDRESS_FIELDS],
    filter,
  });
  return spineRowsFromQueryRows(res.results, board);
}

/** Shared row-building for every spine-shaped read. `board` is the filter. */
function spineRowsFromQueryRows(
  rows: readonly { fields?: unknown; key?: { hash: string | null; range: string | null } }[],
  board: string,
): BoardCardSpineRow[] {
  const out: BoardCardSpineRow[] = [];
  for (const r of rows) {
    const f = (r.fields ?? {}) as Record<string, unknown>;
    // The range key IS the row's address; `f.sk` is a copy that a partial write
    // can leave behind. Take the real one, and fall back to the copy only when
    // the wire did not carry a key at all.
    const sk = typeof r.key?.range === "string" && r.key.range.length > 0
      ? r.key.range
      : typeof f.sk === "string"
        ? f.sk
        : "";
    // `sk` is the authority for column/position/slug — the copied scalar
    // fields can drift, the range key cannot.
    const parsed = parseBoardCardSk(sk);
    const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
    // A row whose address cannot be resolved is skipped, not addressed by a
    // guess: every caller here either deletes this key or writes to it.
    if (sk.length === 0 || slug.length === 0) continue;
    out.push({
      // The argument, not a payload copy and not `key.hash`: `board` IS the
      // filter, so all three agree by construction and only one of them is
      // guaranteed to be in hand. (A `key.hash` preference here was written and
      // then removed — with the projection narrowed, `f.board` is never
      // projected, so it could not have disagreed with anything.)
      board,
      sk,
      slug,
      column: parsed?.column ?? (typeof f.column === "string" ? f.column : ""),
      position: parsed?.position ?? String(f.position ?? ""),
    });
  }
  return out;
}

/**
 * Every row in a board partition that carries ANY atom — the only complete
 * enumeration a client can perform, and the one "did I see every row?" actually
 * needs.
 *
 * ## The rule this is built on (measured, live primary, 2026-08-01)
 *
 * `scripts/probe-projection-order-dependence.ts`, `-first-field-witness.ts`,
 * `-width-scan.ts`, `-pair-matrix.ts`. Witness row
 * `todo#00007777#debug-protein` on the live `default` partition carries exactly
 * one atom (`title`):
 *
 * | projection | witness |
 * |---|---|
 * | `[title]` | visible |
 * | `[title, board]` | visible |
 * | `[board, title]` | **DROPPED** |
 * | `[title, …19 more]` | visible |
 * | `[title, milestone]` | **DROPPED** |
 *
 * Two independent effects, and neither is a set operation:
 *
 *  1. **The LEADING projected field gates the row.** `[title,X]` returned the
 *     witness for 22 of the 23 other fields; `[X,title]` returned it for none.
 *     Intersection and union are both commutative, so the same field set in two
 *     orders giving two answers rules out each of them outright.
 *  2. **`milestone` gates from any position** — it is the hash field of the
 *     sibling MilestoneCards index (added here by the 2026-07-23 multi-key
 *     expand), and projecting it anywhere denies every row with no `milestone`
 *     atom.
 *
 * This retires the rule four files reasoned from — *"a row is returned only if
 * EVERY projected field has an atom"* — and, in the other direction, the lastgit
 * run's *"WIDENING ADDS ROWS; NARROWING DROPS THEM"*. Both are shadows of the
 * leading-field rule cast by whichever field happened to lead: fkanban's spine
 * led with `board` (sparse) and looked like intersection; lastgit's led with
 * `lgpi_h` (dense) and looked like union.
 *
 * ## Why the sweep has to be this shape
 *
 * A row is visible iff SOME field leads it, so leading with each field in turn
 * reaches every row that has any atom at all, and nothing narrower does. There
 * is no cheaper complete read to find: a projection is a filter on exactly one
 * field, so N fields need N queries. Skipping leads would restore precisely the
 * failure this exists to remove — a completeness check that cannot read its own
 * failure, which is the shape that has now cost this codebase five separate
 * bugs.
 *
 * ## `failedLeads` is part of the answer, not an error channel
 *
 * A lead can fail on its own while its 23 siblings succeed, and the first run of
 * this sweep on the live primary found exactly that: on board
 * `agent-dogfood-scratch`, leading with `column` returns
 * `HTTP 400 … laststore: corrupt: empty rec` while every other lead returns 0
 * rows cleanly. No kanban read path leads with `column`, so that partition has
 * reported itself empty and healthy to every existing check.
 *
 * When a lead fails the enumeration is INCOMPLETE BY EXACTLY THAT LEAD, and
 * both wrong answers were available: swallowing it returns a short row set
 * labelled complete (the failure mode this whole function exists to remove),
 * and throwing lets one corrupt marker on one board stop heal from running on
 * any board. So the gap is returned alongside the rows. Callers that DELETE
 * may proceed — a row they cannot see is a row they cannot delete, so an
 * incomplete sweep can only under-reap — and callers that ASSERT completeness
 * must fail.
 *
 * Cost is real and bounded: 24 single-field queries, six in flight
 * ({@link PARTITION_READ_CONCURRENCY} — these are whole-partition reads, one
 * per field lead, so they belong to the heavy class even though each projects a
 * single field), measured 770-780ms on the 264-row live
 * `default` partition against 166-292ms for the one-query spine — ~3x, not
 * ~24x, because the pool hides socket latency and a one-field projection is
 * the cheapest read the node serves. That is a heal / doctor price, not a list
 * price; no product read path should call this.
 */
export async function sweepBoardCardsPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
): Promise<BoardCardsPartitionSweep | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  const filter = { HashKey: board } as QueryFilter;

  const perLead = await mapWithConcurrency(BOARD_CARDS_FIELDS, async (lead) => {
    try {
      const res = await node.queryAll({ schemaHash, fields: [lead], filter });
      return { rows: spineRowsFromQueryRows(res.results, board), failure: null };
    } catch (err) {
      // `created_by` is the one field a legacy catalog may genuinely not carry;
      // its absence is a known schema shape, not a gap in the enumeration.
      if (lead === "created_by" && isCreatedByFieldMiss(err)) {
        return { rows: [], failure: null };
      }
      // Everything else is REPORTED, not swallowed and not thrown. Swallowing
      // would hand back a short enumeration labelled complete — the exact
      // failure this function exists to remove. Throwing would let one bad lead
      // on one board disable heal for every board, and heal under-reaping is
      // safe (a row it cannot see is a row it cannot delete) while heal not
      // running at all is not. So the caller is told, and decides.
      return {
        rows: [] as BoardCardSpineRow[],
        failure: { field: lead, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }, PARTITION_READ_CONCURRENCY);

  // Union by the REAL address. A row reached under several leads is one row.
  const bySk = new Map<string, BoardCardSpineRow>();
  const failedLeads: BoardCardsPartitionSweep["failedLeads"] = [];
  for (const lead of perLead) {
    if (lead.failure) failedLeads.push(lead.failure);
    for (const r of lead.rows) if (!bySk.has(r.sk)) bySk.set(r.sk, r);
  }
  return { rows: [...bySk.values()], failedLeads };
}

/**
 * When the partition has more than one row for a slug, prefer the newest
 * `updated_at`. (Stale doing# rows often sort before done# alphabetically;
 * first-wins dedupe used to keep the ghost forever.)
 */
export function preferFresherBoardCard(a: Card, b: Card): Card {
  const au = a.updated_at || "";
  const bu = b.updated_at || "";
  if (bu > au) return b;
  if (au > bu) return a;
  // Tie-break: prefer non-empty pr_url / later position string — still weak.
  // Callers should purge orphans; this is list-path defense only.
  return a;
}

/**
 * List every live board's partition and concatenate.
 * Query count = number of boards (typically 1–few), never O(cards) body gets.
 *
 * Default projection is {@link BOARD_CARDS_LIST_FIELDS} (product list), not the
 * full write shape — callers that need every atom (heal) pass `fields` explicitly.
 *
 * ## Why the partitions are read together
 *
 * This is the read behind `kanban list` and `kanban pickup status`, the two
 * commands the routine fleet runs constantly, and what they pay for is ROUND
 * TRIPS rather than rows. Two probes on 2026-08-02 pinned that down on the live
 * board (169 rows, 141 of them the `done` archive):
 *
 *   - `probe-pickup-active-vs-whole.ts` — reading only the ACTIVE columns and
 *     point-reading the k=8 off-set deps, which avoids 83% of the rows, ran
 *     **797ms against 522ms** for the whole-partition reads it replaced. Six
 *     prefix queries lost to two, verdicts identical. Per-query fixed overhead
 *     beat the archive outright.
 *   - `probe-pickup-projection-width.ts` — at 169 rows the read is flat in
 *     projection WIDTH within noise (7 fields 382ms, 14 fields 272ms, 22 fields
 *     400ms), so narrowing is not the lever either.
 *
 * So the boards are read concurrently rather than one after another:
 * `probe-read-fanout-serial-vs-concurrent.ts`, 7 interleaved reps, 573ms serial
 * against 424ms overlapped (1.35x), concurrent winning 6/7. The saving is one
 * partition round trip per board past the first, so it grows with the number of
 * boards an install has — this node has carried 34 Board slugs at once.
 *
 * BOUNDED, not `Promise.all`. Mini sheds with "too many concurrent reads", and
 * a partition read is heavier than the point read {@link POINT_READ_CONCURRENCY}
 * was sized for. The bound here is a LOAD GUARD, not an optimum: what was
 * measured is 2-wide, and widening past that is unmeasured on this path.
 *
 * It therefore reads {@link PARTITION_READ_CONCURRENCY}, which is its own
 * constant rather than a borrowed one. This used to pass the point-read width,
 * and that coupling was a latent hazard rather than a tidiness problem: when
 * `POINT_READ_CONCURRENCY` was raised to 16 on the strength of a measurement
 * taken against POINT reads (`probe-point-read-shed-threshold.ts` — 96
 * concurrent, zero shed), this path would have silently widened too, on the
 * heaviest read kanban issues and against a comment that says the evidence here
 * only reaches 2. `test/concurrency.test.ts` pins the two apart.
 *
 * Ordering is unchanged. `mapWithConcurrency` lands each result at its input
 * index, so the dedupe below still walks boards in the caller's order and
 * `preferFresherBoardCard` resolves a cross-board duplicate exactly as it did
 * when the reads were serial.
 */
export async function listAllBoardCards(
  node: NodeClient,
  cfg: Config,
  boards: Array<{ slug: string; columns?: readonly string[] }>,
  opts?: { fields?: readonly string[]; skipTerminalColumn?: boolean; column?: string },
): Promise<Card[] | null> {
  if (!boardCardsHash(cfg)) return null;
  if (boards.length === 0) return [];
  const projection = opts?.fields ?? BOARD_CARDS_LIST_FIELDS;
  const parts = await mapWithConcurrency(
    boards,
    (b) =>
    listBoardCardsPartition(node, cfg, b.slug, {
      fields: projection,
      // A single-column read is a `HashRangePrefix` per partition, and it wins
      // over `excludeColumn` when both are asked for: naming the one column you
      // want is strictly narrower than naming the one you don't.
      ...(opts?.column ? { column: opts.column } : {}),
      // Per BOARD, not a global constant: the terminal column is whatever that
      // board's column list ends with, and a caller that only reads the active
      // set must not assume every board calls it `done`. A board whose columns
      // we do not know reads whole — degrading to correct-and-slower, never to
      // silently-dropping-the-wrong-column.
      ...(opts?.skipTerminalColumn === true && b.columns && b.columns.length > 0
        ? { excludeColumn: b.columns[b.columns.length - 1] }
        : {}),
    }),
    PARTITION_READ_CONCURRENCY,
  );
  const out: Card[] = [];
  const bySlug = new Map<string, Card>();
  for (const part of parts) {
    if (part === null) return null; // schema missing or query failed → caller falls back
    for (const c of part) {
      const prev = bySlug.get(c.slug);
      if (!prev) {
        bySlug.set(c.slug, c);
        continue;
      }
      bySlug.set(c.slug, preferFresherBoardCard(prev, c));
    }
  }
  for (const c of bySlug.values()) out.push(c);
  return out;
}
