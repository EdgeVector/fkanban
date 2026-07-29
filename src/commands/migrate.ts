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
  boardTerminalMap,
  findCard,
  isPickupAreaTag,
  listBoards,
  listCards,
  nowIso,
  scanCardSummariesForReconcile,
  updateCardRecord,
  withPickupAreaTags,
  type Card,
} from "../record.ts";
import { resolveColumns } from "../schemas.ts";
import { mapWithConcurrency } from "../concurrency.ts";

const FALLBACK_TERMINAL_COLUMN = "done";

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
  const cards = await listCards(opts.node, opts.cfg);
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));

  const result: MigrateAreaTagsResult = {
    scanned: 0,
    changed: 0,
    skippedDone: 0,
    cards: [],
    dryRun,
  };

  for (const card of cards) {
    const terminal = boardTerminal.get(card.board) ?? FALLBACK_TERMINAL_COLUMN;
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

// ---------------------------------------------------------------------------
// `fkanban migrate legacy-columns`
// ---------------------------------------------------------------------------
//
// Why this exists: the kanban columns became a FIXED set — backlog → todo →
// doing → done — on 2026-07-16, and `ensureColumn` has rejected anything else
// on the write path ever since. Cards written BEFORE that keep whatever column
// they had. On the primary, 21 cards still hold `review`.
//
// A card in a column no view iterates is not a cosmetic problem. Every board
// surface iterates `resolveColumns()`, so an off-column card is missing from
// `list` and from `list --json` while `show <slug>` still renders it happily —
// the board disagrees with itself, and nothing in the read path says so.
// `board.ts` now SURFACES them (see `offColumnCards`) rather than swallowing
// them, but surfacing is a smoke alarm, not a repair: reads must never rewrite
// a column, or `list` would start contradicting `show` in the other direction.
//
// Repair is this command's job, and it does it at the only place that can fix
// it for good — the Card record itself.
//
// It also unblocks `groom board-cards-heal --apply`: heal faithfully projects
// truth, so healing an off-column card writes a BoardCards row into a column
// `renderBoard` never iterates. Fix truth first, then heal.

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

/**
 * Move every card out of a column the board does not define.
 *
 * Discovery is a Card scan, not `listCards`. It has to be: `listCards` reads
 * the BoardCards projection, and the cards this repairs are precisely the ones
 * with no BoardCards row — reading the index to find rows missing from the
 * index finds nothing. A full scan is correct in a one-time migration for the
 * same reason it is correct in a reconciler, and banned on hot read paths for
 * the same reason it is banned there.
 *
 * The scan only PROPOSES candidates. Each one is then point-read at
 * HashKey(slug) for its full record before any write, so truth still decides
 * and a stale scan row can never author a column change. The full read matters
 * for a second reason: a card write carries every field, so writing back a
 * body-free summary would blank the body.
 *
 * DO NOT "optimize" this by trusting the scan's `column` and skipping the
 * point-read. Measured on the primary 2026-07-28: `scanCardSummariesForReconcile`
 * returned 1054 rows for 791 distinct slugs, and 843 of those rows carried a
 * slug with EVERY other projected field blank — `column: ""`, `board: ""`,
 * `title: ""`. 580 slugs had no populated scan row at all, yet point-read fine
 * (one of them had been updated that same day). A blank `column` is therefore
 * "unknown", never "off-column", and the scan is a slug oracle only. That is
 * why this reads truth for every candidate and why `board_cards_heal` does the
 * same — both are correct today purely because neither believes the scan.
 */
export async function migrateLegacyColumnsCmd(
  opts: MigrateLegacyColumnsOptions,
): Promise<MigrateLegacyColumnsResult> {
  const dryRun = opts.dryRun ?? false;
  const valid = new Set(resolveColumns());
  const slugFilter = opts.slugs?.length ? new Set(opts.slugs) : null;

  const candidates = (await scanCardSummariesForReconcile(opts.node, opts.cfg)).filter(
    (c) => (!slugFilter || slugFilter.has(c.slug)) && !valid.has(c.column),
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

    // `position` is carried over: it is only a sort key, and preserving it
    // keeps the card's relative order instead of jumping it to the front of
    // its new column. `previous` is passed so the write deletes any BoardCards
    // row still sitting under the old column#pos sk.
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
