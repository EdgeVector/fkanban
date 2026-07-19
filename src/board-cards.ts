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
import type { NodeClient } from "./client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "./schemas.ts";
import type { Card } from "./record.ts";
import { toCardSummary, type CardSummary } from "./card-list-index.ts";

export { BOARD_CARDS_LAYOUT };

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
    updated_at: summary.updated_at,
    db: summary.db,
    repo: summary.repo,
    base: summary.base,
    kind: summary.kind,
    block_status: summary.block_status,
    block_reason: summary.block_reason,
    north_star: summary.north_star,
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
    updated_at: str("updated_at"),
    done_at: "",
    db: str("db"),
    repo: str("repo"),
    base: str("base"),
    kind: str("kind"),
    block_status: str("block_status"),
    block_reason: str("block_reason"),
    north_star: str("north_star"),
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

/**
 * Upsert thin BoardCards row. When board/column/position change, delete the
 * previous sk first (same-board move or board transfer). Always purges any
 * other rows for the same slug on the destination board so list cannot keep a
 * stale column membership after a successful card update.
 */
export async function upsertBoardCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous?: Card | CardSummary | null,
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
      await deleteBoardCardSk(node, schemaHash, prevBoard, prevSk);
    }
    // Board transfer: drop any leftover rows for this slug on the old board.
    if (prevBoard !== nextBoard && previous.slug) {
      await purgeOtherBoardCardRows(node, cfg, prevBoard, previous.slug, null);
    }
    // Column/position change: also purge any other sks on the next board
    // (covers multi-orphan rows left by older clients).
    if (prevSk !== nextSk || prevBoard !== nextBoard) {
      await purgeOtherBoardCardRows(node, cfg, nextBoard, slug, nextSk);
    }
  } else {
    // No previous sk: callers that omit it (legacy/add/metadata) can leave
    // orphan column#pos rows. Scan once and drop every sk except nextSk.
    await purgeOtherBoardCardRows(node, cfg, nextBoard, slug, nextSk);
  }

  try {
    await node.updateRecord({
      schemaHash,
      fields: nextFields,
      keyHash: nextBoard,
      rangeKey: nextSk,
    });
  } catch {
    await node.createRecord({
      schemaHash,
      fields: nextFields,
      keyHash: nextBoard,
      rangeKey: nextSk,
    });
  }
}

export async function removeBoardCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
): Promise<void> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return;
  const board = card.board || "default";
  const sk = boardCardSk(card.column, card.position, card.slug);
  await deleteBoardCardSk(node, schemaHash, board, sk);
  // Also purge any orphan sks for the same slug (stale column membership).
  if (card.slug) {
    await purgeOtherBoardCardRows(node, cfg, board, card.slug, null);
  }
}

/**
 * One keyed BoardCards query (no body).
 * - board only → HashKey partition (all columns on that board)
 * - board + column → HashRangePrefix column# (server-side column pushdown)
 */
export async function listBoardCardsPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
  opts?: { column?: string },
): Promise<Card[] | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  const column = opts?.column?.trim();
  try {
    // HashRangePrefix is a fold HashRangeFilter object; QueryFilter's TS type
    // is string-map only — cast at the edge (runtime accepts the object).
    const filter = (
      column && column.length > 0
        ? { HashRangePrefix: { hash: board, prefix: `${column}#` } }
        : { HashKey: board }
    ) as import("./client.ts").QueryFilter;
    const res = await node.queryAll({
      schemaHash,
      fields: [...BOARD_CARDS_FIELDS],
      filter,
    });
    return res.results
      .map((r) => cardFromBoardCardFields(r.fields as Record<string, unknown>))
      .filter((c) => c.slug.length > 0)
      .filter((c) => !column || c.column === column);
  } catch {
    // Prefix filter may be rejected on older Mini — fall back to full partition.
    if (column) {
      try {
        const res = await node.queryAll({
          schemaHash,
          fields: [...BOARD_CARDS_FIELDS],
          filter: { HashKey: board },
        });
        return res.results
          .map((r) => cardFromBoardCardFields(r.fields as Record<string, unknown>))
          .filter((c) => c.slug.length > 0 && c.column === column);
      } catch {
        return null;
      }
    }
    return null;
  }
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
