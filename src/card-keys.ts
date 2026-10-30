// Named Card keys return the source record's values. They hold no separate payload copy.
import { FkanbanError, type NodeClient, type QueryFilter } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import { keyRows, primaryProjection, requireMultiKey } from "./multi-key.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "./concurrency.ts";
import { CARD_FIELDS } from "./schemas.ts";
import { BODY_OMITTED, rowToCard, type Card } from "./record.ts";

const addressFields = ["slug", "board", "column", "position"] as const;
export const CARD_KEY_FOOTER_FIELDS = [...addressFields, "tags"] as const;
export const CARD_KEY_LIST_FIELDS = CARD_FIELDS.filter(field => !["body", "db"].includes(field));

export function cardKeyProjection(fields: readonly string[]): string[] {
  const allowed = new Set<string>(CARD_FIELDS);
  return primaryProjection(fields).filter(field => field !== "body" && allowed.has(field));
}

export async function listCardsByMilestoneKey(
  node: NodeClient, cfg: Config, milestone: string, fields: readonly string[] = CARD_KEY_LIST_FIELDS,
): Promise<Card[]> {
  requireMultiKey(cfg);
  if (!milestone.trim()) return [];
  const rows = await keyRows(node, schemaHashFor("card", cfg), "by_milestone", { HashKey: milestone },
    cardKeyProjection([...fields, "milestone"]));
  return rows.map(row => {
    const card = rowToCard(row);
    if (card.slug !== row.key.hash || card.milestone !== milestone || row.matched_key.hash !== milestone) {
      throw new FkanbanError({ code: "card_key_mismatch", message: "The milestone key returned a record outside its requested membership." });
    }
    card[BODY_OMITTED] = true;
    return card;
  });
}

export async function listCardsByBoardKey(
  node: NodeClient, cfg: Config, board: string,
  opts?: { column?: string; excludeColumn?: string; fields?: readonly string[] },
): Promise<Card[]> {
  requireMultiKey(cfg);
  const filters = opts?.column
    ? [{ HashRangePrefix: { hash: board, prefix: opts.column + "#" } }]
    : opts?.excludeColumn
      ? [{ HashRangeRange: { hash: board, start: "", end: opts.excludeColumn + "#" } },
        { HashRangeRange: { hash: board, start: opts.excludeColumn + "$", end: "￿" } }]
      : [{ HashKey: board }];
  const pages = await Promise.all(filters.map(filter => keyRows(node, schemaHashFor("card", cfg), "by_board",
    filter as unknown as QueryFilter, cardKeyProjection(opts?.fields ?? CARD_KEY_LIST_FIELDS))));
  return pages.flat().map(row => {
    const card = rowToCard(row);
    if (card.slug !== row.key.hash || card.board !== board || row.matched_key.hash !== board
      || (opts?.column && card.column !== opts.column) || (opts?.excludeColumn && card.column === opts.excludeColumn)) {
      throw new FkanbanError({ code: "card_key_mismatch", message: "The board key returned a record outside its requested scope." });
    }
    card[BODY_OMITTED] = true;
    return card;
  });
}

export async function listCardsByBoardKeys(
  node: NodeClient, cfg: Config, boards: Array<{ slug: string; columns?: readonly string[] }>,
  opts?: { fields?: readonly string[]; skipTerminalColumn?: boolean; column?: string },
): Promise<Card[]> {
  requireMultiKey(cfg);
  const parts = await mapWithConcurrency(boards, board => listCardsByBoardKey(node, cfg, board.slug, {
    fields: opts?.fields,
    ...(opts?.column ? { column: opts.column } : {}),
    ...(opts?.skipTerminalColumn && board.columns?.length
      ? { excludeColumn: board.columns[board.columns.length - 1] } : {}),
  }), PARTITION_READ_CONCURRENCY);
  const bySlug = new Map<string, Card>();
  for (const card of parts.flat()) {
    const previous = bySlug.get(card.slug);
    if (!previous || card.updated_at > previous.updated_at) bySlug.set(card.slug, card);
  }
  return [...bySlug.values()];
}
