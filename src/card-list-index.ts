// Body-free CardListIndex helpers — point-read/write index rows so list/pickup
// never full-scan Card/Board schemas (design-lastdb-scan-deprecation-path).
//
// Same private Hash schema (fkanban/CardListIndex), two keys:
//   all_cards  — body-free card summaries  (RETIRED where BoardCards exists)
//   all_boards — board summaries           (live; bounded by board count)
//
// `all_cards` is a single Hash row holding EVERY card, rewritten in full on
// every card mutation. BoardCards (HashRange, hash=board, range=column#pos#slug)
// carries the same body-free summary one row per card and is the primary read
// path everywhere — so on any node with a `board_cards` hash `all_cards` is a
// redundant second copy, and a strictly worse one:
//
//   - Unbounded. Measured 2026-07-28 on the primary: 271,954 B and +1.9 KB/h,
//     ~5.5 days from the raised 512 KiB atom ceiling. Crossing it half-commits
//     (Card lands, index patch rejected).
//   - Leaky. 15 of its 323 entries had no Card record at all — deleted cards it
//     never dropped. It only ever grows.
//   - Lost-update prone. `patchCardListIndex` is a read-modify-write of the
//     whole document with no CAS, so two concurrent mutations silently drop one
//     of the two edits (card fkanban-consistency-board-concurrent-lost-write).
//   - Staler than the thing it shadows. Where the two disagreed, BoardCards was
//     right and `all_cards` was behind.
//
// So the write is retired rather than migrated to HashRange: BoardCards already
// IS the HashRange index a migration would have built. Reads still dual-read
// `all_cards` while it holds entries, so a node without BoardCards is unchanged
// and a retired-but-uncleared index degrades to "no extra rows found".
// `groom card-list-index-retire` clears the payload once coverage is proven.

import type { Config } from "./config.ts";
import { FkanbanError, type NodeClient } from "./client.ts";
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
  milestone?: string;
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

/**
 * True when BoardCards supersedes the `all_cards` rollup on this node, i.e. the
 * card write path must stop rewriting the mega-document.
 *
 * Read directly from `cfg` rather than importing `boardCardsHash` — board-cards
 * imports `toCardSummary` from this module, and a cycle here would be evaluated
 * during config load.
 */
export function cardListIndexIsSuperseded(cfg: Config): boolean {
  const h = cfg.schemaHashes?.["board_cards"];
  return typeof h === "string" && h.length > 0;
}

export function toCardSummary(card: { slug: string; body?: string; [key: string]: unknown }): CardSummary {
  return { ...(card as CardSummary), body: "" };
}

/**
 * One index row: the parsed entries plus the exact `payload_json` string they
 * were parsed from. The raw string is the CAS witness for a read-modify-write
 * patch — exact, and (unlike `updated_at`) immune to two writes landing inside
 * the same millisecond.
 *
 * `raw === null` means the row does not exist.
 */
type IndexRow<T> = { entries: T[] | null; raw: string | null };

async function readIndexRow<T>(node: NodeClient, cfg: Config, key: string): Promise<IndexRow<T>> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return { entries: null, raw: null };
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...CARD_LIST_INDEX_FIELDS],
    filter: { HashKey: key },
  });
  const row = res.results[0];
  if (!row) return { entries: null, raw: null };
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) {
    return { entries: [], raw: typeof raw === "string" ? raw : null };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { entries: Array.isArray(parsed) ? (parsed as T[]) : [], raw };
  } catch {
    return { entries: [], raw };
  }
}

