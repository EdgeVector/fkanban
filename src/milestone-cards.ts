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
// boardCardSk is pure — safe to import without cycle.
import { boardCardSk } from "./board-cards.ts";

export { MILESTONE_CARDS_LAYOUT };

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
  const part = await listMilestoneCardsPartition(node, cfg, milestone);
  if (!part) return 0;
  let n = 0;
  for (const row of part) {
    if (row.slug !== slug) continue;
    const sk = milestoneCardSk(row.column, row.position, row.slug);
    if (keepSk !== null && sk === keepSk) continue;
    await deleteMilestoneCardSk(node, schemaHash, milestone, sk);
    n += 1;
  }
  return n;
}

/**
 * Upsert thin MilestoneCards row. Empty milestone removes any previous row.
 */
export async function upsertMilestoneCard(
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
    if (prevSk !== nextSk || prevMs !== nextMs) {
      await purgeOtherMilestoneCardRows(node, cfg, nextMs, slug, nextSk);
    }
  } else {
    await purgeOtherMilestoneCardRows(node, cfg, nextMs, slug, nextSk);
  }

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
    return res.results
      .map((r) => cardFromMilestoneCardFields(r.fields as Record<string, unknown>))
      .filter((c) => c.slug.length > 0);
  } catch {
    return null;
  }
}
