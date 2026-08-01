// MilestoneCards HashRange helpers — Dynamo-style reverse membership:
// hash=milestone, range=column#position#slug. Thin projection (no body).
//
// Detail/reconcile: one partition query per milestone.
// Empty milestone field → no row (remove prior if cleared).

import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
import { MILESTONE_CARDS_FIELDS, MILESTONE_CARDS_LAYOUT } from "./schemas.ts";
import type { Card } from "./record.ts";
import { toCardSummary, type CardSummary } from "./card-list-index.ts";
// boardCardSk / parseBoardCardSk are pure — safe to import without cycle.
import { boardCardSk, parseBoardCardSk } from "./board-cards.ts";

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
};

/**
 * Upsert thin MilestoneCards row (full dual-write). Prefer
 * {@link retireMilestoneCardMembership} on the hot path; use this for heal /
 * one-shot backfill when protein fold cannot be assumed.
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
    const f = (r.fields ?? {}) as Record<string, unknown>;
    const sk = typeof r.key?.range === "string" && r.key.range.length > 0
      ? r.key.range
      : typeof f.sk === "string"
        ? f.sk
        : "";
    if (sk.length === 0) continue;
    const parsed = parseBoardCardSk(sk);
    const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
    if (slug.length === 0) continue;
    out.push({
      milestone,
      sk,
      slug,
      column: parsed?.column ?? "",
      position: parsed?.position ?? "",
    });
  }
  return out;
}
