// MilestoneCards HashRange helpers — Dynamo-style reverse membership:
// hash=milestone, range=column#position#slug. Thin projection (no body).
//
// Detail/reconcile: one partition query per milestone.
// Empty milestone field → no row (remove prior if cleared).

import type { Config } from "./config.ts";
import type { NodeClient, QueryFilter, QueryRow } from "./client.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "./concurrency.ts";
import { MILESTONE_CARDS_FIELDS, MILESTONE_CARDS_LAYOUT } from "./schemas.ts";
import type { Card } from "./record.ts";
import { toCardSummary, type CardSummary } from "./card-list-index.ts";
// boardCardSk / parseBoardCardSk are pure — safe to import without cycle.
import { boardCardSk, parseBoardCardSk, upsertBoardCard } from "./board-cards.ts";

export { MILESTONE_CARDS_LAYOUT };

/**
 * A MilestoneCards row reduced to what identifies and addresses it.
 *
 * `sk` here is the row's REAL range key, not the payload copy of it.
 */
export type MilestoneCardRow = {
  milestone: string;
  sk: string;
  slug: string;
  column: string;
  position: string;
};

/**
 * The narrowest useful projection: everything else this index needs to be
 * addressed is carried by the range key. See
 * {@link listMilestoneCardsPartitionSpine} for why the partition key is not here.
 */
export const MILESTONE_CARDS_ADDRESS_FIELDS = ["slug"] as const;

/**
 * The payload projection for a read that already knows the partition it is in.
 *
 * `MILESTONE_CARDS_FIELDS` leads with `milestone`, the HASH field, and the node
 * gates a row on the hash field whenever the hash field is projected — wherever
 * it sits in the list. So the read that serves `milestone detail`,
 * `milestone reconcile` and every milestone rollup was returning only the rows
 * whose payload copy of the partition key had persisted, and a row that lost
 * that one atom was invisible to all of them.
 *
 * ## The rule, measured rather than assumed
 *
 * The repo shipped three read paths on "a row is returned iff the field LEADING
 * the projection has an atom on it". That is not the node's rule. Measured on
 * the live primary 2026-08-04 against four constructed rows with known atom
 * sets (`scripts/probe-projection-rule-constructed.ts`, 51 projections x 4
 * rows, 95 rule-discriminating judgements):
 *
 *     LEAD            191 correct / 13 wrong
 *     ANY             173 / 31
 *     LEAD+KEY        193 / 11
 *     HASH-ELSE-LEAD  204 / 0
 *
 * **HASH-ELSE-LEAD**: if the projection contains the hash field, the row is
 * gated on the HASH field; otherwise it is gated on the LEADING field. Each of
 * the other candidates dies on a concrete counterexample — `[slug,milestone]`
 * dropped a row carrying `slug` (not LEAD), `[title,kind]` returned a row
 * missing `kind` (not ANY), `[slug,sk]` returned a row missing `sk` (the
 * range-key copy does not gate at all), and `[title,milestone]` returned a row
 * missing `title` (an absent lead does not drop a row when the hash field is
 * present to gate it instead).
 *
 * The practical consequence is the whole reason this constant exists: **the
 * gate cannot be moved by reordering, only by removing.** An earlier attempt
 * simply re-led the wide read with `slug` and recovered nothing
 * (`scripts/probe-milestone-detail-lead-drop.ts`), because `milestone` was
 * still in the list and still gating. Dropping it moves the gate to `slug` —
 * the same field {@link listMilestoneCardsPartitionSpine} is gated on, so the
 * wide read and the address read now agree on the row set by construction
 * rather than by luck.
 *
 * Nothing is lost by removing it: the partition key is the caller's own filter
 * argument, so it is stamped back on in
 * {@link cardFromMilestoneCardFields}'s caller rather than read from a payload
 * copy that may not have persisted. This is the same argument the spine read
 * has made since 2026-08-01 — it is only now applied to the read that displays
 * the rows as well as the one that addresses them.
 */
export const MILESTONE_CARDS_PAYLOAD_FIELDS = [
  "slug",
  ...MILESTONE_CARDS_FIELDS.filter((f) => f !== "slug" && f !== "milestone"),
] as const;

