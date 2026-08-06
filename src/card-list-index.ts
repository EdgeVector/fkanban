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
 * `entries === null` means the payload could not be read. That is NOT the same
 * as the row being absent, which is what `present` answers — see `readIndexRow`.
 */
type IndexRow<T> = { entries: T[] | null; raw: string | null; present: boolean };

/**
 * The one field this row's readers actually consume.
 *
 * The read used to project all three of `CARD_LIST_INDEX_FIELDS`; `key` is the
 * filter, not a result, and `updated_at` is never looked at. Width is not free
 * here and it is not only a cost: a projection is a filter under HASH-ELSE-LEAD
 * (gate = hash field when projected, else leading field — see
 * `test/fake-node.ts`). Extra projected fields are not free; on indexes whose
 * live hash is a sparse multi-key expand field they can hide load-bearing rows
 * (BoardCards 2026-07-23: one unbackfilled gate field hid 135 rows from every
 * wide read). Asking for three fields to use one bought three ways to
 * disappear instead of one, in exchange for nothing. Do not reassert the
 * superseded `any_missing` model ("EVERY projected field has an atom") as
 * current node truth.
 */
const INDEX_PAYLOAD_FIELDS = ["payload_json"] as const;

/**
 * Read one rollup row.
 *
 * A projected read may SUPPLY a payload; it may not establish that the row is
 * ABSENT. When the payload does not come back, this asks the minimal keyed
 * question — the same `["key"]` existence probe `writeIndexPayload` uses to
 * choose create-vs-update — and reports the answer as `present`, so callers can
 * tell "there is no row" from "there is a row I could not read".
 *
 * That distinction is load-bearing rather than pedantic. `all_boards` decides
 * which BoardCards partitions `kanban list` queries at all, and the CAS witness
 * that protects it (`raw`) is DERIVED FROM THIS READ — so a read that fails to
 * return the row loses the data and simultaneously disarms the guard that would
 * have caught the loss. Both safety properties fail from the one cause.
 *
 * The probe costs an extra read only on the path where the payload was already
 * unreadable — never on the hot `listBoards` path, which gets its row back on
 * the first query.
 */
async function readIndexRow<T>(node: NodeClient, cfg: Config, key: string): Promise<IndexRow<T>> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return { entries: null, raw: null, present: false };
  const res = await node.queryAll({
    schemaHash: hash,
    fields: [...INDEX_PAYLOAD_FIELDS],
    filter: { HashKey: key },
  });
  const row = res.results[0];
  if (!row) return { entries: null, raw: null, present: await rowExists(node, hash, key) };
  const raw = (row.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw !== "string" || raw.length === 0) {
    return { entries: [], raw: typeof raw === "string" ? raw : null, present: true };
  }
  try {
    const parsed = JSON.parse(raw) as unknown;
    return { entries: Array.isArray(parsed) ? (parsed as T[]) : [], raw, present: true };
  } catch {
    return { entries: [], raw, present: true };
  }
}

/** Minimal keyed existence question: one field, so nothing else can drop the row. */
async function rowExists(node: NodeClient, hash: string, key: string): Promise<boolean> {
  const probe = await node.queryAll({ schemaHash: hash, fields: ["key"], filter: { HashKey: key } });
  return probe.results[0] !== undefined;
}

async function readIndexPayload<T>(
  node: NodeClient,
  cfg: Config,
  key: string,
): Promise<T[] | null> {
  return (await readIndexRow<T>(node, cfg, key)).entries;
}

/**
 * What a read-modify-write caller SAW, and therefore what it is willing to
 * overwrite. Three states, because two are not enough:
 *
 *  - `{ kind: "value", raw }` — the payload this write was computed from.
 *  - `{ kind: "absent" }`     — the row was ABSENT when this write was computed.
 *  - `undefined`              — no witness: a rewrite derived from truth rather
 *                               than from the row (seed / reconciler / clear),
 *                               which is meant to win.
 *
 * The middle state is the one that used to be missing. A patch that read an
 * absent row and a truth-rewrite both arrived as "no witness", so the create
 * branch sent no precondition, and `patchBoardListIndex`'s entire lost-update
 * protection — CAS plus a retry loop — was update-only. On an unseeded
 * `all_boards`, concurrent writers all read absent, all created a one-element
 * payload, and last write won with no `cas_conflict` for the retry loop to catch.
 */
