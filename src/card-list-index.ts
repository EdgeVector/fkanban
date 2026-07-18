// Body-free CardListIndex helpers — point-read/write the single `all_cards` row
// so list/pickup never full-scan the Card schema (design-lastdb-scan-deprecation-path).

import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
import { CARD_LIST_INDEX_FIELDS, CARD_LIST_INDEX_KEY } from "./schemas.ts";
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

export function cardListIndexHash(cfg: Config): string | null {
  const h = cfg.schemaHashes["card_list_index"];
  return h && h.length > 0 ? h : null;
}

export function toCardSummary(card: { slug: string; body?: string; [key: string]: unknown }): CardSummary {
  return { ...(card as CardSummary), body: "" };
}

export async function readCardListIndex(
  node: NodeClient,
  cfg: Config,
): Promise<CardSummary[] | null> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return null;
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...CARD_LIST_INDEX_FIELDS],
    filter: { HashKey: CARD_LIST_INDEX_KEY },
  });
  const row = res.results[0];
  if (!row) return null;
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) return [];
  try {
    const parsed = JSON.parse(raw) as unknown;
    return Array.isArray(parsed) ? (parsed as CardSummary[]) : [];
  } catch {
    return [];
  }
}

export async function writeCardListIndex(
  node: NodeClient,
  cfg: Config,
  cards: CardSummary[],
): Promise<void> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return;
  const fields = {
    key: CARD_LIST_INDEX_KEY,
    payload_json: JSON.stringify(cards),
    updated_at: new Date().toISOString(),
  };
  const existing = await readCardListIndex(node, cfg);
  // readCardListIndex returns [] when row missing vs null when schema missing
  // Use a keyed probe for create vs update:
  const probe = await node.queryAll({
    schemaHash: hash,
    fields: ["key"],
    filter: { HashKey: CARD_LIST_INDEX_KEY },
  });
  if (probe.results[0]) {
    await node.updateRecord({ schemaHash: hash, keyHash: CARD_LIST_INDEX_KEY, fields });
  } else {
    await node.createRecord({ schemaHash: hash, keyHash: CARD_LIST_INDEX_KEY, fields });
  }
  void existing;
}

export async function patchCardListIndex(
  node: NodeClient,
  cfg: Config,
  card: { slug: string; body?: string; [key: string]: unknown },
  mode: "upsert" | "remove",
): Promise<void> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return;
  const current = (await readCardListIndex(node, cfg)) ?? [];
  const without = current.filter((c) => c.slug !== card.slug);
  const next =
    mode === "remove" ? without : [...without, toCardSummary(card)].sort((a, b) =>
      a.slug.localeCompare(b.slug),
    );
  await writeCardListIndex(node, cfg, next);
}
