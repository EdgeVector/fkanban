// BoardCards HashRange helpers — Dynamo-style membership: hash=board,
// range=column#position#slug. Thin projection only (no body).
//
// List/pickup: one partition query per board (filter HashKey=board).
// Move on same board: delete old sk + put new sk.
// Show: still Card HashKey(slug) for body — never hydrate body on list.

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

/**
 * Upsert thin BoardCards row. When board/column/position change, delete the
 * previous sk first (same-board move or board transfer).
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

  if (previous) {
    const prevBoard = previous.board || "default";
    const prevSk = boardCardSk(previous.column, previous.position, previous.slug);
    if (prevBoard !== nextBoard || prevSk !== nextSk) {
      try {
        await node.deleteRecord({
          schemaHash,
          keyHash: prevBoard,
          rangeKey: prevSk,
        });
      } catch {
        // best-effort: stale sk may already be gone
      }
    }
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
  try {
    await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: sk });
  } catch {
    // best-effort
  }
}

/** One partition query: all thin cards on a board (no body). */
export async function listBoardCardsPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
): Promise<Card[] | null> {
  const schemaHash = boardCardsHash(cfg);
  if (!schemaHash) return null;
  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [...BOARD_CARDS_FIELDS],
      filter: { HashKey: board },
    });
    return res.results
      .map((r) => cardFromBoardCardFields(r.fields as Record<string, unknown>))
      .filter((c) => c.slug.length > 0);
  } catch {
    return null;
  }
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
  const seen = new Set<string>();
  for (const b of boards) {
    const part = await listBoardCardsPartition(node, cfg, b.slug);
    if (part === null) return null; // schema missing or query failed → caller falls back
    for (const c of part) {
      if (seen.has(c.slug)) continue;
      seen.add(c.slug);
      out.push(c);
    }
  }
  return out;
}
