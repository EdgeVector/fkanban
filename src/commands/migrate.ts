// `fkanban migrate area-tags` — one-time board-wide re-derivation of the
// pickup `area:*` tags.
//
// Why this exists: before PR #130 landed, `pickupAreaTagsForCard` scraped
// command-shaped prose too loosely and minted bogus `area:*` tags
// (`area:fkanban-agent`, `area:fbrain-got`, `area:fkanban-passes`, …) onto
// cards. The fix constrains derivation to a real command allowlist, but tags
// only re-derive when a card is next written (`move`/`add`). Untouched cards
// keep their stale boilerplate tags forever. This subcommand walks every
// active (non-done, non-tombstoned) card once, recomputes its `area:*` tags
// under the fixed logic, and rewrites only the cards whose tag set actually
// changed.
//
// Scope guard (card STEP 2): this re-derives TAGS only. It deliberately does
// NOT re-run the overlap soft-block (`applyPickupAreaDerivation`), so it never
// clears an intentional human `block_status` hold or manufactures a new
// `needs_human` overlap from the migration itself. It also skips each board's
// terminal (done) column and tombstoned cards — those have no pickup impact.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  TERMINAL_COLUMN,
  findCard,
  isPickupAreaTag,
  listBoardCardsWithBodies,
  nowIso,
  scanCardSummariesForReconcile,
  updateCardRecord,
  withPickupAreaTags,
  type Card,
} from "../record.ts";
import { resolveColumns } from "../schemas.ts";
import { mapWithConcurrency } from "../concurrency.ts";

export type MigratedCard = {
  slug: string;
  board: string;
  column: string;
  removed: string[];
  added: string[];
};

export type MigrateAreaTagsResult = {
  scanned: number; // active cards examined
  changed: number; // cards actually rewritten
  skippedDone: number; // cards left untouched because they're in a terminal column
  cards: MigratedCard[]; // the changed cards, with their tag deltas
  dryRun: boolean;
};

export type MigrateAreaTagsOptions = {
  cfg: Config;
  node: NodeClient;
  // When true, compute and report the deltas but write nothing.
  dryRun?: boolean;
};

// Re-derive pickup `area:*` tags across every active card and rewrite the ones
// whose derived set differs from what's stored. Returns the per-card deltas so
// the caller can print an audit trail.
export async function migrateAreaTagsCmd(
  opts: MigrateAreaTagsOptions,
): Promise<MigrateAreaTagsResult> {
  const dryRun = opts.dryRun ?? false;
  // Bodies, for the same two reasons `migrateLegacyColumnsCmd` point-reads
  // truth above: `pickupAreaTagsForCard` derives areas from `Area:`/`Feature
  // Area:` BODY headers, and each retagged card is written back whole. On the
  // body-free list this stripped body-declared area tags and blanked briefs.
  const cards = await listBoardCardsWithBodies(opts.node, opts.cfg);

  const result: MigrateAreaTagsResult = {
    scanned: 0,
    changed: 0,
    skippedDone: 0,
    cards: [],
    dryRun,
  };

  for (const card of cards) {
    const terminal = TERMINAL_COLUMN;
    // Skip terminal-column (done) cards — a completed card is never picked up,
    // so its area tags have no effect and we don't want to churn its updated_at.
    if (card.column === terminal) {
      result.skippedDone += 1;
      continue;
    }
    result.scanned += 1;

    const before = card.tags;
    const after = withPickupAreaTags(before, card);
    if (tagsEqual(before, after)) continue;

    const beforeAreas = new Set(before.filter(isPickupAreaTag));
    const afterAreas = new Set(after.filter(isPickupAreaTag));
    const removed = [...beforeAreas].filter((t) => !afterAreas.has(t)).sort();
    const added = [...afterAreas].filter((t) => !beforeAreas.has(t)).sort();

    result.changed += 1;
    result.cards.push({
      slug: card.slug,
      board: card.board,
      column: card.column,
      removed,
      added,
    });

    if (!dryRun) {
      const updated: Card = { ...card, tags: after, updated_at: nowIso() };
      await updateCardRecord(opts, updated, undefined, card);
    }
  }

  return result;
}

























