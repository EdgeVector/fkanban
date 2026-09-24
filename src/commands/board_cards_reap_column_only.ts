// Reap BoardCards residue: a `slug` atom and no `board` / `sk` atom.
//
// ## Why this command exists (2026-09-23, detector updated 2026-09-24)
//
// `board-cards-heal` refuses every write to a partition whose whole read
// (`HashKey`) and column reads (`HashRangePrefix`) disagree. On the live primary
// that refusal fired every hour on `default` (253, later 290 column-only rows)
// and `agent-dogfood-scratch` (2 rows), so the partition was never repaired.
//
// Root cause (papercut-lastdb-boardcards-default-partition-column-only-rows-20260923):
// before LastDB fold #2175 a HashRange read takes its row spine from the key
// field (`board`) and falls back to the requested field ONLY when that spine
// is empty for the range. Residue then shows up on a column read of an empty
// column and not on the whole-partition read.
//
// Fold #2175 (option A) merges the key spine with the first projected non-key
// field. A `[slug]` read of the partition then returns the residue from BOTH
// the whole read and the column reads, so the column-minus-whole set is empty
// and this command would reap nothing. The second detector is the merge rule
// itself: a row in the `[slug]` projection of `HashKey{board}` that is absent
// from the `[board]` projection (no merge field, key spine only).
//
// Both detectors run. The candidate set is their union, so a node without
// fold #2175 and a node with it each yield the residue.
//
// ## What it deletes, and the gate on each row
//
// A row is deleted only when ALL of these hold:
//
//  1. at least one detector returned it (column-only, or slug-minus-board);
//  2. the row's sk parses as `column#position#slug`;
//  3. a Card point-read for the slug finds NO card (`cardExists`, which
//     projects the hash key alone and so cannot false-negative on a sparse
//     card), and the read did not fail;
//  4. when the column is a milestone state, the row is not a live milestone
//     row. BoardMilestones shares the `slug` molecule with BoardCards and the
//     same `(board, state#pos#slug)` key shape, so on a fold #2175 node the
//     `[slug]` read also returns BoardMilestones rows. A row is kept when a
//     Milestone point-read gives a milestone whose current key
//     (`boardMilestoneSk(state, position, slug)` on this board) is the row's
//     sk, or when the row is in the BoardMilestones key spine
//     (`[board]` read of this partition). A row that is neither is a stale
//     milestone position. Measured on a CoW copy of the primary 2026-09-24:
//     462 milestone-column rows, 211 current, 4 more in the BoardMilestones
//     key spine, 247 stale.
//  5. CAUTION: a row whose slug names a live milestone is reaped only with
//     `--reap-stale-milestone-positions`. Before fold #2182 a BoardCards row
//     delete also deleted `Milestone(slug)` (the protein delete expanded to
//     every Hash-keyed record schema that shares the BoardCards protein). On
//     that CoW copy the reap deleted live Milestone records. Pass the flag
//     only on a node that has fold #2182. Without it the row is kept as
//     `milestone-stale-position`.
//
// A detector that fails contributes no rows to the reap. The other detector
// still runs. Rows only the whole read saw are reported and never touched.
// The delete addresses `(board, sk)` exactly — no range delete, no rebuilt key.
//
// Dry run is the default and prints every exact key. `--apply` deletes, then
// re-reads through both detectors. A reaped key a successful detector still
// returns is reported. A failed read-back detector is an unproven repair:
// its empty set is not proof the key is gone, and both detectors must
// succeed before a reaped key is cleared. On a fold #2175 node the
// column-only set stays empty while residue remains, so a failed key-spine
// diff must not clear the reap.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  boardCardsHash,
  type BoardCardsKeySpineDiff,
  type BoardCardsReadDivergence,
  deleteBoardCardRowsBySk,
  diffBoardCardsPartition,
  parseBoardCardSk,
  readBoardCardsPartitionDivergence,
} from "../board-cards.ts";
import { cardExists, findMilestone, isMilestoneState, listBoards, type Milestone } from "../record.ts";
import { boardMilestoneSk, boardMilestonesHash } from "../board-milestones.ts";

export type BoardCardsReapColumnOnlyOptions = {
  cfg: Config;
  node: NodeClient;
  /** Limit to one board partition. Omitted: every live board. */
  board?: string;
  apply?: boolean;
  json?: boolean;
  /**
   * Reap a stale position of a live milestone. Needs a node with fold #2182:
   * an older node also deletes the Milestone record. Default false.
   */
  reapStaleMilestonePositions?: boolean;
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
  reason:
    | "card-exists"
    | "milestone-exists"
    | "milestone-row-live"
    | "milestone-stale-position"
    | "unparseable-sk"
    | "truth-read-failed";
  detail?: string;
};

