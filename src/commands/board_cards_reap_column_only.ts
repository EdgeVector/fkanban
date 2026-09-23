// Reap BoardCards rows that ONLY a column (HashRangePrefix) read can see.
//
// ## Why this command exists (2026-09-23)
//
// `board-cards-heal` refuses every write to a partition whose whole read
// (`HashKey`) and column reads (`HashRangePrefix`) disagree. On the live primary
// that refusal fired every hour on `default` (253, later 290 column-only rows)
// and `agent-dogfood-scratch` (2 rows), so the partition was never repaired.
//
// Root cause (papercut-lastdb-boardcards-default-partition-column-only-rows-20260923,
// fold main c4d9bd602, `hash_range_query.rs` ~334/~362-395/~1479): a HashRange
// read takes its row spine from the schema key field (`board`). It falls back
// to the requested field ONLY when the key-field spine of the range is
// completely empty; it never merges the two. The residue rows carry a `slug`
// atom and no `board`/`sk` atom. So:
//
//  - `HashKey{default}` finds `board` atoms in the live rows, never falls back,
//    and never returns the residue;
//  - `HashRangePrefix{default,"todo#"}` finds no `board` atom in a column with
//    no live card, falls back to `slug`, and returns the residue.
//
// Every measured residue row belonged to a card that no longer exists. The
// LastDB read rule is NOT changed here (Tom, 2026-09-23: fix on the fkanban
// side; the read rule gets its own design decision). This command deletes the
// residue by its exact key so the two reads agree again.
//
// ## What it deletes, and the gate on each row
//
// A row is deleted only when ALL of these hold:
//
//  1. a column read returned it and the whole-partition read did not (the
//     divergence probe `board-cards-heal` already runs);
//  2. the row's sk parses as `column#position#slug`;
//  3. a Card point-read for the slug finds NO card (`cardExists`, which
//     projects the hash key alone and so cannot false-negative on a sparse
//     card), and the read did not fail;
//  4. when the column is a milestone state, a Milestone point-read finds no
//     milestone (a milestone's membership row shares this partition's key
//     shape, and "no Card" is the healthy reading of it).
//
// A read that fails keeps the row. Rows only the whole read saw are reported
// and never touched. The delete addresses `(board, sk)` exactly — no range
// delete, no rebuilt key.
//
// ## Limit
//
// Residue in a column that also holds a live card is invisible to EVERY read
// (the key-field spine is not empty there, so no fallback happens). Nothing in
// fkanban can address it until the column empties. The LastDB design card owns
// that gap.
//
// Dry run is the default and prints every exact key. `--apply` deletes, then
// re-reads the partition and reports which reaped keys a column read still
// returns.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  boardCardsHash,
  deleteBoardCardRowsBySk,
  parseBoardCardSk,
  readBoardCardsPartitionDivergence,
} from "../board-cards.ts";
import { cardExists, findMilestone, isMilestoneState, listBoards } from "../record.ts";

export type BoardCardsReapColumnOnlyOptions = {
  cfg: Config;
  node: NodeClient;
  /** Limit to one board partition. Omitted: every live board. */
  board?: string;
  apply?: boolean;
  json?: boolean;
  /** Test seam for the one read-back retry wait. Omit in production. */
  readBackSleep?: (ms: number) => Promise<void>;
};

/** The BoardCards index lags its own delete ack by ~0.5s; wait once, then re-read. */
export const READ_BACK_RETRY_MS = 1_500;

export type ColumnOnlyRow = {
  board: string;
  sk: string;
  slug: string;
  column: string;
};

export type KeptColumnOnlyRow = ColumnOnlyRow & {
  reason: "card-exists" | "milestone-exists" | "unparseable-sk" | "truth-read-failed";
  detail?: string;
};

export type BoardCardsReapColumnOnlyBoard = {
  board: string;
  columns_probed: string[];
  whole_only: string[];
  column_only: number;
  /** Divergence probe failure: nothing on this board was classified. */
  failed: string | null;
  reap: ColumnOnlyRow[];
  kept: KeptColumnOnlyRow[];
  /** After --apply: reaped sks a column read still returns. */
  still_visible?: string[];
};

export type BoardCardsReapColumnOnlyReport = {
  dryRun: boolean;
  board_cards_bound: boolean;
  boards: BoardCardsReapColumnOnlyBoard[];
  would_delete: number;
  deleted: number;
  still_visible: number;
};

type Truth = { keep: false } | { keep: true; reason: KeptColumnOnlyRow["reason"]; detail?: string };