export function milestoneCardsHash(cfg: Config): string | null {
  const h = cfg.schemaHashes?.["milestone_cards"];
  return h && h.length > 0 ? h : null;
}

/** Same sk shape as BoardCards: column#pos(8)#slug. */
export function milestoneCardSk(column: string, position: string | number, slug: string): string {
  return boardCardSk(column, position, slug);
}

export function milestoneCardFieldsFromCard(card: Card | CardSummary): Record<string, unknown> | null {
  const summary = toCardSummary(card as Card);
  const milestone = (summary.milestone ?? "").trim();
  if (!milestone) return null;
  const sk = milestoneCardSk(summary.column, summary.position, summary.slug);
  return {
    milestone,
    sk,
    slug: summary.slug,
    title: summary.title,
    board: summary.board || "default",
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
    pr_url: summary.pr_url,
    branch: summary.branch,
    layout: MILESTONE_CARDS_LAYOUT,
  };
}

export function cardFromMilestoneCardFields(fields: Record<string, unknown>): Card {
  const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
  const arr = (k: string): string[] => {
    const v = fields[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [];
  };
  return {
    slug: str("slug"),
    title: str("title"),
    body: "",
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

async function deleteMilestoneCardSk(
  node: NodeClient,
  schemaHash: string,
  milestone: string,
  sk: string,
): Promise<void> {
  try {
    await node.deleteRecord({ schemaHash, keyHash: milestone, rangeKey: sk });
  } catch {
    // best-effort
  }
}

export async function purgeOtherMilestoneCardRows(
  node: NodeClient,
  cfg: Config,
  milestone: string,
  slug: string,
  keepSk: string | null,
): Promise<number> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash || !slug || !milestone) return 0;
  // Address rows by their range key, not by the display read. The display read
  // denies a row whose `layout` copy did not come back, and a row this purge
  // cannot see is an orphan nothing can ever delete — no later purge sees it
  // either. See {@link listMilestoneCardsPartitionSpine}.
  const part = await listMilestoneCardsPartitionSpine(node, cfg, milestone);
  if (!part) return 0;
  let n = 0;
  for (const row of part) {
    if (row.slug !== slug) continue;
    if (keepSk !== null && row.sk === keepSk) continue;
    await deleteMilestoneCardSk(node, schemaHash, milestone, row.sk);
    n += 1;
  }
  return n;
}

/**
 * Retire obsolete MilestoneCards tips after a BoardCards write.
 *
 * Hot-path membership is **protein-primary**: BoardCards carries the payload;
 * Mini folds shared field tips onto MilestoneCards under (milestone, sk). The
 * app only deletes superseded MilestoneCards keys — it must not dual-write the
 * full payload on every card mutation (see writeCardMembership).
 *
 * Heal / `upsertMilestoneCard` still dual-writes when repairing drift.
 */
export async function retireMilestoneCardMembership(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous?: Card | CardSummary | null,
): Promise<void> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash) return;

  const nextFields = milestoneCardFieldsFromCard(card);
  const prevMs = (previous?.milestone ?? "").trim();
  const nextMs = nextFields ? String(nextFields.milestone) : "";
  const nextSk = nextFields ? String(nextFields.sk) : "";
  const slug = card.slug;

  // Milestone cleared or missing → drop prior membership only.
  if (!nextFields) {
    if (prevMs && previous) {
      const prevSk = milestoneCardSk(previous.column, previous.position, previous.slug);
      await deleteMilestoneCardSk(node, schemaHash, prevMs, prevSk);
      await purgeOtherMilestoneCardRows(node, cfg, prevMs, slug, null);
    }
    return;
  }

  if (previous && prevMs) {
    const prevSk = milestoneCardSk(previous.column, previous.position, previous.slug);
    if (prevMs !== nextMs || prevSk !== nextSk) {
      await deleteMilestoneCardSk(node, schemaHash, prevMs, prevSk);
    }
    if (prevMs !== nextMs) {
      await purgeOtherMilestoneCardRows(node, cfg, prevMs, slug, null);
    }
    // Do not purge the destination partition here: Mini may have just folded
    // the new tip onto nextSk; a scan-purge would race that write.
  }
  // Brand-new milestone membership: no prior tip to delete. Fold from the
  // BoardCards write creates the MilestoneCards tip when proteins are bound.
}

