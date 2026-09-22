// Heal BoardCards membership drift: list/column previews must agree with
// authoritative card column. Card HashKey point-reads are the source of
// truth for drifted candidates; CardListIndex only discovers slugs that have
// no BoardCards row yet. Unscoped/scheduled heal does not hydrate Card for
// every membership row — only BoardCards-visible drift (sparse, duplicate,
// SK mismatch, invalid column, missing membership). `--slug` still
// point-gets the named cards.
//
// This is the ONLY path that may delete BoardCards rows for "orphans."
// List/reconcile is read-only on Card miss (incident 2026-07-23/24).
// Complete-looking orphans are an accepted unscoped gap; `--slug` still reaps.

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  awaitBoardCardRowVisible,
  boardCardFieldsFromCard,
  boardCardSk,
  boardCardsHash,
  boardCardsReadDiverged,
  classifyBoardCardDuplicateRows,
  enqueueBoardCardJanitor,
  listBoardCardsPartition,
  listBoardCardsPartitionSpine,
  parseBoardCardSk,
  readBoardCardsPartitionDivergence,
  sweepBoardCardJanitor,
  sweepBoardCardsPartition,
  upsertBoardCard,
  type BoardCardsReadDivergence,
} from "../board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../schemas.ts";
import { readCardListIndex, type CardSummary } from "../card-list-index.ts";
import {
  cardExists,
  findCardSummaryForReconcile,
  findMilestone,
  isMilestoneState,
  listBoards,
  type Card,
  emptyStructuredFields,
} from "../record.ts";
import { renderSweepWrites } from "../sweep_report.ts";

/**
 * Resolve Card truth for candidate slugs, bounded-parallel.
 *
 * Truth is still one Card HashKey point-read per slug — a scan miss must never
 * authorize a delete (incident 2026-07-23/24). Unscoped heal no longer passes
 * every membership slug: only BoardCards-visible drift candidates (and
 * `--slug`) reach this function. See {@link membershipNeedsCardTruth}.
 *
 * The fan-out width lives in `concurrency.ts` — this path discovered why it has
 * to be bounded, but every other N-read path needs the same ceiling.
 */
async function resolveTruthBySlug(
  opts: BoardCardsHealOptions,
  slugs: string[],
): Promise<Map<string, Card | null>> {
  const resolved = await mapWithConcurrency(slugs, (slug) =>
    findCardSummaryForReconcile(opts.node, opts.cfg, slug),
  );
  return new Map(slugs.map((slug, i) => [slug, resolved[i] ?? null]));
}

export type BoardCardsHealOptions = {
  cfg: Config;
  node: NodeClient;
  /** Limit heal to these slugs (optional). */
  slugs?: string[];
  /** When set, only scan this board partition. */
  board?: string;
  apply?: boolean;
  json?: boolean;
  /**
   * Refuse the whole apply when this run would delete more than N orphan rows.
   * `null` disables the ceiling (`--max-removals unlimited`, matching
   * milestone-indexes-heal); omitted uses {@link resolveRemovalCeiling}.
   */
  maxRemovals?: number | null;
  /**
   * Test seam for the post-upsert visibility wait — see
   * {@link awaitBoardCardSearchVisible}'s own `sleep` option. Not a tuning
   * knob for production callers; omit it there.
   */
  visibilitySleep?: (ms: number) => Promise<void>;
};

/**
 * Default orphan-removal ceiling: `max(25, 50% of rows examined)`.
 *
 * Sized from the production record, not from the sibling command's constant.
 * `last-stack-fkanban-watch` has run `board-cards-heal --apply` hourly since
 * 2026-07-30; across 617 runs that healed anything, the **largest repair was 13
 * rows** (distribution: 1x259, 2x160, 5x66, 3x56, 4x29, 12x21, 13x9, 10x1),
 * against a ~218-row board. So on today's board the default sits at 109 — about
 * 8x the worst run ever observed, while a systemic miss (~100% of rows) is
 * refused.
 *
 * The ratio is deliberately 50%, NOT the 25% used by
 * `milestone-indexes-heal --max-removals`. Borrowing that number would have been
 * the mistake it exists to prevent: this command's own comments record a
 * legitimate one-time reap of **58 orphan rows** on 2026-07-30 (~27% of the
 * board) — the backlog the heal was built to clear. A 25% ceiling refuses that
 * run. A ceiling must clear the largest CORRECT case, and here the bootstrap
 * case is an order of magnitude larger than steady state.
 *
 * The floor exists because a bare ratio is meaningless at small N: on a 4-row
 * scratch board, 2 orphans are 50% and entirely ordinary.
 */
export const DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR = 25;
export const DEFAULT_BOARD_CARDS_HEAL_REMOVAL_RATIO = 0.5;

export function resolveRemovalCeiling(
  maxRemovals: number | null | undefined,
  rowsExamined: number,
): number {
  if (maxRemovals === null) return Number.POSITIVE_INFINITY;
  if (typeof maxRemovals === "number") return maxRemovals;
  return Math.max(
    DEFAULT_BOARD_CARDS_HEAL_REMOVAL_FLOOR,
    Math.floor(rowsExamined * DEFAULT_BOARD_CARDS_HEAL_REMOVAL_RATIO),
  );
}

/**
 * Upper bound on `delete-orphan` rows this run could write, computed from state
 * already in hand — the resolved truth map and the keyed partition rows — so the
 * ceiling costs zero additional node reads.
 *
 * Keys with no rows are the synthetic "missing membership" candidates
 * (`\0<slug>`); they are repaired by an upsert and can never delete anything.
 */
export function countPossibleOrphanRemovals(
  byKey: Map<string, { column: string; position: string }[]>,
  truthBySlug: Map<string, Card | null>,
  milestoneMembershipSlugs: ReadonlySet<string> = new Set(),
): number {
  let possible = 0;
  for (const [key, rows] of byKey) {
    if (rows.length === 0) continue;
    const slug = key.split("\0")[1] as string;
    // Rows this run has already decided it will not delete must not inflate the
    // ceiling. The ceiling is a statement of REMOVAL INTENT, and counting rows
    // the classifier skips makes a run look closer to the brake than it is —
    // on the live `default` board that is 29 of 198, enough to change whether a
    // legitimate reap is refused.
    if (milestoneMembershipSlugs.has(slug)) continue;
    if (!truthBySlug.get(slug)) possible += rows.length;
  }
  return possible;
}

/**
 * Slugs whose BoardCards-partition rows are MILESTONE membership, not card
 * membership — so heal must not read them as card orphans.
 *
 * ## Why any row in this partition can be a milestone's
 *
 * `BoardMilestones` and `BoardCards` are both `HashRange` keyed
 * `{hash_field: "board", range_field: "sk"}`. They are supposed to be separate
 * identities, and today they are (`board_milestones` pins its own hash). They
 * were not always: the 2026-07-23 declare-resolver expand bug collapsed
 * `BoardMilestones_hashrange_v1_portfolio_20260723` onto
 * `BoardCards_hashrange_v1`, and every milestone written in that window landed
 * in the identity `board_cards` still pins today (`1ef2e7a3…`). Those rows are
 * addressable, enumerable, and indistinguishable from card rows by key shape —
 * both grammars are `<segment>#<position(8)>#<slug>`.
 *
 * So heal enumerates them, point-reads Card by slug, finds nothing, and
 * classifies `delete-orphan`. Measured on the live `default` board
 * 2026-09-04: 198 rows classified orphan, of which **29 are live milestones**
 * (`kanban milestone show` renders them; `kanban show` does not). `--apply`
 * would have deleted the index rows of 29 milestones and reported it as
 * routine orphan reaping.
 *
 * ## The discriminator, and why it takes both halves
 *
 * A row is milestone membership only when BOTH hold:
 *
 *  - EVERY row for the slug has a first sk segment that is a milestone STATE
 *    ({@link isMilestoneState}). A board may legitimately declare a column
 *    named `active`, so the segment alone is not enough — but a slug with rows
 *    under a real board column is a card question, whichever else it has.
 *  - a Milestone record point-reads for the slug. The state name alone would
 *    let a dead row named `complete#…#anything` escape the reap forever, which
 *    trades one silent wrong delete for one silent wrong keep.
 *
 * Both halves are needed because they fail in opposite directions, and the
 * cheap half gates the read: only slugs that already failed the Card read AND
 * are entirely state-keyed cost a Milestone point-read. On the live board that
 * is 29 reads, not 198.
 *
 * Skipping is deliberately not repairing. Moving these rows to the
 * `board_milestones` identity is `groom milestone-indexes-heal`'s job — it owns
 * that index and its own ceiling. Heal's obligation here is only to stop
 * deleting rows it cannot prove are card orphans.
 */
