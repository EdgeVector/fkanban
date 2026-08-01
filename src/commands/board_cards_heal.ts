// Heal BoardCards membership drift: list/column previews must agree with
// authoritative card column. Card point-reads are the source of truth;
// CardListIndex only discovers slugs that have no BoardCards row yet.
//
// This is the ONLY path that may delete BoardCards rows for "orphans."
// List/reconcile is read-only on Card miss (incident 2026-07-23/24).

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import { mapWithConcurrency } from "../concurrency.ts";
import {
  boardCardFieldsFromCard,
  boardCardSk,
  classifyBoardCardDuplicateRows,
  deleteBoardCardRowsBySk,
  listBoardCardsPartition,
  listBoardCardsPartitionSpine,
  parseBoardCardSk,
  removeBoardCard,
  upsertBoardCard,
} from "../board-cards.ts";
import { readCardListIndex, cardListIndexIsSuperseded, type CardSummary } from "../card-list-index.ts";
import {
  cardExists,
  findCardSummaryForReconcile,
  listBoards,
  scanCardSummariesForReconcile,
  type Card,
  emptyStructuredFields,
} from "../record.ts";

/**
 * Resolve Card truth for every candidate slug, bounded-parallel.
 *
 * Truth is still one Card point-read per slug — the bulk scan above only
 * *proposes* candidates, and a scan miss must never authorize a delete
 * (incident 2026-07-23/24). What changes is cost, not authority: reads are
 * body-free and overlap instead of running strictly one-at-a-time.
 *
 * Reading every candidate up front also shortens the TOCTOU window under
 * `--apply`: previously a card examined last was point-read minutes after the
 * first one, so its "truth" was already several minutes stale by the time the
 * write landed.
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
};

export type BoardCardsHealAction = {
  slug: string;
  board: string;
  list_column: string;
  list_position: string;
  truth_column: string | null;
  truth_position: string | null;
  action:
    | "delete-orphan"
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
  healed: number;
  missing_card: number;
  dryRun: boolean;
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

export async function boardCardsHealResult(
  opts: BoardCardsHealOptions,
): Promise<{ text: string; report: BoardCardsHealReport }> {
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

  // Bulk discovery of slugs that may have no BoardCards row. Candidates only —
  // every one is verified by a point-read of Card truth below.
  //
  // Card scan first where BoardCards is bound: the `all_cards` rollup is a
  // lost-update-prone copy (whole-document read-modify-write, no CAS), so a card
  // it dropped was invisible to heal forever, and its write is now retired. Card
  // is the source of truth, so scanning it finds rows missing from BOTH indexes.
  // A scan is correct in a reconciler; it is only banned on hot read paths.
  //
  // `all_cards` is still unioned in while it holds entries, so a node that has
  // not cut over — and a cutover node whose index is not yet cleared — keeps the
  // old discovery too. Its tombstones (entries whose Card is gone) cost one
  // point-read each and then fall out as "no rows, no card".
  // SLUGS ONLY. Discovery names candidates; it never says anything about where
  // they live. This used to keep the whole scan row and read `.board` off it to
  // pick a partition — but the scan does not establish `board` (blank on 99 of
  // 410 winning rows on the live primary, 2026-07-31), and the 47 slugs the
  // scan returns twice resolve last-write-wins, so which of the two rows won
  // was arbitrary. Truth decides the board, below, after a keyed read.
  const candidateSlugs = new Set<string>();
  if (cardListIndexIsSuperseded(opts.cfg)) {
    try {
      for (const c of await scanCardSummariesForReconcile(opts.node, opts.cfg)) {
        if (c.slug) candidateSlugs.add(c.slug);
      }
    } catch {
      // Scan unavailable (older node / scan refused): fall back to the rollup.
    }
  }
  const indexed = (await readCardListIndex(opts.node, opts.cfg)) ?? [];
  for (const c of indexed) {
    if (c.slug) candidateSlugs.add(c.slug);
  }

  // Raw BoardCards partitions (may include multi-row orphans per slug).
  // `full` keeps the parsed row so the thin-field comparison below can judge
  // the projection's copied fields, not just its membership sk.
  const rawRows: Array<{ board: string; column: string; position: string; slug: string; full: Card }> = [];
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
    const part = await listBoardCardsPartition(opts.node, opts.cfg, b.slug);
    if (!part) continue;
    enumeratedBoards.add(b.slug);
    const seenSlugs = new Set<string>();
    for (const c of part) {
      if (slugFilter && !slugFilter.has(c.slug)) continue;
      seenSlugs.add(c.slug);
      rawRows.push({
        board: c.board || b.slug,
        column: c.column,
        position: String(c.position),
        slug: c.slug,
        full: c,
      });
    }

    // SPARSE ROWS. The wide read above projects all 24 BoardCards fields, and
    // LastDB drops any row missing even one of them — silently, with no error
    // (see BOARD_CARDS_SPINE_FIELDS). So a row that predates a field the
    // catalog later added is invisible to the wide read, and heal — the ONLY
    // path allowed to delete orphans — could never see the orphans it exists
    // to reap. Measured on the live board 2026-07-30: 58 orphan rows present,
    // `missing_card: 0` reported.
    //
    // The spine read is the NARROWEST available, which is not the same as
    // drop-free — it said it was until 2026-08-01, and while it did it was
    // reproducing the very failure this block was written to fix. It projected
    // `board` and `sk`, which are payload COPIES of the key, so a row left by a
    // partial write was keyed into the partition with no copy of its own
    // address and dropped out of the "sees everything" read too: 338 of 357
    // rows on the live `default` partition, 18 of the missing 19 being exactly
    // the Card-less orphans this path exists to reap.
    //
    // Each sparse row falls through the SAME decision below as any other: no
    // Card truth → delete-orphan; Card truth present → thin-field drift →
    // upsert, which rewrites the row with every field and backfills what it was
    // missing.
    const spine = await listBoardCardsPartitionSpine(opts.node, opts.cfg, b.slug);
    if (!spine) continue;
    for (const s of spine) {
      if (slugFilter && !slugFilter.has(s.slug)) continue;
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
  let missing_card = 0;
  let drifted = 0;

  // One point-read per distinct slug, not per (board, slug) key: the Card is
  // keyed by slug alone, so the same card claimed by two boards resolved the
  // identical record twice.
  const truthBySlug = await resolveTruthBySlug(
    opts,
    [...new Set([...byKey.keys()].map((key) => key.split("\0")[1] as string))],
  );

  for (const [key, rows] of byKey) {
    const [boardFromKey, slug] = key.split("\0") as [string, string];
    const board = boardFromKey || "default";

    const point = truthBySlug.get(slug) ?? null;
    if (!point) {
      if (rows.length === 0) continue;

      // CONFIRM the absence before reaping. The point-read above projects ~20
      // card fields, and LastDB drops a row from a result set when any
      // projected field has no atom on it — so "no rows" means EITHER the card
      // is gone OR it is alive and merely sparse. Those two are
      // indistinguishable from a wide read, and this branch deletes board
      // membership: guessing wrong takes a live card off the board.
      //
      // `cardExists` projects the hash key alone, so it cannot false-negative.
      // If it says the card is there, the row is not an orphan — it is a live
      // card whose Card record is missing a field, which the upsert path
      // repairs rather than deletes.
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
              "projection — sparse Card record, NOT an orphan; refusing to delete membership",
          });
        }
        continue;
      }

      missing_card += 1;
      drifted += 1;
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
          await removeBoardCard(opts.node, opts.cfg, thinCard({
            slug,
            title: "",
            body: "",
            board,
            column: row.column,
            position: row.position,
            assignee: "",
            tags: [],
            deps: [],
            surfaces: [],
            created_at: "",
            updated_at: "",
            db: "",
            repo: "",
            base: "",
            kind: "",
            block_status: "",
            block_reason: "",
            north_star: "",
            pr_url: "",
            branch: "",
          }), { skipOrphanPurge: enumeratedBoards.has(board) });
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
        if (opts.apply) {
          await upsertBoardCard(opts.node, opts.cfg, truth, null, {
            skipOrphanPurge: enumeratedBoards.has(truthBoard),
            wideWrite: true,
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
      if (opts.apply) {
        // rows.length === 0 on a partition heal listed in full: there is
        // provably nothing to purge, so skip the rescan. This is the bulk of a
        // real heal (241 of 241 repairs on the primary, 2026-07-28), and the
        // rescan it replaces is a whole-partition read per card.
        await upsertBoardCard(opts.node, opts.cfg, truth, null, {
          skipOrphanPurge: enumeratedBoards.has(truthBoard),
          wideWrite: true,
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

    if (opts.apply) {
      // Purge all sks for slug on any board seen, then write truth. `rows` is
      // already every row for this slug on the partitions heal enumerated, so
      // the targeted deletes below are exhaustive and neither the deletes nor
      // the upsert need to re-list the partition to hunt for more.
      for (const row of rows) {
        await removeBoardCard(
          opts.node,
          opts.cfg,
          thinCard({ ...truth, board: row.board, column: row.column, position: row.position }),
          { skipOrphanPurge: enumeratedBoards.has(row.board) },
        );
      }
      await upsertBoardCard(opts.node, opts.cfg, truth, null, {
        skipOrphanPurge: enumeratedBoards.has(truthBoard),
        wideWrite: true,
      });
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
    if (opts.apply) {
      // By address, not by purge: heal already holds the partition, and
      // `purgeOtherBoardCardRows` would re-list it once per duplicate slug.
      await deleteBoardCardRowsBySk(opts.node, opts.cfg, board, dup.sparseSks);
      healed += 1;
    }
  }

  const report: BoardCardsHealReport = {
    scanned_index_rows: rawRows.length,
    drifted,
    healed: opts.apply ? healed : drifted,
    missing_card,
    dryRun: !opts.apply,
    actions: opts.json ? actions : actions.filter((a) => a.action !== "noop-match"),
  };

  const head =
    `board-cards heal: scanned=${report.scanned_index_rows} drifted=${report.drifted} ` +
    `healed=${report.healed} missing_card=${report.missing_card}` +
    `${report.dryRun ? " — DRY RUN, no writes" : ""}`;
  const lines = report.actions
    .filter((a) => a.action !== "noop-match")
    .map(
      (a) =>
        `  ${a.slug} list=${a.list_column} truth=${a.truth_column ?? "∅"} → ${a.action} (${a.reason})`,
    );
  const text = [head, ...lines].join("\n");
  return { text, report };
}

export async function boardCardsHealCmd(opts: BoardCardsHealOptions): Promise<string> {
  const { text, report } = await boardCardsHealResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