export type MilestoneCardUpsertOptions = {
  /**
   * The caller has SEEN more than one row for this slug in `nextMs` and is
   * passing only one of them as `previous`.
   *
   * Without this, the sweep below is gated on `prevSk !== nextSk`, which asks
   * "did the card move?" — a question that only answers the sweep's real one
   * ("are there rows to clean up?") when `previous` is the ONLY other row.
   * Reconcile passes `rows[0]` out of a group it already knows is larger than
   * one, so the gate reads the partition's return order rather than the drift:
   * if `rows[0]` happens to be the row that is already correct, the gate says
   * "nothing moved", nothing is swept, and the same repair is re-issued on
   * every subsequent run. Column sks sort `backlog < doing < done < todo`, so
   * that is every backward move — `done -> doing`, `todo -> anything`.
   */
  purgeSiblings?: boolean;
  /**
   * Write the MilestoneCards payload directly. Default true for explicit
   * low-level repair callers; reconcile/heal paths pass false so bound
   * BoardCards -> MilestoneCards proteins own the destination payload.
   */
  writePayload?: boolean;
};

/**
 * Upsert thin MilestoneCards row. Prefer {@link retireMilestoneCardMembership}
 * on the hot path; pass `writePayload: false` for protein-aware heal/reconcile
 * so the app writes BoardCards and lets Mini fold the MilestoneCards tip.
 * Leave `writePayload` at its default only for explicit emergency repair when
 * protein fold cannot be assumed.
 */
export async function upsertMilestoneCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
  previous?: Card | CardSummary | null,
  opts: MilestoneCardUpsertOptions = {},
): Promise<void> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash) return;

  const nextFields = milestoneCardFieldsFromCard(card);
  const prevMs = (previous?.milestone ?? "").trim();
  const nextMs = nextFields ? String(nextFields.milestone) : "";
  const nextSk = nextFields ? String(nextFields.sk) : "";
  const slug = card.slug;

  // Membership cleared: there is no destination row to write, so the
  // retirement IS the operation and has nothing to wait for.
  if (!nextFields) {
    await retireMilestoneCardMembership(node, cfg, card, previous);
    return;
  }

  if (opts.writePayload === false) {
    await upsertBoardCard(node, cfg, card, previous);
    if (previous && prevMs) {
      await retireMilestoneCardMembership(node, cfg, card, previous);
      if (opts.purgeSiblings) {
        await purgeOtherMilestoneCardRows(node, cfg, nextMs, slug, nextSk);
      }
    }
    return;
  }

  // Everything below retires rows this write supersedes, and all of it runs
  // AFTER the destination row is durable — the rule `upsertBoardCard` and
  // `upsertBoardMilestone` already follow, and it matters most here.
  //
  // This is the REPAIR path: `groom milestone-indexes` and `milestone
  // reconcile` call it, with `previous = null` in the heal case, which takes
  // the unconditional whole-partition sweep below. Retiring first meant a
  // failed destination write left the card with NO MilestoneCards row at all —
  // a repair verb that deletes more than it writes leaves the board worse than
  // it found it, and the next heal cannot see the row it just destroyed.
  //
  // Writing first trades that for a transient duplicate, which the sweep on
  // the next line — and the next heal — reap.
  const retireSupersededRows = async () => {
    await retireMilestoneCardMembership(node, cfg, card, previous);
    // A single `previous` can only license SKIPPING the sweep when it accounts
    // for every other row. `purgeSiblings` is the caller saying it does not.
    if (previous && prevMs && !opts.purgeSiblings) {
      const prevSk = milestoneCardSk(previous.column, previous.position, previous.slug);
      if (prevSk !== nextSk || prevMs !== nextMs) {
        await purgeOtherMilestoneCardRows(node, cfg, nextMs, slug, nextSk);
      }
      return;
    }
    await purgeOtherMilestoneCardRows(node, cfg, nextMs, slug, nextSk);
  };

  try {
    await node.updateRecord({
      schemaHash,
      fields: nextFields,
      keyHash: nextMs,
      rangeKey: nextSk,
    });
  } catch {
    await node.createRecord({
      schemaHash,
      fields: nextFields,
      keyHash: nextMs,
      rangeKey: nextSk,
    });
  }
  await retireSupersededRows();
}