export type BoardCardsReapColumnOnlyBoard = {
  board: string;
  columns_probed: string[];
  whole_only: string[];
  /** Old detector: column read minus whole-partition read. */
  column_only: number;
  /** Fold #2175 detector: `[slug]` HashKey rows absent from the `[board]` read. */
  missing_key: number;
  /**
   * A detector failed. Rows from the detector that succeeded are still
   * classified. Empty `reap` and `kept` with this set means the board was
   * skipped.
   */
  failed: string | null;
  reap: ColumnOnlyRow[];
  kept: KeptColumnOnlyRow[];
  /** After --apply: reaped sks a successful detector still returns. */
  still_visible?: string[];
  /**
   * After --apply: reaped sks a failed read-back detector did not clear.
   * An empty set from that failure is not proof the key is gone.
   */
  read_back_unproven?: string[];
  /** After --apply: why a read-back detector failed. Absent when both ran. */
  read_back_failed?: string;
};

export type BoardCardsReapColumnOnlyReport = {
  dryRun: boolean;
  board_cards_bound: boolean;
  boards: BoardCardsReapColumnOnlyBoard[];
  would_delete: number;
  deleted: number;
  still_visible: number;
  /** Reaped keys a failed read-back detector left unproven. */
  read_back_unproven: number;
};

type Truth = { keep: false } | { keep: true; reason: KeptColumnOnlyRow["reason"]; detail?: string };

/** What the point reads say about one slug. Read once per slug. */
type SlugTruth =
  | { failed: string }
  | { failed: null; card: boolean; milestone: Milestone | null | undefined };

async function readSlugTruth(
  opts: BoardCardsReapColumnOnlyOptions,
  slug: string,
): Promise<SlugTruth> {
  let card: boolean;
  try {
    card = await cardExists(opts.node, opts.cfg, slug);
  } catch (err) {
    return { failed: `card: ${errText(err)}` };
  }
  // The milestone read runs for every slug, not only for milestone columns:
  // on a node without fold #2182 a delete of ANY row for a milestone's slug
  // also deletes that Milestone record.
  if (card) return { failed: null, card, milestone: undefined };
  try {
    return { failed: null, card, milestone: await findMilestone(opts.node, opts.cfg, slug) };
  } catch (err) {
    return { failed: `milestone: ${errText(err)}` };
  }
}

/**
 * The per-row verdict.
 *
 * `milestoneSpine` is the BoardMilestones key spine of this partition: `null`
 * when the read failed (keep every milestone-column row whose milestone
 * exists), `undefined` when BoardMilestones is not bound.
 */
function classifyRow(
  row: ColumnOnlyRow,
  truth: SlugTruth,
  milestoneSpine: ReadonlySet<string> | null | undefined,
  reapStaleMilestonePositions: boolean,
): Truth {
  if (truth.failed != null) return { keep: true, reason: "truth-read-failed", detail: truth.failed };
  if (truth.card) return { keep: true, reason: "card-exists" };
  const m = truth.milestone;
  if (!m) return { keep: false };
  const current = isMilestoneState(row.column)
    && (m.board || "default") === row.board
    && boardMilestoneSk(m.state, m.position, m.slug) === row.sk;
  if (current) return { keep: true, reason: "milestone-exists" };
  if (milestoneSpine === null) {
    return { keep: true, reason: "truth-read-failed", detail: "board-milestones key spine read failed" };
  }
  if (milestoneSpine?.has(row.sk)) return { keep: true, reason: "milestone-row-live" };
  // The milestone exists, but this is not its current key and no
  // BoardMilestones row holds it: a stale milestone position.
  if (!reapStaleMilestonePositions) {
    return {
      keep: true,
      reason: "milestone-stale-position",
      detail: "reap with --reap-stale-milestone-positions on a node with fold #2182",
    };
  }
  return { keep: false };
}

/**
 * The BoardMilestones key spine of one partition: the range keys of rows that
 * carry a `board` atom. It projects `[board]`, the key field, and nothing
 * else. A `[slug]` read would not do: on a fold #2175 node it merges the
 * shared `slug` molecule, so it returns BoardCards residue too.
 * `undefined` when BoardMilestones is not bound; `null` when the read failed.
 */
