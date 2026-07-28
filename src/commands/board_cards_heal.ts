// Heal BoardCards membership drift: list/column previews must agree with
// authoritative card column. Card point-reads are the source of truth;
// CardListIndex only discovers slugs that have no BoardCards row yet.
//
// This is the ONLY path that may delete BoardCards rows for "orphans."
// List/reconcile is read-only on Card miss (incident 2026-07-23/24).

import type { NodeClient } from "../client.ts";
import type { Config } from "../config.ts";
import {
  boardCardSk,
  listBoardCardsPartition,
  removeBoardCard,
  upsertBoardCard,
} from "../board-cards.ts";
import { readCardListIndex, cardListIndexIsSuperseded, type CardSummary } from "../card-list-index.ts";
import {
  findCardSummaryForReconcile,
  listBoards,
  scanCardSummariesForReconcile,
  type Card,
  emptyStructuredFields,
} from "../record.ts";

/**
 * Truth point-reads in flight at once.
 *
 * Deliberately modest: Mini sheds with "too many concurrent reads" under load,
 * and heal is a maintenance path that must never starve the interactive board.
 * Six is enough to hide socket latency on a few-hundred-card board without
 * looking like a scraper.
 */
const TRUTH_READ_CONCURRENCY = 6;

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
 */
async function resolveTruthBySlug(
  opts: BoardCardsHealOptions,
  slugs: string[],
): Promise<Map<string, Card | null>> {
  const truth = new Map<string, Card | null>();
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      const slug = slugs[i];
      if (slug === undefined) return;
      truth.set(slug, await findCardSummaryForReconcile(opts.node, opts.cfg, slug));
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(TRUTH_READ_CONCURRENCY, slugs.length) }, worker),
  );
  return truth;
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
  action: "delete-orphan" | "upsert-truth" | "delete-stale-and-upsert" | "noop-match";
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
    pr_url: summary.pr_url || "",
    branch: summary.branch || "",
  };
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
  const indexedBySlug = new Map<string, CardSummary>();
  if (cardListIndexIsSuperseded(opts.cfg)) {
    try {
      for (const c of await scanCardSummariesForReconcile(opts.node, opts.cfg)) {
        if (c.slug) indexedBySlug.set(c.slug, c as CardSummary);
      }
    } catch {
      // Scan unavailable (older node / scan refused): fall back to the rollup.
    }
  }
  const indexed = (await readCardListIndex(opts.node, opts.cfg)) ?? [];
  for (const c of indexed) {
    if (c.slug && !indexedBySlug.has(c.slug)) indexedBySlug.set(c.slug, c);
  }

  // Raw BoardCards partitions (may include multi-row orphans per slug).
  const rawRows: Array<{ board: string; column: string; position: string; slug: string }> = [];
  // Partitions we actually read end-to-end. Only for these can heal claim to
  // know every row for a slug and skip the per-write orphan rescan; a partition
  // that failed to list (or a board with no Board record) keeps the defensive
  // purge, because there heal is as blind as any single-card writer.
  const enumeratedBoards = new Set<string>();
  for (const b of targetBoards) {
    const part = await listBoardCardsPartition(opts.node, opts.cfg, b.slug);
    if (!part) continue;
    enumeratedBoards.add(b.slug);
    for (const c of part) {
      if (slugFilter && !slugFilter.has(c.slug)) continue;
      rawRows.push({
        board: c.board || b.slug,
        column: c.column,
        position: String(c.position),
        slug: c.slug,
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
  for (const [slug, t] of indexedBySlug) {
    if (slugFilter && !slugFilter.has(slug)) continue;
    const board = t.board || "default";
    if (boardFilter && board !== boardFilter) continue;
    const k = `${board}\0${slug}`;
    if (!byKey.has(k)) {
      byKey.set(k, []);
    }
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
          }));
          healed += 1;
        }
      }
      continue;
    }

    const truth = thinCard({ ...point, body: "" });
    const truthBoard = truth.board || "default";
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
      });
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