export async function removeMilestoneCard(
  node: NodeClient,
  cfg: Config,
  card: Card | CardSummary,
): Promise<void> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash) return;
  const ms = (card.milestone ?? "").trim();
  if (!ms) return;
  const sk = milestoneCardSk(card.column, card.position, card.slug);
  await deleteMilestoneCardSk(node, schemaHash, ms, sk);
  if (card.slug) {
    await purgeOtherMilestoneCardRows(node, cfg, ms, card.slug, null);
  }
}

/**
 * Is this row foreign, i.e. written under some other layout?
 *
 * Only a marker that is PRESENT and DIFFERENT answers yes. An ABSENT marker is
 * a row that cannot state its own provenance, and the same reasoning
 * `readWholeBoardCardRow` applies on the write path applies here: do not infer
 * a fact from an object that has not stated it.
 *
 * This is not hypothetical. Measured on the live primary 2026-08-01
 * (`scripts/probe-layout-marker-denial.ts`): the node returns partial rows on
 * this index — every payload field comes back for some rows and not others,
 * and only the partition-key field `milestone` drops a row at all. In the
 * `lastdb-0231-read-regression-fixes` partition, 9 of 56 rows came back with no
 * `layout` key. The old check read `f.layout ?? ""`, so each of those was
 * denied — and a denied row is invisible to `milestone detail`, to `milestone
 * reconcile`, and to {@link purgeOtherMilestoneCardRows}. Nothing could report
 * it and nothing could delete it, which is the definition of a permanent
 * orphan; reconcile then re-issued the same repair on every run forever.
 */
function isForeignLayout(marker: unknown, expected: string): boolean {
  return typeof marker === "string" && marker.length > 0 && marker !== expected;
}

/** All thin cards under one milestone (no body). */
export async function listMilestoneCardsPartition(
  node: NodeClient,
  cfg: Config,
  milestone: string,
): Promise<Card[] | null> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash || !milestone.trim()) return null;
  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [...MILESTONE_CARDS_PAYLOAD_FIELDS],
      filter: { HashKey: milestone },
    });
    const out: Card[] = [];
    for (const r of res.results) {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (isForeignLayout(f.layout, MILESTONE_CARDS_LAYOUT)) continue;
      // WHAT COUNTS AS A ROW OF THIS INDEX is decided by the one helper the
      // address reads use, so this read cannot admit a row they reject. It
      // could before, and the row it admitted was the Milestone record itself —
      // see {@link milestoneCardRowFromQueryRow} for the shape and the measure.
      const address = milestoneCardRowFromQueryRow(r, milestone);
      if (address === null) continue;
      // The partition key is deliberately not projected — see
      // MILESTONE_CARDS_PAYLOAD_FIELDS — so it comes from the caller's own
      // filter argument. That is the same value the payload copy would carry,
      // without the failure mode that copy introduces.
      const card = cardFromMilestoneCardFields({ ...f, milestone });
      // The range key IS the row's address; the copied scalars are just copies,
      // and this read has measured them going missing. Recover identity from
      // the address before falling back to a copy that may not have come back.
      if (card.slug.length === 0) card.slug = address.slug;
      if (card.column.length === 0) card.column = address.column;
      if (card.position.length === 0) card.position = address.position;
      if (card.slug.length === 0) continue;
      out.push(card);
    }
    return out;
  } catch {
    return null;
  }
}