type IndexWitness = { kind: "value"; raw: string } | { kind: "absent" };

async function writeIndexPayload(
  node: NodeClient,
  cfg: Config,
  key: string,
  payload: unknown[],
  witness?: IndexWitness,
): Promise<void> {
  const hash = cardListIndexHash(cfg);
  if (!hash) return;
  const fields = {
    key,
    payload_json: JSON.stringify(payload),
    updated_at: new Date().toISOString(),
  };

  // With a witness the PRECONDITION decides the outcome, so the create-vs-update
  // probe is not just unnecessary, it is a liability: it is a second read, and
  // anything that changes between it and the write is exactly the race being
  // guarded. Measured on the node (fold `fold_db` core, 2026-08-06):
  // `MutationType::Create` is never handled distinctly from `Update` on the
  // write path — both are upserts — so the branch choice cannot decide
  // correctness on its own, and the expectation can.
  //
  // `absent` matches a missing head AND a tombstoned one (fold
  // `schema/types/cas.rs`), so a row deleted between read and write still
  // satisfies the precondition it was computed under.
  if (witness) {
    const expected =
      witness.kind === "value"
        ? ({ type: "value" as const, field: "payload_json", value: witness.raw })
        : ({ type: "absent" as const, field: "payload_json" });
    const write = witness.kind === "value" ? node.updateRecord : node.createRecord;
    await write.call(node, { schemaHash: hash, keyHash: key, fields, expected });
    return;
  }

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

/**
 * `readBoardListIndex` plus whether the ROW exists at all.
 *
 * `groom board-list-heal` needs both halves and they mean opposite things: an
 * absent row is NOT drift (`listBoards` re-seeds it from Board truth, and
 * writing one here would only race that seed), while a row that is present with
 * an unreadable payload is precisely the drift heal exists to repair — nothing
 * else will, because the re-seed only fires when the row is missing.
 */
export async function readBoardListIndexRow(
  node: NodeClient,
  cfg: Config,
): Promise<{ entries: BoardSummary[] | null; present: boolean }> {
  const { entries, present } = await readIndexRow<BoardSummary>(node, cfg, BOARD_LIST_INDEX_KEY);
  return { entries, present };
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
    const { entries, raw, present } = await readIndexRow<BoardSummary>(node, cfg, BOARD_LIST_INDEX_KEY);
    if (entries === null && present) {
      // The row is THERE and its payload did not come back. Treating that as an
      // empty rollup would rebuild `all_boards` from nothing and write it with
      // no CAS witness (`raw` is null, so the `expected` precondition below is
      // omitted) — one board would survive and every other board's cards would
      // vanish from `kanban list`.
      //
      // Refusing leaves the damage repairable instead of compounding it, which
      // is the trade `board rm` already states at commands/board.ts:195: a
      // visible ghost beats a live board that silently disappears.
      throw new FkanbanError({
        code: "index_unreadable",
        message:
          `all_boards exists but its payload could not be read — refusing to rebuild the ` +
          `board rollup from an empty base. Repair it with \`kanban groom board-list-heal --apply\`.`,
      });
    }
    const current = entries ?? [];
    const without = current.filter((b) => b.slug !== board.slug);
    const next =
      mode === "remove"
        ? without
        : [...without, board].sort((a, b) => a.slug.localeCompare(b.slug));
    // The witness states what this patch was computed FROM, so the node can
    // refuse it if that stopped being true. `raw === null` with `present` is the
    // row-exists-but-yielded-nothing case the refusal above already covers for
    // the readable path and which carries no usable witness either way; only a
    // genuinely ABSENT row licenses the create-if-absent precondition.
    const witness: IndexWitness | undefined =
      raw !== null ? { kind: "value", raw } : present ? undefined : { kind: "absent" };
    try {
      await writeIndexPayload(node, cfg, BOARD_LIST_INDEX_KEY, next, witness);
      return;
    } catch (err) {
      const conflict = err instanceof FkanbanError && err.code === "cas_conflict";
      if (!conflict || attempt >= BOARD_LIST_PATCH_ATTEMPTS) throw err;
      // Someone else's board edit landed first. Re-read and re-apply ours.
    }
  }
}