async function resolveMilestoneMembershipSlugs(
  opts: BoardCardsHealOptions,
  byKey: Map<string, { column: string; position: string }[]>,
  truthBySlug: Map<string, Card | null>,
): Promise<Set<string>> {
  const candidates: string[] = [];
  for (const [key, rows] of byKey) {
    if (rows.length === 0) continue;
    const slug = key.split("\0")[1] as string;
    if (truthBySlug.get(slug)) continue;
    if (!rows.every((row) => isMilestoneState(row.column))) continue;
    candidates.push(slug);
  }
  const uniq = [...new Set(candidates)];
  const found = await mapWithConcurrency(uniq, (slug) =>
    findMilestone(opts.node, opts.cfg, slug),
  );
  return new Set(uniq.filter((_slug, i) => Boolean(found[i])));
}

export type BoardCardsHealAction = {
  slug: string;
  board: string;
  list_column: string;
  list_position: string;
  truth_column: string | null;
  truth_position: string | null;
  action:
    | "delete-orphan"
    | "skip-milestone-membership"
    | "upsert-truth"
    | "delete-stale-and-upsert"
    | "refresh-thin-fields"
    | "retire-sparse-duplicate"
    | "noop-match";
  reason: string;
};

export type BoardCardsHealReport = {
  scanned_index_rows: number;
  drifted: number;
  /**
   * Repairs ISSUED. Incremented at the write, so a dry run reports 0 — always.
   *
   * It used to be `apply ? healed : drifted`, which made a dry run report a
   * number that was wrong twice over. It claimed repairs on a run that wrote
   * nothing (`healed=4 — DRY RUN, no writes`, on the DEFAULT invocation: this
   * command applies only with `--apply`, and the ceiling-refusal text sends the
   * operator to a bare dry run to inspect). And `drifted` is not even the same
   * QUANTITY: it counts drifted (board, slug) keys, while `healed` counts
   * repairs, and the orphan branch issues one repair per ROW. A slug with three
   * orphan rows is `drifted=1` and heals 3, so the dry run under-reported the
   * apply run it was supposed to be previewing.
   */
  healed: number;
  /**
   * Repairs an `--apply` run WOULD issue, in `healed`'s units. The plan, kept in
   * its own field so no consumer loses the signal that `healed` used to carry
   * dishonestly — and the number a dry run should be compared against, because
   * `dry.would_heal === apply.healed` for the same board state.
   */
  would_heal: number;
  missing_card: number;
  /**
   * BoardCards-partition rows this run refused to classify as card orphans
   * because they are milestone membership stranded in the BoardCards identity
   * — see {@link resolveMilestoneMembershipSlugs}.
   *
   * Reported on every run, dry or apply. A non-zero value is not board damage
   * and needs no action from heal; it is the size of the `board_milestones`
   * migration still outstanding, and the number of rows an unfixed heal would
   * have deleted.
   */
  milestone_rows_skipped: number;
  /**
   * False when `board_cards` is not bound in config. Every partition read then
   * returns null and every write no-ops in `upsertBoardCard`, so the other
   * counts in this report describe nothing — see the early return.
   */
  board_cards_bound: boolean;
  /**
   * The error the candidate-discovery scan failed with, or null if it ran.
   *
   * Non-null means the "missing BoardCards membership" half of this run did not
   * happen: `missing_card`, `drifted` and every `upsert-truth` action are a
   * LOWER BOUND, and a card whose row is absent may simply never have been
   * offered as a candidate. The sibling signal for the partition-read half is
   * `incomplete_leads`; the two fail in opposite directions and both have to be
   * readable, because `missing_card: 0` means the same thing either way.
   */
  discovery_failed: string | null;
  /**
   * `<board>:<field>` for each completeness lead the node refused. Non-empty
   * means every count in this report is a LOWER BOUND — see
   * `sweepBoardCardsPartition`.
   */
  incomplete_leads: string[];
  /**
   * Per board, the whole-partition read compared against the union of its
   * per-column reads — see {@link readBoardCardsPartitionDivergence}. Reported
   * on every run, dry or apply, because a consumer that decides whether to
   * apply needs it from the DRY run.
   *
   * A non-empty `wholeOnly`/`columnOnly` means the node served two inconsistent
   * views of one partition during this run, and refuses an `--apply`. A
   * non-null `failed` is a read that threw: coverage, not disagreement, so it
   * is reported and does not block.
   */
  read_divergence: BoardCardsReadDivergence[];
  dryRun: boolean;
  /**
   * True when a safety refusal cancelled the whole apply; nothing was written.
   * {@link BoardCardsHealReport.blocked_reason} says which one.
   */
  blocked?: boolean;
  blocked_reason?: "removal-ceiling" | "read-divergence";
  removal_ceiling?: number;
  removals_possible?: number;
  /**
   * `delete-stale-and-upsert` rows this run upserted but could NOT confirm
   * visible (via {@link awaitBoardCardSearchVisible}) before the matching
   * delete would have run. The stale sibling row is left in place rather than
   * removed — see {@link BoardCardsHealReport.delete_sweep_skipped} for why
   * that is safe: this run never deletes membership it has not just verified
   * the replacement for.
   */
  unverified_upserts?: number;
  /**
   * `delete-orphan` rows this `--apply` run asked to delete that the list read
   * still returned after the sweep (and a short bounded wait). They are NOT
   * counted in `healed`. A nonzero value means the delete did not land.
   */
  unverified_deletes?: number;
  /**
   * True when the delete sweep at the end of this run was skipped because a
   * re-check of partition/column agreement — run immediately before the
   * sweep, not only at plan time — found the node's views had diverged since
   * the plan was made. Every upsert this run issued still stands; only the
   * deletes it had queued did not run, so no delete this run is ever
   * authorized by a plan later shown to be wrong.
   */
  delete_sweep_skipped?: boolean;
  actions: BoardCardsHealAction[];
};

function thinCard(summary: CardSummary | Card): Card {
  return {
    ...emptyStructuredFields(),
    slug: summary.slug,
    title: summary.title || "",
    body: "",
    board: summary.board || "default",
    column: summary.column,
    position: String(summary.position),
    assignee: summary.assignee || "",
    tags: summary.tags || [],
    deps: summary.deps || [],
    surfaces: summary.surfaces || [],
    created_at: summary.created_at || "",
    updated_at: summary.updated_at || "",
    done_at: ("done_at" in summary ? String((summary as Card).done_at || "") : "") || "",
    db: summary.db || "",
    repo: summary.repo || "",
    base: summary.base || "",
    kind: summary.kind || "",
    block_status: summary.block_status || "",
    block_reason: summary.block_reason || "",
    north_star: summary.north_star || "",
    // milestone/created_by must ride along: this Card feeds upsertBoardCard,
    // so dropping them here silently blanked the row's milestone (and reset
    // created_by to "unknown") on every heal write.
    milestone: summary.milestone ?? "",
    ...(summary.created_by !== undefined ? { created_by: summary.created_by } : {}),
    pr_url: summary.pr_url || "",
    branch: summary.branch || "",
  };
}

// Shared thin fields the BoardCards projection copies from Card truth,
// compared field-by-field when membership (sk) already matches. board /
// column / position / slug are the sk itself; body is never on a row;
// created_by is excluded because legacy-schema nodes cannot store it, which
// would flag every row on every run forever.
const THIN_COMPARE_FIELDS = [
  "title",
  "assignee",
  "tags",
  "deps",
  "surfaces",
  "created_at",
  "updated_at",
  "db",
  "repo",
  "base",
  "kind",
  "block_status",
  "block_reason",
  "north_star",
  "milestone",
  "pr_url",
  "branch",
] as const;

/**
 * Field names whose projected value differs between a BoardCards row and Card
 * truth. Both sides go through `boardCardFieldsFromCard` so the comparison is
 * exactly "what an upsert would write" vs "what the row holds".
 */
function thinFieldDrift(row: Card, truth: Card): string[] {
  const actual = boardCardFieldsFromCard(row);
  const expected = boardCardFieldsFromCard(truth);
  const drift: string[] = [];
  for (const field of THIN_COMPARE_FIELDS) {
    const a = actual[field];
    const b = expected[field];
    const equal = Array.isArray(a) || Array.isArray(b)
      ? JSON.stringify(a) === JSON.stringify(b)
      : a === b;
    if (!equal) drift.push(field);
  }
  return drift;
}