async function classifyRow(
  opts: BoardCardsReapColumnOnlyOptions,
  row: ColumnOnlyRow,
): Promise<Truth> {
  try {
    if (await cardExists(opts.node, opts.cfg, row.slug)) {
      return { keep: true, reason: "card-exists" };
    }
  } catch (err) {
    return { keep: true, reason: "truth-read-failed", detail: `card: ${errText(err)}` };
  }
  if (isMilestoneState(row.column)) {
    try {
      if (await findMilestone(opts.node, opts.cfg, row.slug)) {
        return { keep: true, reason: "milestone-exists" };
      }
    } catch (err) {
      return { keep: true, reason: "truth-read-failed", detail: `milestone: ${errText(err)}` };
    }
  }
  return { keep: false };
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function planBoard(
  opts: BoardCardsReapColumnOnlyOptions,
  board: string,
  declaredColumns: readonly string[],
): Promise<BoardCardsReapColumnOnlyBoard> {
  const d = await readBoardCardsPartitionDivergence(opts.node, opts.cfg, board, declaredColumns);
  const out: BoardCardsReapColumnOnlyBoard = {
    board,
    columns_probed: d?.columnsProbed ?? [],
    whole_only: d?.wholeOnly ?? [],
    column_only: d?.columnOnly.length ?? 0,
    failed: d?.failed ?? null,
    reap: [],
    kept: [],
  };
  if (!d || d.failed) return out;

  // Truth reads are one point-read per distinct slug, bounded-parallel: the
  // 290 live residue rows named 31 slugs.
  const rows: ColumnOnlyRow[] = [];
  for (const sk of [...d.columnOnly].sort()) {
    const parsed = parseBoardCardSk(sk);
    if (!parsed || parsed.slug.length === 0) {
      out.kept.push({ board, sk, slug: "", column: "", reason: "unparseable-sk" });
      continue;
    }
    rows.push({ board, sk, slug: parsed.slug, column: parsed.column });
  }
  const keyOf = (r: ColumnOnlyRow) => `${r.slug}\u0000${isMilestoneState(r.column) ? "m" : "c"}`;
  const distinct = new Map<string, ColumnOnlyRow>();
  for (const r of rows) if (!distinct.has(keyOf(r))) distinct.set(keyOf(r), r);
  const entries = [...distinct.entries()];
  const verdicts = await mapWithConcurrency(entries, ([, r]) => classifyRow(opts, r));
  const truthByKey = new Map(entries.map(([k], i) => [k, verdicts[i]!]));

  for (const r of rows) {
    const t = truthByKey.get(keyOf(r))!;
    if (t.keep) out.kept.push({ ...r, reason: t.reason, ...(t.detail ? { detail: t.detail } : {}) });
    else out.reap.push(r);
  }
  return out;
}

export async function boardCardsReapColumnOnlyResult(
  opts: BoardCardsReapColumnOnlyOptions,
): Promise<{ text: string; report: BoardCardsReapColumnOnlyReport }> {
  const dryRun = !opts.apply;
  if (!boardCardsHash(opts.cfg)) {
    const report: BoardCardsReapColumnOnlyReport = {
      dryRun,
      board_cards_bound: false,
      boards: [],
      would_delete: 0,
      deleted: 0,
      still_visible: 0,
    };
    return { text: "board-cards-reap-column-only: BoardCards schema is not bound; nothing to do.", report };
  }

  const boards = await listBoards(opts.node, opts.cfg);
  const targets = opts.board
    ? [boards.find((b) => b.slug === opts.board) ?? { slug: opts.board, columns: [] as string[] }]
    : boards;

  const plans: BoardCardsReapColumnOnlyBoard[] = [];
  for (const b of targets) plans.push(await planBoard(opts, b.slug, b.columns ?? []));

  const wouldDelete = plans.reduce((n, p) => n + p.reap.length, 0);
  let deleted = 0;
  let stillVisible = 0;
  if (!dryRun) {
    for (let i = 0; i < plans.length; i += 1) {
      const p = plans[i]!;
      if (p.reap.length === 0) continue;
      deleted += await deleteBoardCardRowsBySk(opts.node, opts.cfg, p.board, p.reap.map((r) => r.sk));
      // Read back through the same probe. A reaped key a column read still
      // returns is reported, not retried: the BoardCards index can lag its own
      // ack, so the operator re-runs the dry run to confirm.
      const target = targets[i]!;
      const visibleNow = async (sks: string[]) => {
        const after = await readBoardCardsPartitionDivergence(
          opts.node,
          opts.cfg,
          p.board,
          target.columns ?? [],
        );
        const visible = new Set(after?.columnOnly ?? []);
        return sks.filter((sk) => visible.has(sk));
      };
      let remaining = await visibleNow(p.reap.map((r) => r.sk));
      if (remaining.length > 0) {
        const sleep = opts.readBackSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        await sleep(READ_BACK_RETRY_MS);
        remaining = await visibleNow(remaining);
      }
      p.still_visible = remaining;
      stillVisible += remaining.length;
    }
  }

  const report: BoardCardsReapColumnOnlyReport = {
    dryRun,
    board_cards_bound: true,
    boards: plans,
    would_delete: wouldDelete,
    deleted,
    still_visible: stillVisible,
  };

  const lines: string[] = [];
  lines.push(
    dryRun
      ? `board-cards-reap-column-only (dry run): ${wouldDelete} column-only row(s) would be deleted by exact key.`
      : `board-cards-reap-column-only: deleted ${deleted} column-only row(s) by exact key; ${stillVisible} still visible after read-back.`,
  );
  for (const p of plans) {
    if (p.failed) {
      lines.push(`  ${p.board}: divergence probe failed, board skipped: ${p.failed}`);
      continue;
    }
    lines.push(
      `  ${p.board}: column_only=${p.column_only} reap=${p.reap.length} kept=${p.kept.length} ` +
        `whole_only=${p.whole_only.length} (not touched)`,
    );
    for (const r of p.reap) lines.push(`    ${dryRun ? "would-delete" : "delete"} board=${r.board} sk=${r.sk}`);
    for (const k of p.kept) {
      lines.push(`    keep board=${k.board} sk=${k.sk} reason=${k.reason}${k.detail ? ` (${k.detail})` : ""}`);
    }
    for (const sk of p.still_visible ?? []) lines.push(`    still-visible board=${p.board} sk=${sk}`);
  }
  if (dryRun && wouldDelete > 0) lines.push("Re-run with --apply to delete the keys above.");
  return { text: lines.join("\n"), report };
}

export async function boardCardsReapColumnOnlyCmd(
  opts: BoardCardsReapColumnOnlyOptions,
): Promise<{ output: string; exitCode: number }> {
  const { text, report } = await boardCardsReapColumnOnlyResult(opts);
  return {
    output: opts.json ? JSON.stringify(report, null, 2) : text,
    // A reaped key that a column read still returns is a failed repair.
    exitCode: report.still_visible > 0 ? 1 : 0,
  };
}
