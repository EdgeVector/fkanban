// BoardCards HashRange helpers — Dynamo-style membership: hash=board,
// range=column#position#slug. Thin projection only (no body).
//
// List/pickup: one partition query per board (filter HashKey=board).
// Move on same board: delete old sk + put new sk.
// Show: still Card HashKey(slug) for body — never hydrate body on list.
//
// Invariant: at most one BoardCards row per (board, slug). Upserts purge other
// sks for the same slug so column list previews cannot diverge from show.

import type { Config } from "./config.ts";
import { FkanbanError, type NodeClient, type QueryFilter } from "./client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "./schemas.ts";
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
 * The membership SPINE: the only fields a BoardCards row is guaranteed to
 * carry, because `board` is the partition, `sk` is the range key, and
 * column/position/slug are the three components `sk` is built from.
 *
 * Why this exists — LastDB projection semantics (measured on the primary,
 * 2026-07-30). A query returns a row only if EVERY projected field has an
 * atom on that row. A field missing from the *schema* is a loud
 * `unknown_fields` error (see `isCreatedByFieldMiss`); a field missing from a
 * *row* is a SILENT DROP of the whole row — no error, no null, the row simply
 * is not in `results`.
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
 * checks) reads the spine. Display paths keep the wide projection — a card
 * missing a display field is worth hiding, a row missing one is not worth
 * losing.
 */
export const BOARD_CARDS_SPINE_FIELDS = [
  "board",
  "sk",
  "slug",
  "column",
  "position",
] as const;

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

/** Sort key: column#pos(8)#slug — ordered, column-prefix filterable. */
export function boardCardSk(column: string, position: string | number, slug: string): string {
  const pos = String(position).padStart(8, "0");
  return `${column}#${pos}#${slug}`;
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
    position: String(Number(sk.slice(i + 1, j))),
    slug: sk.slice(j + 1),
  };
}

export function boardCardsHash(cfg: Config): string | null {
  const h = cfg.schemaHashes?.["board_cards"];
  return h && h.length > 0 ? h : null;
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
 * Delete every BoardCards row for `slug` on `board` whose sk is not `keepSk`
 * (when keepSk is set). When keepSk is null, delete all rows for the slug.
 * Returns how many delete attempts ran.
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
  const part = await listBoardCardsPartition(node, cfg, board);
  if (!part) return 0;
  let n = 0;
  for (const row of part) {
    if (row.slug !== slug) continue;
    const sk = boardCardSk(row.column, row.position, row.slug);
    if (keepSk !== null && sk === keepSk) continue;
    await deleteBoardCardSk(node, schemaHash, board, sk);
    n += 1;
  }
  return n;
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
 * Upsert thin BoardCards row. When board/column/position change, delete the
 * previous sk first (same-board move or board transfer). Also purges any
 * other rows for the same slug on the destination board so list cannot keep a
 * stale column membership after a successful card update — see
 * `BoardCardWriteOptions.skipOrphanPurge` for the bulk-reconciler opt-out.
 */
export async function upsertBoardCard(
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
  } else if (!opts.skipOrphanPurge) {
    // No previous sk: callers that omit it (legacy/add/metadata) can leave
    // orphan column#pos rows. Scan once and drop every sk except nextSk.
    // Brand-new creates pass skipOrphanPurge (createCardRecord).
    await purgeOtherBoardCardRows(node, cfg, nextBoard, slug, nextSk);
  }

  const write = async (fields: Record<string, unknown>) => {
    try {
      await node.updateRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    } catch (updateErr) {
      if (isCreatedByFieldMiss(updateErr)) throw updateErr;
      await node.createRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    }
  };

  try {
    await write(nextFields);
  } catch (err) {
    if (!isCreatedByFieldMiss(err)) throw err;
    const legacyFields = { ...nextFields };
    delete legacyFields.created_by;
    await write(legacyFields);
  }
}