/**
 * Legacy column name → the fixed column that HONESTLY describes it.
 *
 * `review` was the lane for work whose PR was open and awaiting review. That is
 * in-flight work, so it lands in `doing`, never `done` — mapping it to `done`
 * would assert a completion nothing verified. `doing` is also exactly where the
 * board-closeout sweep looks, so each card gets the triage it has been missing
 * (merged PR → done, zombie → todo) instead of a second silent resting place.
 *
 * Deliberately a closed allowlist. An unrecognised column is REPORTED and left
 * alone: guessing a destination for a name nobody has seen is how a migration
 * quietly loses work.
 */
export const LEGACY_COLUMN_MAP: Record<string, string> = {
  review: "doing",
};

export type MigratedColumnCard = {
  slug: string;
  board: string;
  from: string;
  to: string | null;
  /** Set when `to` is null: why this card was left alone. */
  reason?: string;
};

export type MigrateLegacyColumnsResult = {
  scanned: number; // cards examined
  offColumn: number; // cards not in the fixed column set
  changed: number; // cards actually rewritten (0 on a dry run)
  unmapped: number; // off-column cards with no allowlisted destination
  cards: MigratedColumnCard[];
  dryRun: boolean;
};

export type MigrateLegacyColumnsOptions = {
  cfg: Config;
  node: NodeClient;
  dryRun?: boolean;
  /** Limit the migration to these slugs. */
  slugs?: string[];
};


export async function migrateLegacyColumnsCmd(
  opts: MigrateLegacyColumnsOptions,
): Promise<MigrateLegacyColumnsResult> {
  const dryRun = opts.dryRun ?? false;
  const valid = new Set(resolveColumns());
  const slugFilter = opts.slugs?.length ? new Set(opts.slugs) : null;

  const candidates = (await scanCardSummariesForReconcile(opts.node, opts.cfg)).filter(
    (c) =>
      (!slugFilter || slugFilter.has(c.slug)) &&
      // `undefined` = the scan did not establish a column, which is NOT evidence
      // of a valid one. Unknown stays a candidate and the point-read below
      // decides; only a column the scan actually produced may exclude a card.
      // (Same behaviour as before — a blank column was never in `valid` — but
      // it was true by accident of `""` not being a column name, and the type
      // now makes it a decision.)
      (c.column === undefined || !valid.has(c.column)),
  );

  const result: MigrateLegacyColumnsResult = {
    scanned: 0,
    offColumn: 0,
    changed: 0,
    unmapped: 0,
    cards: [],
    dryRun,
  };

  // Read every truth up front, bounded-parallel, then write serially — the
  // shape `board_cards_heal` settled on. Reads overlap because a `rows=1` Card
  // point-read is latency-bound; writes stay strictly one-at-a-time because
  // each one fans out to three index updates and this is a maintenance path
  // that must not starve the interactive board.
  const truths = await mapWithConcurrency(candidates, (c) =>
    findCard(opts.node, opts.cfg, c.slug),
  );

  for (const card of truths) {
    result.scanned += 1;
    // Truth decides. A scan row that has since been moved onto a real column is
    // dropped here rather than rewritten off a stale read.
    if (!card || valid.has(card.column)) continue;

    result.offColumn += 1;
    const to = LEGACY_COLUMN_MAP[card.column];
    if (!to) {
      result.unmapped += 1;
      result.cards.push({
        slug: card.slug,
        board: card.board,
        from: card.column,
        to: null,
        reason: `no mapping for column "${card.column}" — move it by hand`,
      });
      continue;
    }

    result.cards.push({ slug: card.slug, board: card.board, from: card.column, to });
    if (dryRun) continue;





    const updated: Card = { ...card, column: to, updated_at: nowIso() };
    await updateCardRecord(opts, updated, undefined, card);
    result.changed += 1;
  }

  return result;
}

// Order-insensitive equality: the derived tag list may be re-sorted even when
// the set is unchanged, and we only want to rewrite on a real difference.
function tagsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const sa = [...a].sort();
  const sb = [...b].sort();
  return sa.every((t, i) => t === sb[i]);
}
