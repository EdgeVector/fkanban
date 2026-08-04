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
    await upsertBoardCard(node, cfg, card, previous, { wideWrite: true });
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
      fields: [...MILESTONE_CARDS_FIELDS],
      filter: { HashKey: milestone },
    });
    const out: Card[] = [];
    for (const r of res.results) {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (isForeignLayout(f.layout, MILESTONE_CARDS_LAYOUT)) continue;
      const card = cardFromMilestoneCardFields(f);
      // The range key IS the row's address; the copied scalars are just copies,
      // and this read has measured them going missing. Recover identity from
      // the address before falling back to a copy that may not have come back.
      const parsed = parseBoardCardSk(typeof r.key?.range === "string" ? r.key.range : "");
      if (parsed) {
        if (card.slug.length === 0) card.slug = parsed.slug;
        if (card.column.length === 0) card.column = parsed.column;
        if (card.position.length === 0) card.position = parsed.position;
      }
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
      fields: [...MILESTONE_CARDS_FIELDS],
      filter,
    });
    for (const r of res.results) {
      if (r.key?.range !== sk) continue;
      const f = (r.fields ?? {}) as Record<string, unknown>;
      if (isForeignLayout(f.layout, MILESTONE_CARDS_LAYOUT)) continue;
      const card = cardFromMilestoneCardFields(f);
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
 * field leads decides whether a caller sees it. The wide display read leads
 * with `milestone`, which the Milestone record has no atom for, so the product
 * has never seen it. Every read that leads with `slug` does.
 *
 * Dropping it is REQUIRED as a baseline row: it is a permanent phantom drop —
 * the sweep would reach it and the wide read never can, so parity would report
 * one invisible row on every milestone partition, forever, with nothing to
 * repair.
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
 * A row is returned iff the field LEADING the projection has an atom on it, so
 * a row is visible iff SOME field leads it and nothing narrower than a full
 * sweep is complete. The `slug`-led spine this replaces as a parity baseline
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
