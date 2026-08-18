// Archive cards that have sat in a board's TERMINAL column past a cutoff.
//
// Why this is a first-class command and not a maintenance script
// --------------------------------------------------------------
// The terminal column is an append-only archive that shares a partition with
// the working set: BoardCards is HashRange(hash=board, range=column#pos#slug),
// so `done` rows are fetched by every whole-partition read. Measured on the
// live primary 2026-07-31, board `default`:
//
//   783 rows total — 581 `done` (74%), 202 active
//   whole-partition read at the list projection   1578ms
//   the `done` prefix alone                       1310ms  (83% of it)
//   the three active columns together              780ms
//
// So bounding the terminal column is not tidiness — it is the only thing
// keeping the cost of listing the WORKING set from scaling with everything the
// board has ever finished. At the time this command was written, BoardCards
// under client=kanban was the #1 consumer of node wall time system-wide
// (`lastdb ops`: count=5293 sum=3053696ms avg=576ms).
//
// A daily sweep DID exist, as an unversioned script at ~/.fkanban/archive-done.ts
// that shelled `bun run ~/code/edgevector/fkanban/src/cli.ts`. When fkanban
// became a portal (no checkout by design) that path ceased to exist, so every
// fire from 2026-07-23 onward logged one `SKIP: could not read board` line to a
// log nobody reads and called `process.exit(0)` — launchd recorded success while
// the archive grew for 8 days to a 502-card backlog, the oldest 24.4 days past
// cutoff. Living outside the repo is exactly why it broke invisibly: no test
// pinned the path, and no CI ran it.
//
// Hence: in-repo, tested, invoked through the installed CLI, dry-run by default,
// and LOUD on failure — `read_failed` is a non-zero exit, never a quiet skip.

import type { Config } from "../config.ts";
import type { NodeClient } from "../client.ts";
import { FkanbanError } from "../client.ts";
import {
  deleteCardRecordsBatch,
  listBoards,
  listCardsByColumn,
  TERMINAL_COLUMN,
  type Board,
  type Card,
  type Milestone,
} from "../record.ts";
import { proofCardRefsFrom, proofHoldReason, readProofCardRefs } from "../proof_card_refs.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "../concurrency.ts";

export const DEFAULT_ARCHIVE_CUTOFF_HOURS = 24;
/**
 * Per-run delete ceiling. Each archive is a Card delete + a CardListIndex patch
 * + a BoardCards delete, and kanban mutations measured avg 2.4s on the live
 * primary — an uncapped first run against a months-long backlog would hold the
 * write path for the better part of an hour. The sweep is daily and idempotent,
 * so a cap costs nothing but the wait.
 */
export const DEFAULT_ARCHIVE_MAX = 200;

/**
 * Fields the age verdict needs.
 *
 * `updated_at` is the ONLY age signal and it is deliberately spelled out here:
 * it is absent from `CARD_STATUS_FIELDS`, and LastDB returns "" for a field it
 * was not asked for, so a projection that omits it reports every card as
 * unparsable-age and archives NOTHING — a silent no-op that looks like a clean
 * sweep. (Cost the author of this command one wrong measurement before the
 * probe was fixed.) `deps` is here so a still-depended-on card is recognised
 * before the write, not by catching its rejection.
 */
export const ARCHIVE_AGE_FIELDS = [
  "slug",
  "board",
  "column",
  "position",
  "updated_at",
  "done_at",
  "kind",
  "tags",
  "deps",
];

export type ArchiveDoneAction = {
  slug: string;
  board: string;
  age_hours: number;
  action: "archived" | "would-archive" | "skipped-dependency" | "skipped-proof-card" | "failed" | "skipped-cap";
  reason: string;
};

export type ArchiveDoneBoardReport = {
  board: string;
  terminal_column: string;
  terminal_rows: number;
  /** Rows whose `updated_at` did not parse — cannot be aged, so never archived. */
  unparsable_age: number;
  eligible: number;
};