/** Read one MilestoneCards row by its real partition/range key. */
export async function findMilestoneCardBySk(
  node: NodeClient,
  cfg: Config,
  milestone: string,
  sk: string,
): Promise<Card | null> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash || !milestone.trim() || !sk.trim()) return null;
  const filter = { HashRangePrefix: { hash: milestone, prefix: sk } } as unknown as QueryFilter;
  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [...MILESTONE_CARDS_PAYLOAD_FIELDS],
      filter,
    });
    for (const r of res.results) {
      if (r.key?.range !== sk) continue;
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (isForeignLayout(f.layout, MILESTONE_CARDS_LAYOUT)) continue;
      // Partition key from the filter argument, not from the payload — the
      // reconcile path compares `summary.milestone` against truth, so a row
      // whose copy did not persist would otherwise read as permanently stale.
      const card = cardFromMilestoneCardFields({ ...f, milestone });
      const parsed = parseBoardCardSk(sk);
      if (parsed) {
        if (card.slug.length === 0) card.slug = parsed.slug;
        if (card.column.length === 0) card.column = parsed.column;
        if (card.position.length === 0) card.position = parsed.position;
      }
      return card.slug.length > 0 ? card : null;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Every row in a milestone partition, addressed by its range key.
 *
 * The counterpart to `listBoardCardsPartitionSpine`, and it exists for the same
 * reason: "did I see every row?" and "what key do I delete?" must not be
 * answered by a read that can deny rows or hand back a stale copy of an
 * address.
 *
 * Two deliberate choices, both measured on the live primary 2026-08-01:
 *
 *  - it projects only `slug`, and **not** the partition key `milestone`.
 *    Projecting the hash field is the one thing that DOES drop rows on this
 *    index (56 -> 49 in the probed partition) and it buys nothing: the caller
 *    already knows the milestone — it is the filter.
 *  - it takes the sk from `QueryRow.key.range` rather than the `sk` payload
 *    copy, which was absent on 9 of those 56 rows. `purgeOtherMilestoneCardRows`
 *    used to rebuild the address from the `column`/`position`/`slug` copies, so
 *    on a row whose copies did not come back it computed a key that addresses
 *    nothing, deleted nothing, and counted the deletion anyway.
 *
 * A row whose address cannot be resolved at all is skipped, not guessed at.
 */
export async function listMilestoneCardsPartitionSpine(
  node: NodeClient,
  cfg: Config,
  milestone: string,
): Promise<MilestoneCardRow[] | null> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash || !milestone.trim()) return null;
  let res;
  try {
    res = await node.queryAll({
      schemaHash,
      fields: [...MILESTONE_CARDS_ADDRESS_FIELDS],
      filter: { HashKey: milestone },
    });
  } catch {
    return null;
  }
  const out: MilestoneCardRow[] = [];
  for (const r of res.results) {
    const row = milestoneCardRowFromQueryRow(r, milestone);
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * One MilestoneCards query row reduced to its address, or `null` if this
 * partition read returned something that is not a card row of this index.
 *
 * Shared by {@link listMilestoneCardsPartitionSpine} and
 * {@link sweepMilestoneCardsPartition} so the two cannot disagree about what a
 * row IS. They differ only in which fields lead — that is the whole point of
 * comparing them, and any other difference would be noise the parity check
 * would report as drift.
 *
 * ## The empty range key is not a damaged card. It is the Milestone itself.
 *
 * `Milestone` is `Hash(slug)`; `MilestoneCards` is `HashRange(milestone, sk)`.
 * A milestone's own record therefore lives at hash `<milestone-slug>` — the
 * same hash as its cards partition — and Mini's multi-key expand puts both on
 * one product. Querying the cards partition returns the Milestone record too,
 * with its absent range coerced to `""`. Measured on the live primary
 * 2026-08-04 (`scripts/probe-milestone-cards-keyless-row.ts`), partition
 * `ms-backup-status-truthful`:
 *
 *     lead=slug   → key={"hash":"ms-backup-status-truthful","range":""}
 *                   fields={"slug":"ms-backup-status-truthful"}
 *     lead=title  → …{"title":"Backup status tells the truth about …"}
 *
 * It appears under 9 of the 24 leads — exactly the fields `MilestoneCards`
 * shares with `BoardMilestones` — and under none of the other 15, so which
 * field leads decides whether a caller sees it.
 *
 * Dropping it is REQUIRED as a baseline row: it is a permanent phantom — the
 * sweep reaches it and it can never be repaired away, so parity would report
 * one bogus row on every milestone partition, forever, with nothing to fix.
 *
 * ## The wide read's immunity was a coincidence, and a later fix removed it
 *
 * This comment used to end "the wide display read leads with `milestone`, which
 * the Milestone record has no atom for, so the product has never seen it. Every
 * read that leads with `slug` does." That was true when written and is not
 * true now. {@link MILESTONE_CARDS_PAYLOAD_FIELDS} was subsequently re-led with
 * `slug` and stripped of `milestone` — the correct fix for the hash-gate row
 * drop — which moved the wide read into exactly the category the last sentence
 * names. Measured on the live primary 2026-08-05, partition
 * `lastdb-0231-read-regression-fixes`:
 *
 *     raw wide read (MILESTONE_CARDS_PAYLOAD_FIELDS)  7 rows, 1 keyless
 *     listMilestoneCardsPartition                     7 cards  <- phantom card
 *     listMilestoneCardsPartitionSpine                6 rows
 *
 * The phantom arrived as `slug=<the milestone's own slug>`, `column=""`,
 * `position="1785025144594"` (the Milestone record's `position` field, an
 * epoch-ms portfolio ordering, not a card position) and the milestone's title.
 * `milestone detail` never rendered it — that path takes its ROW SET from the
 * spine and the board and uses the wide read only for payloads keyed by `sk` —
 * but `doctor`'s and `parity check`'s `rows: wide.length` counted it, so both
 * over-reported by exactly one row on every milestone partition.
 *
 * So {@link listMilestoneCardsPartition} now decides what a row IS through this
 * same helper rather than through a projection that happened not to reach one.
 * This is the failure mode the last paragraph below warns about, arriving from
 * the other direction: the guard was not removed, the coincidence that made a
 * second guard unnecessary was.
 *
 * `BoardCards` does not have this shape — measured the same day, its `default`
 * partition returns 0 keyless rows under every lead — because `board_cards`
 * resolves to a schema of its own, while `milestone_cards` resolves to one the
 * node registered under the ENTITY's `descriptive_name: "Milestone"`.
 *
 * ## It is NOT a data-loss risk, and that was measured rather than assumed
 *
 * The worry on record was the delete: its address is
 * `(milestone_cards, hash=<milestone>, range="")`, and the one thing
 * `purgeOtherMilestoneCardRows` does with a spine row is delete it. Tested on an
 * isolated node 2026-08-04 by reproducing the mispinned shape and issuing that
 * exact call (`scripts/probe-milestone-keyless-row-delete-blast-radius.ts`):
 *
 *     delete → HTTP 400 "HashRange schema '…' mutation … requires both hash"
 *     Milestone record: intact, byte-identical. Keyless row: still present.
 *
 * An empty range key is not a valid HashRange address, so the delete cannot
 * reach the Milestone record — it is rejected, not silently applied. The guard
 * prevents a call that would have been a loud no-op. (Loud at the node; muted
 * here, since `deleteMilestoneCardSk` swallows errors by design.)
 *
 * ## And on a correctly-pinned node the row does not exist at all
 *
 * The bleed is not intrinsic to Mini. It is a consequence of WHICH schema this
 * config pins: on the primary, `milestone_cards` points at a hash the node
 * registered under `descriptive_name: "Milestone"` — the entity's own identity —
 * so the multi-key expand puts entity and index on one product. A node pinned to
 * the catalog's declared `MilestoneCards_hashrange_v1_children_20260723` returns
 * zero keyless rows (measured, same run). See
 * `scripts/probe-extra-schema-resolution-blindspot.ts`.
 *
 * The guard was already here, written for partially-written CARD rows whose
 * `sk` copy did not come back. It happens to catch this too. Naming what it
 * actually excludes is the point — a guard held in place by a coincidence is
 * one the next simplification removes.
 */
function milestoneCardRowFromQueryRow(
  r: QueryRow,
  milestone: string,
): MilestoneCardRow | null {
  const f = (r.fields ?? {}) as Record<string, unknown>;
  const sk = typeof r.key?.range === "string" && r.key.range.length > 0
    ? r.key.range
    : typeof f.sk === "string"
      ? f.sk
      : "";
  if (sk.length === 0) return null;
  const parsed = parseBoardCardSk(sk);
  const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
  if (slug.length === 0) return null;
  return {
    milestone,
    sk,
    slug,
    column: parsed?.column ?? "",
    position: parsed?.position ?? "",
  };
}

/** The result of {@link sweepMilestoneCardsPartition}: rows reached, and gaps. */
export type MilestoneCardsPartitionSweep = {
  /** Every row reachable under some leading field, deduped by range key. */
  rows: MilestoneCardRow[];
  /**
   * Leads the node refused. Non-empty means `rows` is a LOWER BOUND, and a
   * caller asserting completeness must fail rather than report a clean result.
   */
  failedLeads: Array<{ field: string; error: string }>;
};

/**
 * Every row in a milestone's cards partition, reached under EVERY leading
 * field — the counterpart to `sweepBoardCardsPartition`, and the only baseline
 * here that is not itself a projection.
 *
 * Every read here is single-field, and at that width the node's rule
 * (HASH-ELSE-LEAD — see {@link MILESTONE_CARDS_PAYLOAD_FIELDS}) reduces to "the
 * row has an atom for this field": the projection's only field is both its lead
 * and, for `[milestone]`, its hash field. So the union over all fields is
 * exactly the rows carrying ANY atom, and nothing narrower than a full sweep is
 * complete. The `slug`-led spine this replaces as a parity baseline
 * catches every row carrying a `slug` atom and is blind to a row carrying
 * neither `slug` nor `milestone` — invisible to both sides of the subtraction,
 * which nets to zero and reads as clean.
 *
 * ## Cost, measured rather than assumed
 *
 * This baseline was declined for four runs on a recorded estimate — "~780ms per
 * partition … would turn an 8s doctor into a 40s one" — carried over from the
 * BoardCards `default` partition (123 rows, 24 leads) and never measured on the
 * index it was being used to decide about. Measured on the live primary
 * 2026-08-04 across all 19 live milestone partitions
 * (`scripts/probe-milestone-parity-baseline-cost.ts`):
 *
 *     slug spine (1 lead)   554ms    52 rows
 *     sweep    (24 leads)  1787ms    52 rows      3.2x, +1.2s total
 *
 * Not 24x, and not per-partition: the leads run pooled at
 * {@link PARTITION_READ_CONCURRENCY} and a one-field projection is the cheapest
 * read the node serves. The real bill for both milestone indexes together is
 * ~1.8s on an 8s doctor.
 *
 * Doctor / heal price, not a list price. No product read path may call this.
 */
export async function sweepMilestoneCardsPartition(
  node: NodeClient,
  cfg: Config,
  milestone: string,
): Promise<MilestoneCardsPartitionSweep | null> {
  const schemaHash = milestoneCardsHash(cfg);
  if (!schemaHash || !milestone.trim()) return null;
  const filter = { HashKey: milestone } as QueryFilter;

  const perLead = await mapWithConcurrency(MILESTONE_CARDS_FIELDS, async (lead) => {
    try {
      const res = await node.queryAll({ schemaHash, fields: [lead], filter });
      const rows: MilestoneCardRow[] = [];
      for (const r of res.results) {
        const row = milestoneCardRowFromQueryRow(r, milestone);
        if (row !== null) rows.push(row);
      }
      return { rows, failure: null };
    } catch (err) {
      // Reported, not swallowed and not thrown — the same contract
      // `sweepBoardCardsPartition` documents at length. Swallowing hands back a
      // short enumeration labelled complete, which is the failure this exists
      // to remove; throwing lets one bad lead on one milestone disable the
      // check for every milestone.
      return {
        rows: [] as MilestoneCardRow[],
        failure: { field: lead, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }, PARTITION_READ_CONCURRENCY);

  // Union by the REAL address. A row reached under several leads is one row.
  const bySk = new Map<string, MilestoneCardRow>();
  const failedLeads: MilestoneCardsPartitionSweep["failedLeads"] = [];
  for (const lead of perLead) {
    if (lead.failure) failedLeads.push(lead.failure);
    for (const r of lead.rows) if (!bySk.has(r.sk)) bySk.set(r.sk, r);
  }
  return { rows: [...bySk.values()], failedLeads };
}
