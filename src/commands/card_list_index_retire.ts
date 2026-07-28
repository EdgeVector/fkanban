// Retire the CardListIndex `all_cards` rollup once BoardCards covers it.
//
// The write is already retired in code (see card-list-index.ts) — this clears
// the stored payload, which is the part that must not be done blind. Until the
// payload is cleared the read path still dual-reads it, so a frozen index would
// keep serving rows for cards that have since moved or been deleted.
//
// The gate is the only interesting part: clearing is safe exactly when every
// slug in the rollup either has a BoardCards row (covered) or has no Card record
// at all (a tombstone the leaky rollup never dropped). A slug whose Card EXISTS
// but has no BoardCards row is real membership drift — clearing would lose the
// only record that the card belongs on a board. That case blocks `--apply` and
// sends the operator to `groom board-cards-heal`, which is the path that owns
// membership repair.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { listBoardCardsPartition, boardCardsHash } from "../board-cards.ts";
import {
  readCardListIndex,
  clearCardListIndex,
  cardListIndexHash,
} from "../card-list-index.ts";
import { findCard, listBoards } from "../record.ts";

export type CardListIndexRetireOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
};

export type CardListIndexRetireReport = {
  index_entries: number;
  index_bytes: number;
  board_cards_rows: number;
  covered: number;
  /** In the rollup, no BoardCards row, and no Card record — leaked garbage. */
  tombstones: string[];
  /** Card EXISTS but has no BoardCards row — real drift; blocks apply. */
  uncovered_live: string[];
  cleared: boolean;
  dryRun: boolean;
  blocked_reason: string | null;
};

export async function cardListIndexRetireResult(
  opts: CardListIndexRetireOptions,
): Promise<{ text: string; report: CardListIndexRetireReport }> {
  const dryRun = opts.apply !== true;
  const base = {
    index_entries: 0,
    index_bytes: 0,
    board_cards_rows: 0,
    covered: 0,
    tombstones: [] as string[],
    uncovered_live: [] as string[],
    cleared: false,
    dryRun,
  };

  if (!cardListIndexHash(opts.cfg)) {
    const report = { ...base, blocked_reason: "no card_list_index schema bound — nothing to retire" };
    return { text: `card-list-index retire: ${report.blocked_reason}`, report };
  }
  if (!boardCardsHash(opts.cfg)) {
    // Without BoardCards the rollup is still the read model. Refuse loudly:
    // clearing here would empty the board.
    const report = {
      ...base,
      blocked_reason:
        "no board_cards schema bound — all_cards is still the only card index on this node",
    };
    return { text: `card-list-index retire: BLOCKED — ${report.blocked_reason}`, report };
  }

  const indexed = (await readCardListIndex(opts.node, opts.cfg)) ?? [];
  base.index_entries = indexed.length;
  base.index_bytes = JSON.stringify(indexed).length;

  if (indexed.length === 0) {
    const report = { ...base, blocked_reason: null };
    return {
      text: "card-list-index retire: all_cards is already empty — nothing to clear",
      report,
    };
  }

  const boards = await listBoards(opts.node, opts.cfg);
  const boardCardSlugs = new Set<string>();
  for (const b of boards) {
    const part = await listBoardCardsPartition(opts.node, opts.cfg, b.slug);
    if (!part) continue;
    for (const c of part) if (c.slug) boardCardSlugs.add(c.slug);
  }
  base.board_cards_rows = boardCardSlugs.size;

  const tombstones: string[] = [];
  const uncovered_live: string[] = [];
  let covered = 0;

  for (const entry of indexed) {
    if (!entry.slug) continue;
    if (boardCardSlugs.has(entry.slug)) {
      covered += 1;
      continue;
    }
    // Not in BoardCards. Point-read Card to tell garbage from real drift.
    const card = await findCard(opts.node, opts.cfg, entry.slug);
    if (card) uncovered_live.push(entry.slug);
    else tombstones.push(entry.slug);
  }

  base.covered = covered;
  base.tombstones = tombstones;
  base.uncovered_live = uncovered_live;

  let blocked_reason: string | null = null;
  let cleared = false;

  if (uncovered_live.length > 0) {
    blocked_reason =
      `${uncovered_live.length} card(s) exist but have no BoardCards row — ` +
      "run `kanban groom board-cards-heal --apply` first, then retry";
  } else if (opts.apply === true) {
    await clearCardListIndex(opts.node, opts.cfg);
    cleared = true;
  }

  const report: CardListIndexRetireReport = { ...base, cleared, blocked_reason };

  const head =
    `card-list-index retire: entries=${report.index_entries} (${report.index_bytes} B) ` +
    `board_cards=${report.board_cards_rows} covered=${report.covered} ` +
    `tombstones=${report.tombstones.length} uncovered_live=${report.uncovered_live.length}` +
    `${report.dryRun ? " — DRY RUN, no writes" : ""}`;
  const lines: string[] = [];
  if (report.uncovered_live.length > 0) {
    lines.push(`  BLOCKED — ${report.blocked_reason}`);
    for (const s of report.uncovered_live) lines.push(`    live, no BoardCards row: ${s}`);
  } else {
    for (const s of report.tombstones) lines.push(`    tombstone (no Card record): ${s}`);
    lines.push(
      report.cleared
        ? "  cleared all_cards payload — BoardCards is now the sole card index"
        : "  safe to clear — re-run with --apply",
    );
  }

  return { text: [head, ...lines].join("\n"), report };
}

export async function cardListIndexRetireCmd(
  opts: CardListIndexRetireOptions,
): Promise<string> {
  const { text, report } = await cardListIndexRetireResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