export type ArchiveDoneReport = {
  cutoff_hours: number;
  max: number;
  dryRun: boolean;
  boards: ArchiveDoneBoardReport[];
  /** Terminal rows across every board, before this run. */
  terminal_rows: number;
  eligible: number;
  archived: number;
  /** Eligible but left for the next run because `max` was reached. */
  deferred: number;
  skipped_dependency: number;
  /** Held back because a milestone names the card as its proof. */
  skipped_proof_card: number;
  failed: number;
  actions: ArchiveDoneAction[];
};

export type ArchiveDoneOptions = {
  cfg: Config;
  node: NodeClient;
  apply?: boolean;
  json?: boolean;
  cutoffHours?: number;
  max?: number;
  board?: string;
  /** Injected for tests / fixed-clock runs. */
  now?: number;
  boardsFor?: (node: NodeClient, cfg: Config) => Promise<Board[]>;
  cardsIn?: (
    node: NodeClient,
    cfg: Config,
    column: string,
    board: string,
  ) => Promise<Card[]>;
  remove?: (opts: { cfg: Config; node: NodeClient }, card: Card) => Promise<void>;
  /**
   * Retire a whole batch. This is the real delete path; `remove` is kept for the
   * tests that inject a per-card spy and is adapted onto this one below, so
   * there is a SINGLE call path through the sweep rather than a batched
   * production path and a serial tested one.
   */
  removeMany?: (
    opts: { cfg: Config; node: NodeClient },
    cards: Card[],
    onError?: (card: Card, err: unknown) => void,
  ) => Promise<void>;
  milestonesFor?: (node: NodeClient, cfg: Config, boards: Board[]) => Promise<Milestone[]>;
};

function ageHours(card: Card, now: number): number | null {
  // `done_at` is the truthful "entered terminal" stamp when present; fall back to
  // `updated_at`, which equals the move time for a card left untouched since.
  const stamp = card.done_at?.trim() || card.updated_at?.trim() || "";
  const t = Date.parse(stamp);
  if (!Number.isFinite(t)) return null;
  return (now - t) / 3_600_000;
}

export function renderArchiveDone(report: ArchiveDoneReport): string {
  // Count the actions, never `eligible - deferred`: `eligible` means "past the
  // cutoff", and a dependency hold removes a card from the sweep without being a
  // deferral. Deriving the headline arithmetically reported 502 would-archive on
  // the live board when 30 of those were held — the one number a human reads,
  // wrong, in the direction that makes the sweep look more effective than it is.
  const wouldArchive = report.actions.filter((a) => a.action === "would-archive").length;
  const head =
    `archive-done: terminal_rows=${report.terminal_rows} ` +
    `eligible=${report.eligible} ` +
    `${report.dryRun ? "would_archive" : "archived"}=${report.dryRun ? wouldArchive : report.archived} ` +
    `deferred=${report.deferred} ` +
    `skipped_dependency=${report.skipped_dependency} ` +
    `skipped_proof_card=${report.skipped_proof_card} ` +
    `failed=${report.failed} ` +
    `cutoff_hours=${report.cutoff_hours} max=${report.max}` +
    (report.dryRun ? " (dry-run — pass --apply to archive)" : "");
  const boards = report.boards.map(
    (b) =>
      `  ${b.board} [${b.terminal_column}] rows=${b.terminal_rows} eligible=${b.eligible}` +
      (b.unparsable_age > 0 ? ` unparsable_age=${b.unparsable_age}` : ""),
  );
  const notable = report.actions
    .filter(
      (a) =>
        a.action === "failed" ||
        a.action === "skipped-dependency" ||
        a.action === "skipped-proof-card",
    )
    .map((a) => `  ${a.action.padEnd(20)} ${a.slug} — ${a.reason}`);
  return [head, ...boards, ...notable].join("\n");
}