/**
 * Whether unscoped heal must HashKey-get Card for this (board, slug).
 *
 * Scheduled heal used to point-get Card for every membership row. On a ~250
 * card board that is hundreds of Card queries per hour and fails the
 * milestone bar (under 50/h). Live 2026-09-16: client
 * `kanban-groom-board-cards-heal` kind=query schema=Card CALLS=529 in 21.6 min
 * (~1470/h), LOAD/CALL=297.7. A HashKey point-get does not load ~298 shards;
 * hydrating the whole board is the cost. `--slug` already names its targets
 * and still point-gets only those.
 *
 * BoardCards-visible drift is the candidate filter. A single complete row
 * whose sk matches its copied column/position is left alone — Card vs index
 * column disagreement on that shape is an accepted gap for the unscoped
 * path (use `--slug` to force a Card read). Sparse, duplicate, SK-mismatch,
 * missing-membership, invalid-column, and milestone-state rows still
 * point-get. Complete-looking orphans are the same accepted gap as cards
 * missing from every partition AND the rollup: the hourly run must not
 * query Card for every healthy row to find them.
 */
export function membershipNeedsCardTruth(
  rows: ReadonlyArray<{ column: string; position: string; slug: string; full: Card }>,
  spineSks: readonly string[] | undefined,
  boardColumns: readonly string[] = [],
): boolean {
  if (rows.length === 0) return true;
  if (rows.length !== 1) return true;
  if ((spineSks?.length ?? 0) > 1) return true;
  const row = rows[0]!;
  if (isMilestoneState(row.column)) return true;
  if (boardColumns.length > 0 && !boardColumns.includes(row.column)) return true;
  if (!String(row.full.title ?? "").trim()) return true;
  if (!row.column || String(row.position) === "") return true;
  if (spineSks?.length === 1) {
    const reconstructed = boardCardSk(row.column, row.position, row.slug);
    if (spineSks[0] !== reconstructed) return true;
  }
  return false;
}

type HealRawRow = { board: string; column: string; position: string; slug: string; full: Card };

