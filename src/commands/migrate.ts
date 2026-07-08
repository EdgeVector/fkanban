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
  isPickupAreaTag,
  listBoards,
  listCards,
  nowIso,
  updateCardRecord,
  withPickupAreaTags,
  type Card,
} from "../record.ts";

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
      await updateCardRecord(opts, updated);
    }
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