export async function removeBoardCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  opts: BoardCardWriteOptions = {},
): Promise<void> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return;
  const board = card.board || "default";
  const sk = boardCardSk(card.column, card.position, card.slug);
  await deleteBoardCardSk(node, schemaHash, board, sk);
  // Also purge any orphan sks for the same slug (stale column membership).
  if (card.slug && !opts.skipOrphanPurge) {
    await purgeOtherBoardCardRows(node, cfg, board, card.slug, null);
  }
}

/**
 * One keyed BoardCards query (no body).
 * - board only → HashKey partition (all columns on that board)
 * - board + column → HashRangePrefix column# (server-side column pushdown)
 *
 * No HashKey + client-filter fallback when the prefix path fails. A broken
 * HashRangePrefix must surface as an error (or empty fields → empty list),
 * not silently degrade to a full partition scan that papers over the bug.
 *
 * `opts.fields` narrows the projection for a caller that does not render the
 * rows (see {@link BOARD_CARDS_DEP_SEED_FIELDS}). Narrowing is safe in both
 * directions here: fewer projected fields is strictly cheaper AND strictly
 * less droppable, because a row is returned only when every projected field
 * has an atom on it.
 */
export async function listBoardCardsPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
  opts?: { column?: string; fields?: readonly string[] },
): Promise<Card[] | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  const column = opts?.column?.trim();
  const projection = opts?.fields;
  // HashRangePrefix is a fold HashRangeFilter object; QueryFilter's TS type
  // is string-map only — cast at the edge (runtime accepts the object).
  const filter = (
    column && column.length > 0
      ? { HashRangePrefix: { hash: board, prefix: `${column}#` } }
      : { HashKey: board }
  ) as QueryFilter;
  let res;
  try {
    res = await node.queryAll({
      schemaHash,
      fields: [...(projection ?? BOARD_CARDS_FIELDS)],
      filter,
    });
  } catch (err) {
    // Schema drift only (created_by optional) — not a list-path fallback.
    if (!isCreatedByFieldMiss(err)) throw err;
    res = await node.queryAll({
      schemaHash,
      fields: [...(projection ?? LEGACY_BOARD_CARDS_FIELDS)].filter(
        (field) => field !== "created_by",
      ),
      filter,
    });
  }
  return res.results
    .map((r) => cardFromBoardCardFields(r.fields as Record<string, unknown>))
    .filter((c) => c.slug.length > 0)
    .filter((c) => !column || c.column === column);
}

/**
 * Every row in a board partition, projecting only {@link BOARD_CARDS_SPINE_FIELDS}.
 *
 * This is the drop-free read. `listBoardCardsPartition` projects all 24 fields
 * and silently loses any row missing one of them; this one cannot, because a
 * row that lacks a spine field could not have been keyed into the partition in
 * the first place. Use it wherever "did I see every row?" is the question.
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
    fields: [...BOARD_CARDS_SPINE_FIELDS],
    filter,
  });
  const out: BoardCardSpineRow[] = [];
  for (const r of res.results) {
    const f = r.fields as Record<string, unknown>;
    const sk = typeof f.sk === "string" ? f.sk : "";
    // `sk` is the authority for column/position/slug — the copied scalar
    // fields can drift, the range key cannot (it IS the row's address).
    const parsed = parseBoardCardSk(sk);
    const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
    if (slug.length === 0) continue;
    out.push({
      board: (typeof f.board === "string" && f.board) || board,
      sk,
      slug,
      column: parsed?.column ?? (typeof f.column === "string" ? f.column : ""),
      position: parsed?.position ?? String(f.position ?? ""),
    });
  }
  return out;
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
 */
export async function listAllBoardCards(
  node: NodeClient,
  cfg: Config,
  boards: Array<{ slug: string }>,
): Promise<Card[] | null> {
  if (!boardCardsHash(cfg)) return null;
  if (boards.length === 0) return [];
  const out: Card[] = [];
  const bySlug = new Map<string, Card>();
  for (const b of boards) {
    const part = await listBoardCardsPartition(node, cfg, b.slug);
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