export async function boardCardsHealResult(
  opts: BoardCardsHealOptions,
): Promise<{ text: string; report: BoardCardsHealReport }> {
  // NOT CHECKED, not "clean". With `board_cards` unbound every partition read
  // below returns null and every repair no-ops inside `upsertBoardCard`'s
  // `if (!schemaHash) return` — but the loop still counted `drifted += 1` and
  // `healed += 1` per candidate. Measured pre-fix on a 5-entry `all_cards`
  // rollup: `scanned=0 drifted=5 healed=5`, and **0 BoardCards writes**. One
  // claimed repair per rollup entry, none of them written — a positive claim
  // rendered from an aggregate with no slot for "none of these landed."
  //
  // On a node that has already run `card-list-index-retire` the rollup is
  // empty, so the same state renders as `scanned=0 drifted=0 healed=0` — the
  // quieter half of the same defect, and the one the live primary produces
  // (measured 2026-08-05 against a config with `board_cards` removed).
  //
  // `board-list-heal` and `milestone-indexes-heal` both refuse this state by
  // name and say which schema is missing. This command was the one that did
  // not.
  if (!boardCardsHash(opts.cfg)) {
    return {
      text:
        "board-cards heal: NOT CHECKED — no `board_cards` schema hash in config, so no " +
        "partition can be read and no membership row can be written.\n" +
        "  Run `kanban init` to bind it. Nothing was scanned and nothing was repaired.",
      report: {
        scanned_index_rows: 0,
        drifted: 0,
        healed: 0,
        would_heal: 0,
        missing_card: 0,
        milestone_rows_skipped: 0,
        board_cards_bound: false,
        discovery_failed: null,
        incomplete_leads: [],
        read_divergence: [],
        dryRun: !opts.apply,
        blocked: false,
        actions: [],
      },
    };
  }

  const boards = await listBoards(opts.node, opts.cfg);
  const boardFilter = opts.board?.trim();
  let targetBoards = boardFilter
    ? boards.filter((b) => b.slug === boardFilter)
    : boards;
  if (boardFilter && targetBoards.length === 0) {
    targetBoards = [
      {
        slug: boardFilter,
        title: boardFilter,
        body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "",
        updated_at: "",
      },
    ];
  }

  const slugFilter = opts.slugs?.length ? new Set(opts.slugs) : null;
  // A named heal already has the Card HashKey. Resolve it before reading
  // BoardCards so the fast path can address only the authoritative board.
  // An unscoped heal still searches every board because it must find stale
  // cross-board membership and orphan rows.
  const namedTruth = slugFilter
    ? await resolveTruthBySlug(opts, [...slugFilter])
    : null;
  const namedBoardsKnown = Boolean(
    namedTruth && [...namedTruth.values()].every((truth) => Boolean(truth?.board)),
  );
  if (slugFilter && namedBoardsKnown && !boardFilter) {
    const truthBoards = new Set(
      [...namedTruth!.values()].map((truth) => truth!.board || "default"),
    );
    targetBoards = boards.filter((b) => truthBoards.has(b.slug));
    if (targetBoards.length === 0) {
      targetBoards = [...truthBoards].map((slug) => ({
        slug,
        title: slug,
        body: "",
        columns: ["backlog", "todo", "doing", "done"],
        created_at: "",
        updated_at: "",
      }));
    }
  }

  // Candidate slugs for "missing BoardCards row" repair. Every one is still
  // verified by a point-read of Card truth below — this set only NAMES
  // candidates, it never authorizes a write.
  //
  // No Card scan, named or unnamed. This used to run a full Card key-list
  // enumeration (`scanCardSummariesForReconcile`, list + hydrate every row)
  // on EVERY invocation, scoped or not, to catch a card missing from BOTH the
  // BoardCards partitions and the legacy rollup. Measured against the primary
  // 2026-09-04: client `kanban-groom-board-cards-heal`, schema `Card`, 108305
  // queries over 16h45m (~6465/h), 4h49m of cumulative hydrate time — LastDB
  // has no scan, and this was one in a client the node cannot distinguish
  // from a hot read path. See
  // papercut-fkanban-board-cards-heal-slug-still-scans-card-list-20260903.
  //
  // `--slug <s>` already knows exactly which cards to heal, so it seeds the
  // candidate set directly and skips discovery (including the rollup read)
  // entirely — there is nothing to discover when the caller already named
  // the target.
  //
  // Without `--slug`, the legacy `all_cards` rollup remains the only
  // still-cheap discovery source: one point-read of a single document, not an
  // enumeration. It is frozen wherever `board_cards` is bound
  // (`cardListIndexIsSuperseded` — every node in production today), so on
  // those nodes it holds whatever it did at cutover, typically empty. That is
  // an accepted, explicit gap this change reopens: a card whose Card record
  // is live but carries NO BoardCards row on ANY board, and is also absent
  // from the frozen rollup, is not discoverable by this command without a
  // scan. BoardCards HashRange (the per-board partition reads below) remains
  // the membership source for every slug that DOES have a row somewhere,
  // scoped or not.
  const candidateSlugs = new Set<string>();
  // Always null now — nothing left in this function can fail to discover.
  // Kept on the report shape for API stability (see `discoveryWarn` below,
  // which stays dead code until a future discovery source needs it again).
  const discoveryFailed: string | null = null;
  if (slugFilter) {
    for (const slug of slugFilter) candidateSlugs.add(slug);
  } else {
    const indexed = (await readCardListIndex(opts.node, opts.cfg)) ?? [];
    for (const c of indexed) {
      if (c.slug) candidateSlugs.add(c.slug);
    }
  }

  // Raw BoardCards partitions (may include multi-row orphans per slug).
  // `full` keeps the parsed row so the thin-field comparison below can judge
  // the projection's copied fields, not just its membership sk.
  const rawRows: HealRawRow[] = [];
  // `<board>:<field>` for every completeness lead the node refused. Each one
  // means this run's view of that partition is a lower bound.
  const incompleteLeads: string[] = [];
  // Two reads of each target partition, taken by different node access paths,
  // recorded so the apply below can refuse when they disagree. Collected here
  // because heal is already in this loop holding the board's column list.
  const readDivergence: BoardCardsReadDivergence[] = [];
  // Partitions we actually read end-to-end. Only for these can heal claim to
  // know every row for a slug and skip the per-write orphan rescan; a partition
  // that failed to list (or a board with no Board record) keeps the defensive
  // purge, because there heal is as blind as any single-card writer.
  const enumeratedBoards = new Set<string>();
  // `board\0slug` → every REAL range key the spine returned for that slug on
  // that partition. The spine is the only read that sees sparse rows, so this
  // is the only place a second membership row for a slug can be observed. A
  // slug with two or more entries is a duplicate candidate, retired by its own
  // pass below — the question it answers ("does a whole sibling carry this
  // membership?") is different from, and safer than, the orphan reap.
  //
  // Collected here rather than re-listed later: heal already holds the
  // partition, and re-reading it per duplicate slug would make partition reads
  // scale with rows repaired (see heal-orphan-reap-partition-rescan.test.ts).
  const spineSksBySlug = new Map<string, string[]>();
  for (const b of targetBoards) {
    if (slugFilter) {
      // A named heal does not need a board census. Read the narrow spine once,
      // then read only columns that contain the requested slug. This avoids
      // the 24-lead completeness sweep and the whole-board divergence probe,
      // which made a one-card verification exceed its 10-second bar.
      const spine = await listBoardCardsPartitionSpine(opts.node, opts.cfg, b.slug);
      if (!spine) continue;
      enumeratedBoards.add(b.slug);
      const matches = spine.filter((row) => slugFilter.has(row.slug));
      for (const row of matches) {
        const key = `${b.slug}\0${row.slug}`;
        const sks = spineSksBySlug.get(key) ?? [];
        if (row.sk.length > 0 && !sks.includes(row.sk)) sks.push(row.sk);
        spineSksBySlug.set(key, sks);
      }

      const columns = [...new Set(matches.map((row) => row.column).filter(Boolean))];
      const wideParts = await Promise.all(
        columns.map((column) =>
          listBoardCardsPartition(opts.node, opts.cfg, b.slug, {
            column,
            fields: BOARD_CARDS_FIELDS,
          }),
        ),
      );
      const wideRows = wideParts.flatMap((part) =>
        (part ?? []).filter((row) => slugFilter.has(row.slug)),
      );
      const wideAddresses = new Set(
        wideRows.map((row) => `${row.slug}\0${row.column}\0${row.position}`),
      );
      for (const row of wideRows) {
        rawRows.push({
          board: b.slug,
          column: row.column,
          position: String(row.position),
          slug: row.slug,
          full: row,
        });
      }
      // A sparse row can disappear from the wide projection. Keep its physical
      // address from the spine so Card truth can authorize a safe repair.
      for (const row of matches) {
        if (wideAddresses.has(`${row.slug}\0${row.column}\0${row.position}`)) continue;
        rawRows.push({
          board: b.slug,
          column: row.column,
          position: row.position,
          slug: row.slug,
          full: thinCard({
            slug: row.slug,
            title: "",
            body: "",
            board: b.slug,
            column: row.column,
            position: row.position,
            assignee: "",
            tags: [],
            deps: [],
            created_at: "",
            updated_at: "",
            ...emptyStructuredFields(),
          }),
        });
      }
      continue;
    }

    // Explicit full write shape: heal's wide pass must project every atom so
    // sparse/partial rows are catalogued against the product drop gate (see
    // the SPARSE ROWS block below). Default partition projection is list-width
    // only and would under-report fields heal rewrites.
    const part = await listBoardCardsPartition(opts.node, opts.cfg, b.slug, {
      fields: BOARD_CARDS_FIELDS,
    });
    if (!part) continue;
    enumeratedBoards.add(b.slug);
    // Before anything is classified: does this node agree with itself about
    // which rows this partition holds? A degraded page is silent — no error, no
    // `truncated` flag — so the only way to see it is to ask twice by different
    // routes and compare.
    const divergence = await readBoardCardsPartitionDivergence(
      opts.node,
      opts.cfg,
      b.slug,
      b.columns ?? [],
    );
    if (divergence) readDivergence.push(divergence);
    const seenSlugs = new Set<string>();
    for (const c of part) {
      seenSlugs.add(c.slug);
      rawRows.push({
        board: c.board || b.slug,
        column: c.column,
        position: String(c.position),
        slug: c.slug,
        full: c,
      });
    }

    // SPARSE ROWS. The wide read above projects all 24 BoardCards fields, so a
    // row missing an atom on the field that LEADS that projection is dropped
    // from it — silently, with no error. A row that predates a field the catalog
    // later added is therefore invisible to the wide read, and heal — the ONLY
    // path allowed to delete orphans — could never see the orphans it exists to
    // reap. Measured on the live board 2026-07-30: 58 orphan rows present,
    // `missing_card: 0` reported.
    //
    // This read has now been wrong twice in the same direction, each time by
    // being narrower than the last while still being a filter:
    //
    //   - the five-field spine lost 19 of 357 rows (2026-08-01), because
    //     `board`/`sk` are payload COPIES of the key and a partial write leaves
    //     a row keyed with neither;
    //   - `BOARD_CARDS_ADDRESS_FIELDS` (`["slug"]`) narrowed that to one field
    //     and was called "the narrowest available" — true, and still a filter on
    //     `slug`. It cannot see a row whose only atom is something else, and on
    //     the live `default` partition exactly such a row exists:
    //     `todo#00007777#debug-protein`, one `title` atom, no Card record, the
    //     precise orphan shape this block reaps. Every projection in the file
    //     missed it; the union over leading fields finds it.
    //
    // So the enumeration is no longer a projection at all. See
    // {@link listBoardCardsPartitionComplete} for the measured rule (the LEADING
    // projected field gates the row; `milestone` gates from any position) and
    // why N fields require N queries.
    //
    // Each sparse row falls through the SAME decision below as any other: no
    // Card truth → delete-orphan; Card truth present → thin-field drift →
    // upsert, which rewrites the row with every field and backfills what it was
    // missing.
    //
    // A refused lead leaves the enumeration short, and heal proceeds anyway:
    // every delete below is authorized by a Card point-read on a row heal can
    // SEE, so rows it cannot see are rows it cannot delete. Under-reaping is the
    // safe direction. It is still reported — a partition that keeps coming back
    // incomplete is a storage problem, not a heal problem, and silence would
    // make the next run's `missing_card: 0` look like convergence.
    const sweep = await sweepBoardCardsPartition(opts.node, opts.cfg, b.slug);
    if (!sweep) continue;
    for (const f of sweep.failedLeads) {
      incompleteLeads.push(`${b.slug}:${f.field}`);
    }
    const spine = sweep.rows;
    for (const s of spine) {
      const board = s.board || b.slug;
      // Dedupe by SLUG, not by sort key. The obvious thing — recompute the wide
      // row's sk from its column/position fields and compare — is wrong here:
      // those copied fields drifting from the sk is precisely the corruption
      // this heal repairs, so on exactly the damaged rows the recomputed key
      // misses and the same physical row gets added twice. A phantom duplicate
      // then reads as a stale sibling and gets "repaired" by deletion.
      //
      // Slug-level dedupe is narrower — a slug with one visible row and one
      // sparse row keeps only the visible one this pass — and it cannot invent
      // a row. Conservative is correct when the failure mode is deleting live
      // membership.
      //
      // It used to say the sparse sibling stayed "reachable on a later pass
      // once the visible one converges". It does not: convergence is when heal
      // STOPS acting on a slug, so a healthy card's sparse duplicate is skipped
      // on this pass and on every future one. The duplicate pass below retires
      // those, off the row addresses recorded here.
      //
      // NOTE `seenSlugs.has` is NOT the duplicate signal — every slug the wide
      // read returned is in it, because both reads cover the same partition.
      // The signal is this slug having more than one ROW, which only the spine
      // can show.
      const key = `${b.slug}\0${s.slug}`;
      const sks = spineSksBySlug.get(key) ?? [];
      if (s.sk.length > 0 && !sks.includes(s.sk)) sks.push(s.sk);
      spineSksBySlug.set(key, sks);
      if (seenSlugs.has(s.slug)) continue;
      rawRows.push({
        board,
        column: s.column,
        position: s.position,
        slug: s.slug,
        // Deliberately empty beyond the spine: this row's other fields are
        // genuinely absent on the node, so an empty `full` is the truthful
        // projection. Drift comparison will see it and rewrite from Card.
        full: thinCard({
          slug: s.slug,
          title: "",
          body: "",
          board,
          column: s.column,
          position: s.position,
          assignee: "",
          tags: [],
          deps: [],
          surfaces: [],
          created_at: "",
          updated_at: "",
          first_doing_at: "",
          db: "",
          repo: "",
          base: "",
          kind: "",
          block_status: "",
          block_reason: "",
          north_star: "",
          pr_url: "",
          branch: "",
        }),
      });
    }
  }

  const byKey = new Map<string, typeof rawRows>();
  for (const row of rawRows) {
    const k = `${row.board}\0${row.slug}`;
    const arr = byKey.get(k) ?? [];
    arr.push(row);
    byKey.set(k, arr);
  }

  // Truth slugs with no BoardCards row yet (missing membership).
  //
  // "No row yet" is decided against the partitions heal actually read, not
  // against a board the scan guessed. Two things follow, and both used to be
  // wrong when the guess was wrong:
  //
  //  - A slug that HAS a row somewhere is not missing membership. Keying the
  //    candidate under a guessed board could mint a second key for a card whose
  //    row was already correct on another board, and an entry with no rows
  //    reads three branches down as "missing BoardCards membership" — a
  //    spurious repair, and a redundant wide write under `--apply`.
  //  - `--board X` must not drop a card because the scan failed to say `X`. A
  //    blank board is "unknown", and unknown may not deny a card its place in
  //    the candidate set. The filter moves to the truth-bearing loop below,
  //    where `truthBoard` can answer it.
  //
  // The board is left EMPTY in the synthetic key on purpose: nothing may read a
  // board off a key that no partition row backs. Every branch that consumes
  // `boardFromKey` requires `rows.length > 0`; the repair itself is authored by
  // `truthBoard`.
  //
  // COST. Deferring the `--board` filter to truth means a candidate cannot be
  // excluded before its point read — and on a small board that turned every
  // discovered slug into one: `--board agent-dogfood-scratch` measured 16 point
  // reads before, 411 after. So "does this slug have membership at all" is
  // answered the cheap way instead, with one SPINE read per board heal did not
  // already enumerate. The spine is the NARROWEST projection (see the
  // sparse-row note above — narrowest, not drop-free), which is what a
  // membership census needs, and it costs one keyed partition read to skip
  // several hundred point reads: the same run measures 81 after this, against
  // 16 before.
  //
  // A slug membered on ANOTHER board is deliberately not a candidate here: a
  // row on the wrong board is stale membership, which is the unfiltered run's
  // business (or `--board <that board>`), not a missing row on this one.
  // `--board X` means "only scan this board partition".
  const memberedAnywhere = new Set(rawRows.map((r) => r.slug));
  const enumeratedSlugSources = new Set(targetBoards.map((b) => b.slug));
  for (const b of boards) {
    if (enumeratedSlugSources.has(b.slug)) continue;
    if (slugFilter && namedBoardsKnown) continue;
    // Spine, not the complete sweep, and the asymmetry is deliberate. This set
    // only SUPPRESSES candidates, so a row it misses can cost at most one extra
    // repair — heal writes a row here for a slug that turned out to be membered
    // elsewhere. The scan above authorizes DELETES, where a missed row is
    // permanent invisibility. Buying completeness at 24 queries per non-target
    // board to avoid an over-repair is the wrong trade in the safe direction.
    const spine = await listBoardCardsPartitionSpine(opts.node, opts.cfg, b.slug);
    for (const s of spine ?? []) if (s.slug) memberedAnywhere.add(s.slug);
  }

  for (const slug of candidateSlugs) {
    if (slugFilter && !slugFilter.has(slug)) continue;
    if (memberedAnywhere.has(slug)) continue;
    byKey.set(`\0${slug}`, []);
  }

  const actions: BoardCardsHealAction[] = [];
  let healed = 0;
  // The plan, counted where the write is decided rather than derived afterwards
  // from `actions` or `drifted`. Both of those are in different units — actions
  // include `noop-match`, `drifted` counts keys — and a derived plan is exactly
  // the shape that let the dry run disagree with the apply run it previews.
  let would_heal = 0;
  let missing_card = 0;
  let milestone_rows_skipped = 0;
  let drifted = 0;
  let unverified_upserts = 0;
  /** Orphan rows this run asked the sweep to delete, re-read after the sweep. */
  const orphanDeletes: Array<{ board: string; slug: string }> = [];
  let unverified_deletes = 0;
  // Set whenever this run enqueues a janitor delete. Gates the pre-sweep
  // divergence recheck below so a run that healed only by upsert (no deletes
  // queued) does not pay for two extra partition reads it has no use for.
  let deletesEnqueued = false;

  // Card HashKey only for slugs that already look drifted (or `--slug`).
  // Unscoped heal used to point-get every membership slug; that is the
  // 529 Card queries / 21 min the scheduled client still emits. A single
  // complete BoardCards row whose sk matches its copies is not a candidate.
  const columnsByBoard = new Map<string, string[]>();
  for (const b of boards) columnsByBoard.set(b.slug, b.columns ?? []);
  for (const b of targetBoards) {
    if (!columnsByBoard.has(b.slug)) columnsByBoard.set(b.slug, b.columns ?? []);
  }
  const truthSlugSet = new Set<string>();
  if (slugFilter) {
    for (const key of byKey.keys()) {
      const slug = key.split("\0")[1] as string;
      if (slug) truthSlugSet.add(slug);
    }
  } else {
    for (const [key, rows] of byKey) {
      const [boardFromKey, slug] = key.split("\0") as [string, string];
      if (
        membershipNeedsCardTruth(
          rows,
          spineSksBySlug.get(key),
          columnsByBoard.get(boardFromKey) ?? [],
        )
      ) {
        truthSlugSet.add(slug);
      }
    }
  }
  const truthBySlug = slugFilter
    ? namedTruth!
    : await resolveTruthBySlug(opts, [...truthSlugSet]);
  const classifiedByKey = new Map(
    [...byKey].filter(([key]) => truthSlugSet.has(key.split("\0")[1] as string)),
  );

  // Resolved BEFORE the removal ceiling, because it changes what the ceiling is
  // counting: these rows are not removal intent.
  const milestoneMembershipSlugs = await resolveMilestoneMembershipSlugs(
    opts,
    classifiedByKey,
    truthBySlug,
  );

  // READ-DIVERGENCE REFUSAL — before the first write, and before the ceiling,
  // because it invalidates a different thing. The ceiling asks "is this repair
  // plan too large to be believed?"; this asks "did the reads the plan is built
  // on describe one board?". A plan built on two disagreeing views is not too
  // large, it is unfounded, and its upserts are as suspect as its deletes.
  //
  // Refusing rather than repairing-the-safe-subset is deliberate. There is no
  // safe subset: the incident's degraded read produced BOTH a delete for a live
  // card and a skipped reap for a real ghost, so "act on what both reads agree
  // about" would still have written on a view known to be wrong. The board is
  // not damaged by waiting — heal is hourly, the rows returned by themselves
  // after the daemon restarted, and the run that comes back finds them.
  //
  // The refusal is PER PARTITION. One board whose two reads disagree says
  // nothing about another board's partition, and blocking every board on one
  // bad partition left the `default` board unrepaired for days while
  // `agent-dogfood-scratch` served 2 column-only rows
  // (papercut-board-cards-heal-inconsistent-partition-read-20260921). A
  // diverged board gets no writes at all; the run blocks only when every
  // target board diverged.
  const diverged = readDivergence.filter(boardCardsReadDiverged);
  const divergedBoards = new Set(diverged.map((d) => d.board));
  const healthyTargets = targetBoards.filter((b) => !divergedBoards.has(b.slug));
  if (opts.apply && diverged.length > 0 && healthyTargets.length === 0) {
    const blockedReport: BoardCardsHealReport = {
      scanned_index_rows: rawRows.length,
      drifted: 0,
      healed: 0,
      would_heal: 0,
      missing_card: 0,
      milestone_rows_skipped: 0,
      board_cards_bound: true,
      discovery_failed: discoveryFailed,
      incomplete_leads: incompleteLeads,
      read_divergence: readDivergence,
      dryRun: false,
      blocked: true,
      blocked_reason: "read-divergence",
      actions: [],
    };
    const detail = diverged.map(
      (d) =>
        `  ${d.board}: ${d.wholeOnly.length} row(s) only the whole-partition read saw, ` +
        `${d.columnOnly.length} only a column read saw ` +
        `(columns probed: ${d.columnsProbed.join(",") || "none"})`,
    );
    // Exit 0 with `blocked: true` — a safety refusal is not an error, matching
    // the removal ceiling, board-cards-heal-scheduled and milestone-indexes-heal.
    return {
      text: [
        `board-cards heal: scanned=${rawRows.length} BLOCKED — the node served ` +
        `inconsistent views of ${diverged.length} partition(s)`,
        ...detail,
        `  Nothing was written. Two reads of one partition disagreeing means this`,
        `  run cannot tell a stale row from an unseen one, and heal deletes on`,
        `  exactly that distinction.`,
        `  This is a node-side read degradation, not board damage: re-run when the`,
        `  reads agree. Do not restart anything on this signal alone.`,
      ].join("\n"),
      report: blockedReport,
    };
  }

  // SAFETY CEILING — read the run's removal intent before the first write.
  //
  // Every delete below is authorized per row by two reads (the wide point-read
  // above, then `cardExists`, which projects the hash key alone and so cannot
  // false-negative). That guard is sound against a WRONG row. It is no guard at
  // all against a SYSTEMIC miss — a config aimed at the wrong node or an empty
  // Card plane makes every point-read legitimately return nothing, `cardExists`
  // agree, and the run reap the entire board's membership one correctly-reasoned
  // row at a time. The ceiling is the only defense for that class, which is why
  // it is sized to catch "most of the board" rather than "more than usual".
  //
  // Counted on `delete-orphan` ALONE. `delete-stale-and-upsert` and
  // `retire-sparse-duplicate` also delete rows, but both leave the card membered
  // — the write that replaces the row is part of the same repair. `delete-orphan`
  // is the only action that ends with the card on no board, and nothing
  // re-derives it (same rule as milestone-indexes-heal's `--max-removals`:
  // the brake belongs on the operations whose damage is unbounded).
  //
  // The count is an UPPER BOUND: `cardExists` may still veto individual rows as
  // sparse-not-orphan (line ~482), so actual removals can be fewer, never more.
  // Bounding the safe direction is the point — and the slack is small in
  // practice: 0 sparse-veto rows of 218 on the live board, 2026-08-03.
  const removalCeiling = resolveRemovalCeiling(opts.maxRemovals, rawRows.length);
  const removalsPossible = countPossibleOrphanRemovals(
    classifiedByKey,
    truthBySlug,
    milestoneMembershipSlugs,
  );
  if (opts.apply && removalsPossible > removalCeiling) {
    const blockedReport: BoardCardsHealReport = {
      scanned_index_rows: rawRows.length,
      drifted: 0,
      healed: 0,
      // Not the classification either: the refusal's whole premise is that this
      // run's classification is the thing in doubt, so publishing it as a repair
      // plan would launder it. `removals_possible` carries the intent, under a
      // name that does not promise the rows are really orphans.
      would_heal: 0,
      missing_card: 0,
      milestone_rows_skipped: 0,
      board_cards_bound: true,
      discovery_failed: discoveryFailed,
      incomplete_leads: incompleteLeads,
      read_divergence: readDivergence,
      dryRun: false,
      blocked: true,
      blocked_reason: "removal-ceiling",
      removal_ceiling: removalCeiling,
      removals_possible: removalsPossible,
      actions: [],
    };
    // Exit 0 with `blocked: true` — a safety refusal is not an error, matching
    // board-cards-heal-scheduled and milestone-indexes-heal.
    const blockedText = [
      `board-cards heal: scanned=${blockedReport.scanned_index_rows} BLOCKED — ` +
      `${removalsPossible} orphan removal(s) exceed the ceiling of ${removalCeiling}`,
      `  Nothing was written. An index this far from truth is exactly where the`,
      `  classification itself is in doubt, so its upserts are not trusted either.`,
      `  Inspect with a dry run, then re-run with --max-removals N|unlimited.`,
    ].join("\n");
    return { text: blockedText, report: blockedReport };
  }

  for (const [key, rows] of byKey) {
    const [boardFromKey, slug] = key.split("\0") as [string, string];
    const board = boardFromKey || "default";
    if (opts.apply && boardFromKey && divergedBoards.has(board)) continue;

    if (!truthSlugSet.has(slug)) {
      if (opts.json && rows.length === 1) {
        actions.push({
          slug,
          board,
          list_column: rows[0]!.column,
          list_position: rows[0]!.position,
          truth_column: rows[0]!.column,
          truth_position: rows[0]!.position,
          action: "noop-match",
          reason: "BoardCards row is internally consistent; Card point-get skipped",
        });
      }
      continue;
    }

    const point = truthBySlug.get(slug) ?? null;
    if (!point) {
      if (rows.length === 0) continue;

      // NOT A CARD AT ALL. A milestone's membership row shares this partition's
      // key shape (see {@link resolveMilestoneMembershipSlugs}), so "no Card
      // record" is the expected reading of a healthy row, not evidence of an
      // orphan. Reported and left alone — heal does not own the
      // `board_milestones` index and must not delete on its behalf.
      if (milestoneMembershipSlugs.has(slug)) {
        for (const row of rows) {
          actions.push({
            slug,
            board,
            list_column: row.column,
            list_position: row.position,
            truth_column: null,
            truth_position: null,
            action: "skip-milestone-membership",
            reason:
              "row is milestone membership in the BoardCards identity " +
              `(state "${row.column}", Milestone record present); not a card orphan`,
          });
          milestone_rows_skipped += 1;
        }
        continue;
      }

      // CONFIRM the absence before reaping. This branch deletes board
      // membership, so it takes a second, independent read before acting.
      //
      // It was written against a projection rule that is false on Card ("a wide
      // read drops a sparse row"); `scripts/probe-card-projection-sparse.ts`
      // measured a 5-of-23-atom live row coming back from the 23-field read, so
      // the wide point-read above does NOT false-negative on sparseness. What
      // the two reads still disagree about is the post-delete husk: the wide
      // read drops it (`isKeyOnlyRow`), `cardExists` cannot see it as anything
      // but a live card, and so this branch SKIPS inside the 113–1072ms window
      // rather than reaping. The next run reaps it. See {@link cardExists}.
      if (await cardExists(opts.node, opts.cfg, slug)) {
        for (const row of rows) {
          actions.push({
            slug,
            board,
            list_column: row.column,
            list_position: row.position,
            truth_column: null,
            truth_position: null,
            action: "noop-match",
            reason:
              "card is present on a slug-only read but absent from the wide " +
              "projection — most likely a delete still settling; refusing to delete membership",
          });
        }
        continue;
      }

      missing_card += 1;
      drifted += 1;
      // Delete by the REAL range keys the completeness sweep captured, the
      // same rule the delete-stale branch follows. Rebuilding the key from the
      // row's copied `position` targets a key that never existed when that
      // copy is empty or refreshed: the legacy ghost rows carry
      // `position: ""` while their physical key holds a real position, so a
      // rebuilt `backlog#000…#slug` delete acked, healed=N was reported, and
      // the rows survived for weeks
      // (papercut-fkanban-board-cards-heal-apply-reports-healed-but-orphan-row-survives-20260921).
      const orphanExactSks = spineSksBySlug.get(`${boardFromKey}\0${slug}`) ?? [];
      let orphanEnqueued = false;
      for (const row of rows) {
        actions.push({
          slug,
          board,
          list_column: row.column,
          list_position: row.position,
          truth_column: null,
          truth_position: null,
          action: "delete-orphan",
          reason: "card point-read missing; BoardCards row is orphan",
        });
        would_heal += 1;
        if (opts.apply) {
          // Same exhaustiveness claim the delete-stale branch below makes, and
          // for the same reason: `rows` is already every row this slug has on
          // an enumerated partition, so the targeted delete is complete and
          // `removeBoardCard`'s defensive rescan can only re-read what heal
          // just read. On THIS branch the rescan is worse than redundant — it
          // lists at the spine projection, which is precisely the read that
          // DROPS sparse rows, and sparse orphans are what delete-orphan
          // exists to reap. It hunts, at a whole partition per row, for
          // exactly the rows it cannot see.
          const schemaHash = boardCardsHash(opts.cfg);
          if (schemaHash) {
            const sks = orphanExactSks.length > 0
              ? (orphanEnqueued ? [] : orphanExactSks)
              : [boardCardSk(row.column, row.position, slug)];
            enqueueBoardCardJanitor(sks.map((sk) => ({ schemaHash, board, sk })));
            orphanEnqueued = true;
            deletesEnqueued = true;
            orphanDeletes.push({ board, slug });
          }
          healed += 1;
        }
      }
      continue;
    }

    const truth = thinCard({ ...point, body: "" });
    const truthBoard = truth.board || "default";

    // `--board X` for a candidate with no membership row anywhere. Which board
    // it belongs to is truth's to say — the discovery scan does not establish
    // `board`, so this cannot be answered before the point read above. Rows
    // that DO exist were already narrowed by partition (`targetBoards`).
    if (rows.length === 0 && boardFilter && truthBoard !== boardFilter) continue;
    if (opts.apply && divergedBoards.has(truthBoard)) continue;

    const truthSk = boardCardSk(truth.column, truth.position, truth.slug);
    const matching = rows.filter(
      (r) =>
        (r.board || "default") === truthBoard &&
        boardCardSk(r.column, r.position, r.slug) === truthSk,
    );
    const stale = rows.filter(
      (r) =>
        !(
          (r.board || "default") === truthBoard &&
          boardCardSk(r.column, r.position, r.slug) === truthSk
        ),
    );

    if (stale.length === 0 && matching.length === 1) {
      // Membership (sk) matches — but the row also COPIES shared thin fields
      // (title, kind, block_status, milestone, …), and a partial dual-write
      // can leave those stale while column/position still agree. Before this
      // check the heal reported drifted=0 on rows whose copied fields were
      // wrong, so that drift class was invisible to it
      // (papercut-pickup-write-guard-failing-cards-poison-queue-head, item 3).
      const drift = thinFieldDrift(matching[0]!.full, truth);
      if (drift.length > 0) {
        drifted += 1;
        actions.push({
          slug,
          board: truthBoard,
          list_column: matching[0]!.column,
          list_position: matching[0]!.position,
          truth_column: truth.column,
          truth_position: String(truth.position),
          action: "refresh-thin-fields",
          reason: `thin field drift: ${drift.join(",")}`,
        });
        would_heal += 1;
        if (opts.apply) {
          await upsertBoardCard(opts.node, opts.cfg, truth, null, {
            skipOrphanPurge: enumeratedBoards.has(truthBoard),
          });
          healed += 1;
        }
        continue;
      }
      if (opts.json) {
        actions.push({
          slug,
          board,
          list_column: matching[0]!.column,
          list_position: matching[0]!.position,
          truth_column: truth.column,
          truth_position: String(truth.position),
          action: "noop-match",
          reason: "BoardCards row matches truth",
        });
      }
      continue;
    }

    if (stale.length === 0 && matching.length === 0 && rows.length === 0) {
      // No BoardCards row at all — need upsert.
      drifted += 1;
      actions.push({
        slug,
        board: truthBoard,
        list_column: "(missing)",
        list_position: "",
        truth_column: truth.column,
        truth_position: String(truth.position),
        action: "upsert-truth",
        reason: "missing BoardCards membership for truth column",
      });
      would_heal += 1;
      if (opts.apply) {
        // rows.length === 0 on a partition heal listed in full: there is
        // provably nothing to purge, so skip the rescan. This is the bulk of a
        // real heal (241 of 241 repairs on the primary, 2026-07-28), and the
        // rescan it replaces is a whole-partition read per card.
        await upsertBoardCard(opts.node, opts.cfg, truth, null, {
          skipOrphanPurge: enumeratedBoards.has(truthBoard),
        });
        healed += 1;
      }
      continue;
    }

    drifted += 1;
    const listCol = stale[0]?.column ?? matching[0]?.column ?? rows[0]?.column ?? "(missing)";
    const listPos = stale[0]?.position ?? matching[0]?.position ?? rows[0]?.position ?? "";
    actions.push({
      slug,
      board: truthBoard,
      list_column: listCol,
      list_position: listPos,
      truth_column: truth.column,
      truth_position: String(truth.position),
      action: "delete-stale-and-upsert",
      reason:
        stale.length > 0
          ? `stale BoardCards row(s) column=${stale.map((s) => s.column).join(",")} truth=${truth.column}`
          : "duplicate/mismatch BoardCards rows",
    });

    would_heal += 1;
    if (opts.apply) {
      // UPSERT — then VERIFY — then enqueue the delete. The stale row and the
      // truth row are different sks by construction (that is what "stale"
      // means here), so this never targets the row just written. What it
      // guards against is a write that acks but is not yet — or never —
      // visible through the same reads heal itself trusts: authorizing a
      // delete on an unverified upsert is exactly how a heal can reduce a
      // card's membership to zero while reporting success. See
      // papercut-kanban-board-cards-heal-apply-deletes-all-membership-and-the-upsert-never-lands-20260904.
      await upsertBoardCard(opts.node, opts.cfg, truth, null, {
        skipOrphanPurge: enumeratedBoards.has(truthBoard),
      });
      const upsertVisible = await awaitBoardCardRowVisible(
        opts.node,
        opts.cfg,
        truth,
        opts.visibilitySleep ? { sleep: opts.visibilitySleep } : undefined,
      );
      if (upsertVisible) {
        // Delete by the REAL range keys captured by the completeness sweep, not
        // by rebuilding keys from the row's copied payload fields. Protein
        // folding can refresh an old row's copied `position` while the physical
        // key stays at its prior column/position. Rebuilding then targets a key
        // that never existed, reports a successful repair, and leaves the stale
        // membership behind forever.
        const exactSks = spineSksBySlug.get(`${boardFromKey}\0${slug}`) ?? [];
        const schemaHash = boardCardsHash(opts.cfg);
        if (schemaHash && exactSks.length > 0) {
          enqueueBoardCardJanitor(
            exactSks.map((sk) => ({ schemaHash, board: boardFromKey, sk })),
          );
          deletesEnqueued = true;
        } else if (schemaHash) {
          // A refused sweep lead can leave a row visible only to the wide read.
          // Enqueue the rows this pass already listed — no partition rescan.
          enqueueBoardCardJanitor(
            rows.map((row) => ({
              schemaHash,
              board: row.board || boardFromKey,
              sk: boardCardSk(row.column, row.position, slug),
            })),
          );
          deletesEnqueued = true;
        }
      } else {
        // Leave the stale row(s) in place. The card still has membership
        // through them; the next heal run re-reads truth fresh and repairs
        // this slug again, this time (or eventually) with a verifiable upsert.
        unverified_upserts += 1;
      }
      healed += 1;
    }
  }

  // SPARSE DUPLICATES. A slug whose whole row is already correct reports no
  // drift, so nothing above ever touches it — and its sparse sibling is
  // membership nothing can remove. Retire those here, and only where a whole
  // sibling is confirmed to carry the membership the delete would otherwise
  // drop. `classifyBoardCardDuplicateRows` refuses on 0 or 2+ whole rows, so
  // this pass acts only on the unambiguous case.
  for (const [key, sks] of spineSksBySlug) {
    if (sks.length < 2) continue;
    const [board, slug] = key.split("\0") as [string, string];
    if (opts.apply && divergedBoards.has(board)) continue;
    const dup = await classifyBoardCardDuplicateRows(opts.node, opts.cfg, board, slug, sks);
    if (!dup || dup.sparseSks.length === 0) continue;
    drifted += 1;
    actions.push({
      slug,
      board,
      list_column: parseBoardCardSk(dup.sparseSks[0]!)?.column ?? "",
      list_position: parseBoardCardSk(dup.sparseSks[0]!)?.position ?? "",
      truth_column: parseBoardCardSk(dup.keepSk)?.column ?? null,
      truth_position: parseBoardCardSk(dup.keepSk)?.position ?? null,
      action: "retire-sparse-duplicate",
      reason:
        `${dup.sparseSks.length} sparse duplicate row(s) [${dup.sparseSks.join(", ")}] ` +
        `— membership carried by whole row ${dup.keepSk}`,
    });
    would_heal += 1;
    if (opts.apply) {
      // By address, not by purge: heal already holds the partition, and
      // `purgeOtherBoardCardRows` would re-list it once per duplicate slug.
      const schemaHash = boardCardsHash(opts.cfg);
      if (schemaHash) {
        enqueueBoardCardJanitor(
          dup.sparseSks.map((sk) => ({ schemaHash, board, sk })),
        );
        deletesEnqueued = true;
      }
      healed += 1;
    }
  }

  let deleteSweepSkipped = false;
  if (opts.apply && deletesEnqueued) {
    if (slugFilter) {
      // The named path already captured the exact target sks from its spine
      // read. A second whole-board divergence probe would defeat its latency
      // contract; delete only those captured addresses.
      await sweepBoardCardJanitor(opts.node);
    } else {
      // Re-check partition/column agreement immediately before the delete sweep
      // runs, not only at plan time above. The plan-time guard is evaluated once
      // before this run's first write; if the node's read view degrades to a
      // whole-partition-vs-column disagreement while this run's own writes are
      // still landing, the deletes queued below are authorized by a plan this
      // run can no longer stand behind. Every upsert already issued stands —
      // upserts only ever add or refresh membership — so skipping the sweep here
      // costs nothing but a delayed reap of rows the next heal run will still
      // see and classify fresh.
      const recheck = await Promise.all(
        targetBoards.map((b) => readBoardCardsPartitionDivergence(opts.node, opts.cfg, b.slug, b.columns ?? [])),
      );
      const stillDiverged = recheck.filter(
        (d): d is BoardCardsReadDivergence => d !== null && boardCardsReadDiverged(d),
      );
      if (stillDiverged.length > 0) {
        deleteSweepSkipped = true;
        readDivergence.push(...stillDiverged);
      } else {
        await sweepBoardCardJanitor(opts.node);
      }
    }
  }

  // A delete is a repair only once the row is gone from the read `kanban list`
  // serves. The sweep's ack is not that proof: the ghost rows above acked and
  // stayed. Re-read each touched board (one partition read per board, not per
  // row), give settling deletes a short bounded wait, and stop counting any
  // orphan that is still listed as `healed`.
  if (opts.apply && orphanDeletes.length > 0) {
    if (deleteSweepSkipped) {
      healed -= orphanDeletes.length;
    } else {
      const sleep = opts.visibilitySleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
      let pending = orphanDeletes.slice();
      for (let attempt = 0; attempt < 3 && pending.length > 0; attempt += 1) {
        if (attempt > 0) await sleep(500);
        const listedByBoard = new Map<string, Set<string> | null>();
        for (const b of new Set(pending.map((o) => o.board))) {
          const part = await listBoardCardsPartition(opts.node, opts.cfg, b);
          listedByBoard.set(b, part ? new Set(part.map((c) => c.slug)) : null);
        }
        pending = pending.filter((o) => {
          const listed = listedByBoard.get(o.board);
          // An unreadable partition cannot confirm the delete.
          return listed === null || listed === undefined || listed.has(o.slug);
        });
      }
      unverified_deletes = pending.length;
      healed -= pending.length;
    }
  }

  const report: BoardCardsHealReport = {
    scanned_index_rows: rawRows.length,
    drifted,
    healed,
    would_heal,
    missing_card,
    milestone_rows_skipped,
    board_cards_bound: true,
    discovery_failed: discoveryFailed,
    incomplete_leads: incompleteLeads,
    read_divergence: readDivergence,
    dryRun: !opts.apply,
    blocked: false,
    // Reported on EVERY run, not just refusals. A safety limit that is only
    // visible in the report that announces its own failure gives an operator no
    // way to see it approaching — the run before the one that blocks looks
    // identical to a quiet one. These two numbers make the headroom readable.
    removal_ceiling: removalCeiling,
    removals_possible: removalsPossible,
    unverified_upserts,
    unverified_deletes,
    delete_sweep_skipped: deleteSweepSkipped,
    actions: opts.json ? actions : actions.filter((a) => a.action !== "noop-match"),
  };

  const head =
    `board-cards heal: scanned=${report.scanned_index_rows} drifted=${report.drifted} ` +
    `${renderSweepWrites({ applied: "healed", planned: "would_heal" }, {
      dryRun: report.dryRun,
      applied: report.healed,
      planned: report.would_heal,
    })} missing_card=${report.missing_card}` +
    `${report.milestone_rows_skipped ? ` milestone_rows_skipped=${report.milestone_rows_skipped}` : ""}` +
    `${report.dryRun ? " — DRY RUN, no writes" : ""}`;
  const lines = report.actions
    .filter((a) => a.action !== "noop-match")
    .map(
      (a) =>
        `  ${a.slug} list=${a.list_column} truth=${a.truth_column ?? "∅"} → ${a.action} (${a.reason})`,
    );
  // Loud, and above the per-row detail: a scan that could not read part of a
  // partition must not report its counts as if it had.
  const warn = incompleteLeads.length
    ? [
      `  ⚠ INCOMPLETE — the node refused ${incompleteLeads.length} completeness ` +
      `lead(s): ${incompleteLeads.join(", ")}`,
      `    Counts above are a LOWER BOUND; rows only reachable under those leads were not scanned.`,
    ]
    : [];
  // The other half, and it needs its own line rather than a shared one: this
  // failure removes CANDIDATES (cards with no row anywhere), while the leads
  // above remove ROWS from a partition heal did read. An operator seeing
  // `missing_card=0` has to be able to tell which of the two produced it.
  const discoveryWarn = discoveryFailed
    ? [
      `  ⚠ DISCOVERY INCOMPLETE — the Card scan that finds cards with NO BoardCards row failed: ${discoveryFailed}`,
      `    missing_card and upsert-truth above are a LOWER BOUND. A card whose membership row is`,
      `    absent is invisible to \`kanban list\`, and this run may never have been offered it as a`,
      `    candidate. Re-run when the node is not shedding reads before treating this as converged.`,
    ]
    : [];
  // Its own line, not folded into the head: a reader who sees these rows
  // vanish from `missing_card` between two versions of this command needs to
  // find out here that they were not deleted either.
  const milestoneNote = report.milestone_rows_skipped
    ? [
      `  MILESTONE ROWS — ${report.milestone_rows_skipped} row(s) in the BoardCards partition are`,
      `    milestone membership (state-keyed sk, Milestone record present), not card orphans.`,
      `    They are NOT deleted and NOT counted as removals. Repairing them belongs to`,
      `    \`kanban groom milestone-indexes-heal\`, which owns the board_milestones index.`,
    ]
    : [];
  // Reported whenever it happened, dry or apply is moot here — this only ever
  // fires under `--apply`. Left in place, not lost: the stale sibling row(s)
  // this would have removed are still on the board, so the card kept its
  // membership through them.
  const unverifiedWarn = report.unverified_upserts
    ? [
      `  ⚠ UNVERIFIED UPSERT — ${report.unverified_upserts} repair(s) wrote truth but could`,
      `    not confirm it visible before the matching delete would have run. The stale row(s)`,
      `    were left in place rather than removed. Re-run heal; a live card never lost membership.`,
    ]
    : [];
  const unverifiedDeleteWarn = report.unverified_deletes
    ? [
      `  ⚠ UNVERIFIED DELETE — ${report.unverified_deletes} orphan row(s) are still listed after`,
      `    the delete sweep. They are not counted as healed. The delete did not land on the`,
      `    row \`kanban list\` serves; inspect with --slug <s> --json before re-running.`,
    ]
    : [];
  const divergedSkipWarn = opts.apply && divergedBoards.size > 0
    ? [
      `  ⚠ PARTITION SKIPPED — the node served inconsistent views of ` +
      `${[...divergedBoards].join(", ")}; no writes on ${divergedBoards.size === 1 ? "that board" : "those boards"}.`,
      ...diverged.map(
        (d) =>
          `    ${d.board}: ${d.wholeOnly.length} row(s) only the whole-partition read saw, ` +
          `${d.columnOnly.length} only a column read saw`,
      ),
      `    Other boards were repaired. This is a node-side read degradation; do not restart on it.`,
    ]
    : [];
  const sweepSkippedWarn = report.delete_sweep_skipped
    ? [
      `  ⚠ DELETE SWEEP SKIPPED — a re-check just before the delete sweep found the node's`,
      `    partition/column views had diverged since this run's plan was made. Every upsert`,
      `    above still landed; no delete ran. Re-run heal once the reads agree again.`,
    ]
    : [];
  const text = [
    head,
    ...discoveryWarn,
    ...warn,
    ...milestoneNote,
    ...unverifiedWarn,
    ...unverifiedDeleteWarn,
    ...divergedSkipWarn,
    ...sweepSkippedWarn,
    ...lines,
  ].join("\n");
  return { text, report };
}

export async function boardCardsHealCmd(opts: BoardCardsHealOptions): Promise<string> {
  const { text, report } = await boardCardsHealResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