export async function archiveDoneResult(
  opts: ArchiveDoneOptions,
): Promise<{ text: string; report: ArchiveDoneReport }> {
  const cutoffHours = opts.cutoffHours ?? DEFAULT_ARCHIVE_CUTOFF_HOURS;
  const max = opts.max ?? DEFAULT_ARCHIVE_MAX;
  const now = opts.now ?? Date.now();
  const dryRun = opts.apply !== true;
  const boardsFor = opts.boardsFor ?? listBoards;
  const cardsIn =
    opts.cardsIn ??
    ((node, cfg, column, board) =>
      listCardsByColumn(node, cfg, column, ARCHIVE_AGE_FIELDS, board));
  const perCard = opts.remove;
  const removeMany =
    opts.removeMany ??
    (perCard
      ? async (
          o: { cfg: Config; node: NodeClient },
          batch: Card[],
          onError?: (card: Card, err: unknown) => void,
        ): Promise<void> => {
          for (const c of batch) {
            try {
              await perCard(o, c);
            } catch (err) {
              onError?.(c, err);
            }
          }
        }
      : deleteCardRecordsBatch);

  const allBoards = await boardsFor(opts.node, opts.cfg);
  const wanted = opts.board?.trim();
  const boards = wanted ? allBoards.filter((b) => b.slug === wanted) : allBoards;
  if (wanted && boards.length === 0) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `No live board "${wanted}".`,
      hint: "Run kanban board list to see live boards.",
    });
  }

  const boardReports: ArchiveDoneBoardReport[] = [];
  const actions: ArchiveDoneAction[] = [];
  // Eligible cards across every board, oldest first, so a capped run always
  // drains the coldest end of the archive rather than an arbitrary board's.
  const eligible: Array<{ card: Card; ageHours: number }> = [];

  // One terminal-column read per board, CONCURRENTLY. These are independent
  // partition reads and a read is almost entirely per-request latency, so the
  // unit of cost is the serial wave (`concurrency.ts`: ceil(N/width) x ~190ms).
  // Read one board after another this loop cost one wave per board — 34 waves
  // on an install that has carried 34 board slugs, for reads that never needed
  // to wait on each other.
  //
  // `mapWithConcurrency` lands each result at its input index, so `boardReports`
  // and `eligible` are still built in board order below and the report is
  // byte-identical to the serial version.
  const terminalRowsByBoard = await mapWithConcurrency(
    boards,
    (b) => cardsIn(opts.node, opts.cfg, TERMINAL_COLUMN, b.slug),
    PARTITION_READ_CONCURRENCY,
  );

  for (const [i, b] of boards.entries()) {
    const terminal = TERMINAL_COLUMN;
    const rows = terminalRowsByBoard[i]!;
    let unparsable = 0;
    let count = 0;
    for (const card of rows) {
      const age = ageHours(card, now);
      if (age === null) {
        unparsable += 1;
        continue;
      }
      if (age < cutoffHours) continue;
      eligible.push({ card, ageHours: age });
      count += 1;
    }
    boardReports.push({
      board: b.slug,
      terminal_column: terminal,
      terminal_rows: rows.length,
      unparsable_age: unparsable,
      eligible: count,
    });
  }

  eligible.sort((x, y) => y.ageHours - x.ageHours);

  // A card that something live still depends on must not be archived: a deleted
  // dep reads back as a MISSING dep, which flips its dependents to blocked. `rm`
  // refuses this too, but recognising it here keeps a legitimate hold out of the
  // `failed` count — a sweep that reports failures nobody can act on gets muted.
  const stillDependedOn = new Set<string>();
  {
    const depTargets = new Set<string>();
    // Flattened to (board, column) pairs and read CONCURRENTLY. Nested and
    // serial, this was the most expensive read in the sweep and the one that
    // scaled worst: boards x non-terminal columns waves, i.e. 6 on this node
    // but 102 on a 34-board install — ~19s of round trips to collect a set of
    // dep slugs, none of which depends on any other read.
    //
    // Which columns are read is unchanged: still every non-terminal column of
    // every board, with the terminal being the fixed `TERMINAL_COLUMN` used
    // above. Only the order and overlap of the reads differ, and `depTargets`
    // is a Set, so result order cannot affect the outcome.
    const depScanTargets = allBoards.flatMap((b) => {
      const terminal = TERMINAL_COLUMN;
      return b.columns.filter((col) => col !== terminal).map((col) => ({ board: b.slug, col }));
    });
    const depScanRows = await mapWithConcurrency(
      depScanTargets,
      (t) => cardsIn(opts.node, opts.cfg, t.col, t.board),
      PARTITION_READ_CONCURRENCY,
    );
    for (const rows of depScanRows) {
      for (const c of rows) for (const d of c.deps ?? []) depTargets.add(d);
    }
    for (const { card } of eligible) if (depTargets.has(card.slug)) stillDependedOn.add(card.slug);
  }

  // A card a milestone names as its proof is EVIDENCE for that milestone's
  // `proof_status`, and this sweep would otherwise delete it without knowing
  // that. Unlike the dependency hold above, state is NOT consulted: a proof
  // matters BECAUSE the milestone finished, so a `complete` milestone's proof
  // card is the one that must survive longest. See `src/proof_card_refs.ts`.
  //
  // Two partition reads (one per board), and the read throws rather than
  // answering from a wrong list when a read fails — so an unverifiable reference
  // aborts the sweep instead of archiving through it.
  const proofRefs = opts.milestonesFor
    ? proofCardRefsFrom(await opts.milestonesFor(opts.node, opts.cfg, allBoards))
    : await readProofCardRefs(opts.node, opts.cfg, allBoards);

  let archived = 0;
  let failed = 0;
  let skippedDependency = 0;
  let skippedProofCard = 0;
  let deferred = 0;
  /** Cards this run took into scope (archived, failed, or previewed) — the cap's subject. */
  let attempted = 0;
  /**
   * Cards accepted for deletion, paired with the action already recorded for
   * them. The action objects are pushed to `actions` in eligible order during
   * the loop and RESOLVED after the batch, so batching cannot reorder the
   * report relative to the per-card loop it replaced.
   */
  const pending: Array<{ card: Card; action: ArchiveDoneAction }> = [];

  for (const { card, ageHours: age } of eligible) {
    if (stillDependedOn.has(card.slug)) {
      skippedDependency += 1;
      actions.push({
        slug: card.slug,
        board: card.board,
        age_hours: Math.round(age),
        action: "skipped-dependency",
        reason: "a live card in a non-terminal column still declares this as a dep",
      });
      continue;
    }
    const proofHold = proofHoldReason(proofRefs, card.slug);
    if (proofHold) {
      skippedProofCard += 1;
      actions.push({
        slug: card.slug,
        board: card.board,
        age_hours: Math.round(age),
        action: "skipped-proof-card",
        reason: proofHold,
      });
      continue;
    }
    // Count ATTEMPTS against the cap, not successes — otherwise a dry run (which
    // never increments `archived`) reports every eligible card as in-scope and
    // promises 472 archives where `--apply` would do `max`. A dry run whose plan
    // differs from the apply it previews is worse than no dry run.
    if (attempted >= max) {
      deferred += 1;
      continue;
    }
    attempted += 1;
    if (dryRun) {
      actions.push({
        slug: card.slug,
        board: card.board,
        age_hours: Math.round(age),
        action: "would-archive",
        reason: `in ${card.column} for ${Math.round(age)}h`,
      });
      continue;
    }
    const action: ArchiveDoneAction = {
      slug: card.slug,
      board: card.board,
      age_hours: Math.round(age),
      action: "archived",
      reason: `in ${card.column} for ${Math.round(age)}h`,
    };
    actions.push(action);
    pending.push({ card, action });
  }

  if (pending.length > 0) {
    // Keyed by object IDENTITY, not slug: `eligible` spans every board, and a
    // slug holding membership on two boards would collide in a slug-keyed map
    // and mis-attribute one board's failure to the other's row.
    const failures = new Map<Card, unknown>();
    await removeMany(
      { cfg: opts.cfg, node: opts.node },
      pending.map((p) => p.card),
      (card, err) => failures.set(card, err),
    );
    for (const { card, action } of pending) {
      if (!failures.has(card)) {
        archived += 1;
        continue;
      }
      const err = failures.get(card);
      failed += 1;
      action.action = "failed";
      action.reason = err instanceof Error ? err.message.split("\n")[0]! : String(err);
    }
  }

  const report: ArchiveDoneReport = {
    cutoff_hours: cutoffHours,
    max,
    dryRun,
    boards: boardReports,
    terminal_rows: boardReports.reduce((n, b) => n + b.terminal_rows, 0),
    eligible: eligible.length,
    archived,
    deferred,
    skipped_dependency: skippedDependency,
    skipped_proof_card: skippedProofCard,
    failed,
    actions,
  };
  return { text: renderArchiveDone(report), report };
}
