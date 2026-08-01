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
 * Narrowing here is also *less* droppable than the wide read it replaces, so
 * the footer count can only get more accurate — but the rule is narrower than
 * it reads. Measured 2026-08-01 (`scripts/probe-projection-rule-regression.ts`):
 * on THIS index a projected field with sparse atoms does drop rows (351 -> 332
 * when `milestone` is added), but on `MilestoneCards` the same shape returns a
 * PARTIAL row instead, and on `BoardMilestones` a field no row has drops
 * nothing at all. Narrowing is still right here; do not carry the rule to
 * another index without measuring that index.
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
  // Orphan purge only needs spine identity (slug + sk components) — not the
  // 24-field wide projection that list pays for display.
  const part = await listBoardCardsPartition(node, cfg, board, {
    fields: BOARD_CARDS_SPINE_FIELDS,
  });
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
 * Read exactly one BoardCards row, keyed by its full sk, at the WIDE
 * projection — and treat "not returned" as "not writable narrowly".
 *
 * This is the safety gate for the narrow write path, and it works because of
 * a LastDB projection rule that is normally a hazard: a query returns a row
 * only when EVERY projected field has an atom on it (see
 * {@link BOARD_CARDS_SPINE_FIELDS}). So asking for all 24 fields answers both
 * questions a narrow write must have answered, in one round trip:
 *
 *   - does the row exist?  (a narrow `updateRecord` against a MISSING row does
 *     not fail — measured 2026-07-31, `scripts/probe-narrow-write-shape.ts`:
 *     it silently succeeds and stores just the subset it was handed, creating
 *     a row that every wide reader then drops)
 *   - is it whole?  (an incomplete row must be repaired by a wide write, not
 *     patched by a narrow one that leaves the hole in place)
 *
 * A `null` return means "one of those is false" without distinguishing them —
 * deliberately, because the caller's response to both is the same: write wide.
 *
 * Measured cost on the live `default` board: 207ms median at 24 fields
 * (`scripts/probe-boardcard-point-read.ts`). Projection width barely moves a
 * single-row read — the 5-field spine measured 189ms — so there is no cheaper
 * variant of this check worth having.
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

function sameBoardCardValue(a: unknown, b: unknown): boolean {
  if (Array.isArray(a) || Array.isArray(b)) {
    const xs = Array.isArray(a) ? a : [];
    const ys = Array.isArray(b) ? b : [];
    return xs.length === ys.length && xs.every((x, i) => x === ys[i]);
  }
  return a === b;
}

/**
 * The subset of `next` that differs from what is stored.
 *
 * Key fields are NOT re-sent: `board`/`sk` address the row (they travel as
 * keyHash/rangeKey) and cannot differ here — this path only runs when the sk
 * is unchanged. Measured, a narrow update with the key fields omitted is
 * accepted and leaves them intact.
 */
function changedBoardCardFields(
  stored: Record<string, unknown>,
  next: Record<string, unknown>,
  projected: readonly string[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of projected) {
    if (field === "board" || field === "sk") continue;
    if (!(field in next)) continue;
    if (sameBoardCardValue(stored[field], next[field])) continue;
    out[field] = next[field];
  }
  return out;
}

export type BoardCardWriteOptions = {
  /**
   * Skip the pre-write probe read and write the full 24-field shape.
   *
   * Two callers can justify this, for opposite reasons:
   *
   * - `createCardRecord` — the sk was just minted, so there is nothing to diff
   *   against and the probe could only ever return "absent".
   * - `board-cards-heal` — restoring the whole row IS the job, and it has
   *   already enumerated the partition. A probe read here would reintroduce
   *   the per-card re-read that `board-cards heal read cost` exists to forbid.
   *
   * Anything else should let the probe decide: it is one 207ms read that turns
   * a ~4.7s write into a ~0.6s one and rules out writing a hole into the row.
   */
  wideWrite?: boolean;
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
 * ## Why this reads before it writes
 *
 * Write cost scales with the number of fields SENT, not the number that
 * changed, and BoardCards has 24 of them. Measured on the live primary,
 * one uncontended row (`scripts/probe-partial-write-cost.ts`):
 *
 * | update | ms |
 * |---|---|
 * | 24 fields, every value changed | 5376 |
 * | 24 fields sent, 2 actually changed (what a `tag` used to cost) | 4695 |
 * | 4 fields sent, 2 changed | 1197 |
 * | 24 fields, every value byte-identical | 140 |
 *
 * The last row is the surprise, and it is what makes the rest actionable:
 * LastDB *does* skip a write whose values all match — but that skip is
 * whole-record, not per-molecule. Change one field of twenty-four and the
 * node pays for all twenty-four. So the only lever an app has is to stop
 * sending fields it is not changing.
 *
 * A metadata write (tag / claim / pr_url / block_status) changes two or three
 * fields. Reading the row first costs 207ms and turns a ~4.7s wide upsert into
 * a ~0.6s narrow one — and, because the read doubles as an existence-and-
 * wholeness check, the narrow path is also strictly safer than writing blind
 * (see {@link readWholeBoardCardRow}).
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

  // Narrow path: send only what changed. Skipped for a row we know is new
  // (nothing to diff against) and for a move, whose destination sk is a row
  // that does not exist yet and must therefore be written whole.
  const movedHere = Boolean(previous) &&
    (String(previous?.board || "default") !== nextBoard ||
      boardCardSk(previous!.column, previous!.position, previous!.slug) !== nextSk);
  if (!opts.wideWrite && !movedHere) {
    const stored = await readWholeBoardCardRow(node, cfg, nextBoard, nextSk);
    if (stored) {
      const changed = changedBoardCardFields(stored.fields, nextFields, stored.projected);
      // Nothing changed: the node would no-op this in ~140ms, but a round trip
      // we can prove is pointless is a round trip not worth taking. The row is
      // already correct and durable, so its superseded siblings can still go.
      if (Object.keys(changed).length === 0) {
        await retireSupersededRows();
        return;
      }
      await write(changed);
      await retireSupersededRows();
      return;
    }
    // Row absent or missing an atom on some field. Fall through: the wide
    // write below both creates it and heals the hole. Narrowing here would
    // leave an incomplete row that every wide reader silently drops.
  }

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
  const out: BoardCardSpineRow[] = [];
  for (const r of res.results) {
    const f = r.fields as Record<string, unknown>;
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
 */
export async function listAllBoardCards(
  node: NodeClient,
  cfg: Config,
  boards: Array<{ slug: string }>,
  opts?: { fields?: readonly string[] },
): Promise<Card[] | null> {
  if (!boardCardsHash(cfg)) return null;
  if (boards.length === 0) return [];
  const projection = opts?.fields ?? BOARD_CARDS_LIST_FIELDS;
  const out: Card[] = [];
  const bySlug = new Map<string, Card>();
  for (const b of boards) {
    const part = await listBoardCardsPartition(node, cfg, b.slug, { fields: projection });
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
