// Body-free CardListIndex helpers — point-read/write index rows so list/pickup
// never full-scan Card/Board schemas (design-lastdb-scan-deprecation-path).
//
// Same private Hash schema (fkanban/CardListIndex), two keys:
//   all_cards  — body-free card summaries
//   all_boards — board summaries

import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
import { CARD_LIST_INDEX_FIELDS, CARD_LIST_INDEX_KEY } from "./schemas.ts";

export { CARD_LIST_INDEX_KEY, CARD_LIST_INDEX_FIELDS };
export const BOARD_LIST_INDEX_KEY = "all_boards";

export type CardSummary = {
  slug: string;
  title: string;
  body: "";
  board: string;
  column: string;
  position: string;
  assignee: string;
  tags: string[];
  deps: string[];
  surfaces: string[];
  created_at: string;
  created_by?: string;
  updated_at: string;
  db: string;
  repo: string;
  base: string;
  kind: string;
  block_status: string;
  block_reason: string;
  north_star: string;
  pr_url: string;
  branch: string;
  [key: string]: unknown;
};

export type BoardSummary = {
  slug: string;
  title: string;
  body: string;
  columns: string[];
  created_at: string;
  updated_at: string;
};

export function cardListIndexHash(cfg: Config): string | null {
  const h = cfg.schemaHashes["card_list_index"];
  return h && h.length > 0 ? h : null;
}

export function toCardSummary(card: { slug: string; body?: string; [key: string]: unknown }): CardSummary {
  return { ...(card as CardSummary), body: "" };
}

async function readIndexPayload<T>(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<T[] | null> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return null;
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...CARD_LIST_INDEX_FIELDS],
    filter: { HashKey: key },
  });
  const row = res.results[0];
  if (!row) return null;
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

async function writeIndexPayload(
  node: NodeClient,
  cfg: Config,
  key: string,
  payload: unknown[],
): Promise<void> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return;
  const fields = {
    key,
    payload_json: JSON.stringify(payload),
    updated_at: new Date().toISOString(),
  };
  const probe = await node.queryAll({
    schemaHash: hash,
    fields: ["key"],
    filter: { HashKey: key },
  });
  if (probe.results[0]) {
    await node.updateRecord({ schemaHash: hash, keyHash: key, fields });
  } else {
    await node.createRecord({ schemaHash: hash, keyHash: key, fields });
  }
}

export async function readCardListIndex(
  node: NodeClient,
  cfg: Config,
): Promise<CardSummary[] | null> {
  return readIndexPayload<CardSummary>(node, cfg, CARD_LIST_INDEX_KEY);
}

export async function writeCardListIndex(
  node: NodeClient,
  cfg: Config,
  cards: CardSummary[],
): Promise<void> {
  await writeIndexPayload(node, cfg, CARD_LIST_INDEX_KEY, cards);
}

export async function patchCardListIndex(
  node: NodeClient,
  cfg: Config,
  card: { slug: string; body?: string; [key: string]: unknown },
  mode: "upsert" | "remove",
): Promise<void> {
  if (!cardListIndexHash(cfg)) return;
  const current = (await readCardListIndex(node, cfg)) ?? [];
  const without = current.filter((c) => c.slug !== card.slug);
  const next =
    mode === "remove"
      ? without
      : [...without, toCardSummary(card)].sort((a, b) => a.slug.localeCompare(b.slug));
  await writeCardListIndex(node, cfg, next);
}

export async function readBoardListIndex(
  node: NodeClient,
  cfg: Config,
): Promise<BoardSummary[] | null> {
  return readIndexPayload<BoardSummary>(node, cfg, BOARD_LIST_INDEX_KEY);
}

export async function writeBoardListIndex(
  node: NodeClient,
  cfg: Config,
  boards: BoardSummary[],
): Promise<void> {
  await writeIndexPayload(node, cfg, BOARD_LIST_INDEX_KEY, boards);
}

export async function patchBoardListIndex(
  node: NodeClient,
  cfg: Config,
  board: BoardSummary,
  mode: "upsert" | "remove",
): Promise<void> {
  if (!cardListIndexHash(cfg)) return;
  const current = (await readBoardListIndex(node, cfg)) ?? [];
  const without = current.filter((b) => b.slug !== board.slug);
  const next =
    mode === "remove"
      ? without
      : [...without, board].sort((a, b) => a.slug.localeCompare(b.slug));
  await writeBoardListIndex(node, cfg, next);
}