async function readIndexPayload<T>(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<T[] | null> {
  return (await readIndexRow<T>(node, cfg, key)).entries;
}

async function writeIndexPayload(
  node: NodeClient,
  cfg: Config,
  key: string,
  payload: unknown[],
  /**
   * CAS witness for the update branch: the `payload_json` string this payload
   * was computed from. When provided and the stored payload has changed since,
   * the node rejects with `cas_conflict` instead of silently dropping the other
   * writer's edit. Omit for rewrites derived from truth rather than from the row
   * being overwritten (seed / reconciler / clear) — those are meant to win.
   */
  expectRaw?: string | null,
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
    await node.updateRecord({
      schemaHash: hash,
      keyHash: key,
      fields,
      ...(typeof expectRaw === "string"
        ? { expected: { type: "value" as const, field: "payload_json", value: expectRaw } }
        : {}),
    });
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
  // Never re-inflate a retired index — the full-scan seed path also lands here.
  if (cardListIndexIsSuperseded(cfg)) return;
  await writeIndexPayload(node, cfg, CARD_LIST_INDEX_KEY, cards);
}

/** Clear the `all_cards` payload. Only `groom card-list-index-retire` calls this. */
export async function clearCardListIndex(node: NodeClient, cfg: Config): Promise<void> {
  if (!cardListIndexHash(cfg)) return;
  await writeIndexPayload(node, cfg, CARD_LIST_INDEX_KEY, []);
}

export async function patchCardListIndex(
  node: NodeClient,
  cfg: Config,
  card: { slug: string; body?: string; [key: string]: unknown },
  mode: "upsert" | "remove",
): Promise<void> {
  if (!cardListIndexHash(cfg)) return;
  // BoardCards is authoritative here: skip the read-modify-write of the whole
  // rollup. This is the write that made the document unbounded — one card
  // mutation rewrote ~272 KB to change a few bytes.
  if (cardListIndexIsSuperseded(cfg)) return;
  const current = (await readCardListIndex(node, cfg)) ?? [];
  const without = current.filter((c) => c.slug !== card.slug);
  const next =
    mode === "remove"
      ? without
      : [...without, toCardSummary(card)].sort((a, b) => a.slug.localeCompare(b.slug));
  await writeIndexPayload(node, cfg, CARD_LIST_INDEX_KEY, next);
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

/** How many times a losing CAS patch re-reads and re-applies before giving up. */
const BOARD_LIST_PATCH_ATTEMPTS = 4;

/**
 * Add/remove one board in `all_boards`.
 *
 * `all_boards` is the last surviving single-row rollup in kanban (the `all_cards`
 * one was retired — see the header). It is bounded by board count, so it does not
 * have the atom-ceiling problem, but a whole-document read-modify-write is still
 * lost-update prone: two concurrent board writes both read the same payload and
 * the second silently drops the first. For a *board* the blast radius is worse
 * than for a card — `listBoards` drives which BoardCards partitions `kanban list`
 * queries at all, so a board dropped here makes **every card on it invisible to
 * list** while `show <slug>` still works.
 *
 * So the patch is CAS'd on the exact payload it read, and retries on conflict.
 * A conflict means someone else committed a different edit, not that ours is
 * wrong — re-read and re-apply. `groom board-list-heal` repairs anything that
 * still slips through (a crash between the Board write and this patch).
 */
export async function patchBoardListIndex(
  node: NodeClient,
  cfg: Config,
  board: BoardSummary,
  mode: "upsert" | "remove",
): Promise<void> {
  if (!cardListIndexHash(cfg)) return;
  for (let attempt = 1; ; attempt += 1) {
    const { entries, raw } = await readIndexRow<BoardSummary>(node, cfg, BOARD_LIST_INDEX_KEY);
    const current = entries ?? [];
    const without = current.filter((b) => b.slug !== board.slug);
    const next =
      mode === "remove"
        ? without
        : [...without, board].sort((a, b) => a.slug.localeCompare(b.slug));
    try {
      await writeIndexPayload(node, cfg, BOARD_LIST_INDEX_KEY, next, raw);
      return;
    } catch (err) {
      const conflict = err instanceof FkanbanError && err.code === "cas_conflict";
      if (!conflict || attempt >= BOARD_LIST_PATCH_ATTEMPTS) throw err;
      // Someone else's board edit landed first. Re-read and re-apply ours.
    }
  }
}
