// Heal the `all_boards` rollup against Board truth.
//
// `all_boards` decides which BoardCards partitions `kanban list` queries at all,
// so drift here is not cosmetic:
//
//   - a GHOST (entry with no Board record) keeps a deleted board in `board list`
//     and costs one dead partition query on every `kanban list`, forever;
//   - a MISSING board (record live, no entry) makes every card on that board
//     invisible to `kanban list` while `show <slug>` still works.
//
// Board records are the source of truth. This is the reconciler for the one
// remaining single-row rollup in kanban — the counterpart to
// `groom board-cards-heal` for card membership.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  cardListIndexHash,
  readBoardListIndex,
  writeBoardListIndex,
  type BoardSummary,
} from "../card-list-index.ts";
import { scanBoardsForReconcile, toBoardSummary, type Board } from "../record.ts";

export type BoardListHealOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
};

export type BoardListHealAction = {
  slug: string;
  action: "drop-ghost" | "add-missing" | "refresh-stale" | "noop-match";
  reason: string;
};

export type BoardListHealReport = {
  index_entries: number;
  truth_boards: number;
  ghosts: number;
  missing: number;
  stale: number;
  drifted: number;
  healed: number;
  dryRun: boolean;
  /** True when `all_boards` has no row at all — nothing to heal, list self-seeds. */
  index_absent: boolean;
  actions: BoardListHealAction[];
};

/** Does the index copy still agree with the Board record it points at? */
function summaryMatches(a: BoardSummary, b: BoardSummary): boolean {
  return (
    a.title === b.title &&
    a.body === b.body &&
    a.created_at === b.created_at &&
    a.updated_at === b.updated_at &&
    a.columns.length === b.columns.length &&
    a.columns.every((col, i) => col === b.columns[i])
  );
}

export async function boardListHealResult(
  opts: BoardListHealOptions,
): Promise<{ text: string; report: BoardListHealReport }> {
  if (cardListIndexHash(opts.cfg) === null) {
    // No rollup on this node, so `listBoards` reads Board truth directly. There
    // is nothing to drift against — counting every board as "missing" would spend
    // a scan to describe a healthy node as broken.
    return {
      text: "board-list heal: card_list_index schema not bound — nothing to heal.",
      report: {
        index_entries: 0,
        truth_boards: 0,
        ghosts: 0,
        missing: 0,
        stale: 0,
        drifted: 0,
        healed: 0,
        dryRun: !opts.apply,
        index_absent: false,
        actions: [],
      },
    };
  }
  const indexed = await readBoardListIndex(opts.node, opts.cfg);
  const indexBySlug = new Map((indexed ?? []).map((b) => [b.slug, b]));

  // Board truth. Every entry already in the index is passed in as a candidate so
  // it gets its own point read: a LastDB full scan OMITS live records that point
  // reads return (see scanBoardsForReconcile rule 2), so "the scan didn't list
  // it" must never be read as "it was deleted". On the primary that distinction
  // is nine boards: absent from the scan, live on point read. Deciding ghost from
  // the scan alone would have dropped them from the index and made every card on
  // them invisible to `kanban list`.
  const truth: Board[] = await scanBoardsForReconcile(opts.node, opts.cfg, indexBySlug.keys());
  const truthBySlug = new Map(truth.map((b) => [b.slug, toBoardSummary(b)]));

  const actions: BoardListHealAction[] = [];
  let ghosts = 0;
  let missing = 0;
  let stale = 0;

  for (const [slug, entry] of indexBySlug) {
    const t = truthBySlug.get(slug);
    if (!t) {
      ghosts += 1;
      actions.push({
        slug,
        action: "drop-ghost",
        reason: "point read found no live Board record (board rm left the entry behind)",
      });
      continue;
    }
    if (!summaryMatches(entry, t)) {
      stale += 1;
      actions.push({ slug, action: "refresh-stale", reason: "index copy differs from Board record" });
      continue;
    }
    actions.push({ slug, action: "noop-match", reason: "index entry matches Board record" });
  }

  for (const [slug] of truthBySlug) {
    if (indexBySlug.has(slug)) continue;
    missing += 1;
    actions.push({
      slug,
      action: "add-missing",
      reason: "live Board record absent from index — its cards are invisible to list",
    });
  }

  const drifted = ghosts + missing + stale;

  // An absent index row is NOT drift: `listBoards` falls back to a Board scan and
  // re-seeds it. Writing one here would only race that seed.
  const indexAbsent = indexed === null;
  let healed = 0;
  if (opts.apply && drifted > 0 && !indexAbsent) {
    // Rewrite from truth in one unconditional put — the payload is derived from
    // Board records, not from the row being replaced, so it is meant to win over
    // a concurrent patch rather than CAS-conflict with it.
    await writeBoardListIndex(
      opts.node,
      opts.cfg,
      [...truthBySlug.values()].sort((a, b) => a.slug.localeCompare(b.slug)),
    );
    healed = drifted;
  }

  const report: BoardListHealReport = {
    index_entries: indexBySlug.size,
    truth_boards: truthBySlug.size,
    ghosts,
    missing,
    stale,
    drifted,
    healed,
    dryRun: !opts.apply,
    index_absent: indexAbsent,
    actions: opts.json ? actions : actions.filter((a) => a.action !== "noop-match"),
  };

  const head =
    `board-list heal: index=${report.index_entries} truth=${report.truth_boards} ` +
    `ghosts=${report.ghosts} missing=${report.missing} stale=${report.stale} ` +
    `healed=${report.healed}${report.dryRun ? " — DRY RUN, no writes" : ""}`;
  const notes: string[] = [];
  if (indexAbsent) notes.push("  all_boards row absent — `kanban list` re-seeds it from Board truth.");
  const lines = report.actions
    .filter((a) => a.action !== "noop-match")
    .map((a) => `  ${a.slug} → ${a.action} (${a.reason})`);
  return { text: [head, ...notes, ...lines].join("\n"), report };
}

export async function boardListHealCmd(opts: BoardListHealOptions): Promise<string> {
  const { text, report } = await boardListHealResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