async function readBoardMilestonesKeySpine(
  opts: BoardCardsReapColumnOnlyOptions,
  board: string,
): Promise<Set<string> | null | undefined> {
  const schemaHash = boardMilestonesHash(opts.cfg);
  if (!schemaHash) return undefined;
  try {
    const res = await opts.node.queryAll({ schemaHash, fields: ["board"], filter: { HashKey: board } });
    const out = new Set<string>();
    for (const r of res.results) {
      const range = r.key?.range;
      if (typeof range === "string" && range.length > 0) out.add(range);
    }
    return out;
  } catch {
    return null;
  }
}

function errText(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function detectorRows(
  divergence: BoardCardsReadDivergence | null,
  keyDiff: BoardCardsKeySpineDiff | null,
): { columnOnly: string[]; missingKey: string[]; failed: string | null } {
  // A failed detector reports an empty set. Do not reap from a probe that
  // did not finish. The other detector still contributes.
  const columnOnly = divergence && !divergence.failed ? divergence.columnOnly : [];
  const missingKey = keyDiff && !keyDiff.failed ? keyDiff.missingKey : [];
  const failed = [divergence?.failed, keyDiff?.failed].filter((f): f is string => Boolean(f));
  return {
    columnOnly,
    missingKey,
    failed: failed.length > 0 ? failed.join("; ") : null,
  };
}

/**
 * Whether the reaped keys are gone. Do not use this for the reap itself:
 * a failed detector must not authorize a delete, and {@link detectorRows}
 * already drops it there.
 *
 * A failed detector's empty set is not proof of absence. Keys it did not
 * return stay unproven. A hit from a detector that succeeded is residue.
 * On a fold #2175 node the column-only set stays empty while residue
 * remains, so a failed key-spine diff must not clear the reap.
 */
function classifyReadBack(
  sks: readonly string[],
  divergence: BoardCardsReadDivergence | null,
  keyDiff: BoardCardsKeySpineDiff | null,
): { still: string[]; unproven: string[]; failed: string | null } {
  const columnHits = divergence != null && divergence.failed == null
    ? new Set(divergence.columnOnly)
    : new Set<string>();
  const keyHits = keyDiff != null && keyDiff.failed == null
    ? new Set(keyDiff.missingKey)
    : new Set<string>();
  const columnFailed = divergence == null || divergence.failed != null;
  const keyFailed = keyDiff == null || keyDiff.failed != null;
  const still: string[] = [];
  const unproven: string[] = [];
  for (const sk of sks) {
    if (columnHits.has(sk) || keyHits.has(sk)) still.push(sk);
    else if (columnFailed || keyFailed) unproven.push(sk);
  }
  const failed = [
    divergence == null ? "column detector did not run" : divergence.failed,
    keyDiff == null ? "key-spine detector did not run" : keyDiff.failed,
  ].filter((part): part is string => Boolean(part));
  return { still, unproven, failed: failed.length > 0 ? failed.join("; ") : null };
}

async function planBoard(
  opts: BoardCardsReapColumnOnlyOptions,
  board: string,
  declaredColumns: readonly string[],
): Promise<BoardCardsReapColumnOnlyBoard> {
  const [d, keyDiff] = await Promise.all([
    readBoardCardsPartitionDivergence(opts.node, opts.cfg, board, declaredColumns),
    diffBoardCardsPartition(opts.node, opts.cfg, board),
  ]);
  const detected = detectorRows(d, keyDiff);
  const out: BoardCardsReapColumnOnlyBoard = {
    board,
    columns_probed: d?.columnsProbed ?? [],
    whole_only: d && !d.failed ? d.wholeOnly : [],
    column_only: detected.columnOnly.length,
    missing_key: detected.missingKey.length,
    failed: detected.failed,
    reap: [],
    kept: [],
  };
  const candidates = [...new Set([...detected.columnOnly, ...detected.missingKey])].sort();
  if (candidates.length === 0) return out;

  // Truth reads are one point-read per distinct slug, bounded-parallel: the
  // 290 live residue rows named 31 slugs.
  const rows: ColumnOnlyRow[] = [];
  for (const sk of candidates) {
    const parsed = parseBoardCardSk(sk);
    if (!parsed || parsed.slug.length === 0) {
      out.kept.push({ board, sk, slug: "", column: "", reason: "unparseable-sk" });
      continue;
    }
    rows.push({ board, sk, slug: parsed.slug, column: parsed.column });
  }
  const slugs = [...new Set(rows.map((r) => r.slug))];
  const truths = await mapWithConcurrency(slugs, (slug) => readSlugTruth(opts, slug));
  const truthBySlug = new Map(slugs.map((slug, i) => [slug, truths[i]!]));

  let milestoneSpine: Set<string> | null | undefined;
  if ([...truthBySlug.values()].some((t) => t.failed == null && t.milestone)) {
    milestoneSpine = await readBoardMilestonesKeySpine(opts, board);
  }

  for (const r of rows) {
    const t = classifyRow(r, truthBySlug.get(r.slug)!, milestoneSpine, opts.reapStaleMilestonePositions === true);
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
      read_back_unproven: 0,
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
  let readBackUnproven = 0;
  if (!dryRun) {
    for (let i = 0; i < plans.length; i += 1) {
      const p = plans[i]!;
      if (p.reap.length === 0) continue;
      deleted += await deleteBoardCardRowsBySk(opts.node, opts.cfg, p.board, p.reap.map((r) => r.sk));
      // Read back through both detectors. A reaped key a successful detector
      // still returns is reported, not deleted again: the BoardCards index can
      // lag its own ack, so the operator re-runs the dry run to confirm.
      // A failed detector is not fed through detectorRows. That helper turns
      // a failure into an empty set so the reap will not delete from a probe
      // that did not finish. Here the same empty set would look like proof
      // the key is gone.
      const target = targets[i]!;
      const readBack = async (sks: string[]) => {
        const [after, keyAfter] = await Promise.all([
          readBoardCardsPartitionDivergence(opts.node, opts.cfg, p.board, target.columns ?? []),
          diffBoardCardsPartition(opts.node, opts.cfg, p.board),
        ]);
        return classifyReadBack(sks, after, keyAfter);
      };
      let back = await readBack(p.reap.map((r) => r.sk));
      if (back.still.length > 0 || back.unproven.length > 0) {
        const sleep = opts.readBackSleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
        await sleep(READ_BACK_RETRY_MS);
        back = await readBack([...back.still, ...back.unproven]);
      }
      p.still_visible = back.still;
      p.read_back_unproven = back.unproven;
      if (back.failed) p.read_back_failed = back.failed;
      stillVisible += back.still.length;
      readBackUnproven += back.unproven.length;
    }
  }

  const report: BoardCardsReapColumnOnlyReport = {
    dryRun,
    board_cards_bound: true,
    boards: plans,
    would_delete: wouldDelete,
    deleted,
    still_visible: stillVisible,
    read_back_unproven: readBackUnproven,
  };

  const lines: string[] = [];
  lines.push(
    dryRun
      ? `board-cards-reap-column-only (dry run): ${wouldDelete} residue row(s) would be deleted by exact key.`
      : `board-cards-reap-column-only: deleted ${deleted} residue row(s) by exact key; ${stillVisible} still visible after read-back` +
        (readBackUnproven > 0 ? `; ${readBackUnproven} unproven after a failed read-back` : "") +
        ".",
  );
  for (const p of plans) {
    if (p.failed && p.reap.length === 0 && p.kept.length === 0) {
      lines.push(`  ${p.board}: residue probe failed, board skipped: ${p.failed}`);
      continue;
    }
    lines.push(
      `  ${p.board}: column_only=${p.column_only} missing_key=${p.missing_key} ` +
        `reap=${p.reap.length} kept=${p.kept.length} whole_only=${p.whole_only.length} (not touched)`,
    );
    if (p.failed) lines.push(`  ${p.board}: one detector failed, the other still ran: ${p.failed}`);
    for (const r of p.reap) lines.push(`    ${dryRun ? "would-delete" : "delete"} board=${r.board} sk=${r.sk}`);
    for (const k of p.kept) {
      lines.push(`    keep board=${k.board} sk=${k.sk} reason=${k.reason}${k.detail ? ` (${k.detail})` : ""}`);
    }
    if (p.read_back_failed && (p.read_back_unproven?.length ?? 0) > 0) {
      lines.push(`  ${p.board}: read-back unproven, repair not confirmed: ${p.read_back_failed}`);
    }
    for (const sk of p.still_visible ?? []) lines.push(`    still-visible board=${p.board} sk=${sk}`);
    for (const sk of p.read_back_unproven ?? []) lines.push(`    read-back-unproven board=${p.board} sk=${sk}`);
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
    // A reaped key a detector still returns, or a read-back that failed to
    // prove the key is gone, is a failed repair. An empty set from a failed
    // detector is not that proof.
    exitCode: report.still_visible > 0 || report.read_back_unproven > 0 ? 1 : 0,
  };
}
