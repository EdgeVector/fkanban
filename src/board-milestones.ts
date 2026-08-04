// BoardMilestones HashRange helpers — Dynamo-style membership: hash=board,
// range=state#position#slug. Thin projection for portfolio/list (includes body
// for list parity with fat Milestone show).
//
// List/portfolio: one partition query per board (filter HashKey=board).
// Never product full-scan the Milestone schema when this index is bound.

import type { Config } from "./config.ts";
import type { NodeClient, QueryFilter, QueryRow } from "./client.ts";
import { mapWithConcurrency, PARTITION_READ_CONCURRENCY } from "./concurrency.ts";
import { BOARD_MILESTONES_FIELDS, BOARD_MILESTONES_LAYOUT } from "./schemas.ts";
import type { Milestone } from "./record.ts";

export { BOARD_MILESTONES_LAYOUT };

/** Sort key: state#pos(8)#slug — ordered, state-prefix filterable. */
export function boardMilestoneSk(state: string, position: string | number, slug: string): string {
  const pos = String(position).padStart(8, "0");
  return `${state}#${pos}#${slug}`;
}

export function parseBoardMilestoneSk(
  sk: string,
): { state: string; position: string; slug: string } | null {
  const i = sk.indexOf("#");
  if (i < 0) return null;
  const j = sk.indexOf("#", i + 1);
  if (j < 0) return null;
  return {
    state: sk.slice(0, i),
    position: String(Number(sk.slice(i + 1, j))),
    slug: sk.slice(j + 1),
  };
}

export function boardMilestonesHash(cfg: Config): string | null {
  const h = cfg.schemaHashes?.["board_milestones"];
  return h && h.length > 0 ? h : null;
}

export function boardMilestoneFieldsFromMilestone(m: Milestone): Record<string, unknown> {
  const board = m.board || "default";
  const sk = boardMilestoneSk(m.state, m.position, m.slug);
  // Note: omit completed_at when writing — Mini expand may bind a composite
  // schema that lacks it; completion is still on fat Milestone HashKey.
  return {
    board,
    sk,
    slug: m.slug,
    title: m.title,
    body: m.body,
    state: m.state,
    position: String(m.position),
    north_star: m.north_star,
    driver: m.driver,
    deps: m.deps ?? [],
    proof_card: m.proof_card,
    proof_status: m.proof_status,
    block_reason: m.block_reason,
    created_at: m.created_at,
    updated_at: m.updated_at,
    layout: BOARD_MILESTONES_LAYOUT,
  };
}

export function milestoneFromBoardMilestoneFields(fields: Record<string, unknown>): Milestone {
  const str = (k: string) => (typeof fields[k] === "string" ? (fields[k] as string) : "");
  const arr = (k: string): string[] => {
    const v = fields[k];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
    return [];
  };
  return {
    slug: str("slug"),
    title: str("title"),
    body: str("body"),
    board: str("board") || "default",
    state: str("state") || "planned",
    position: str("position"),
    north_star: str("north_star"),
    driver: str("driver"),
    deps: arr("deps"),
    proof_card: str("proof_card"),
    proof_status: str("proof_status") || "pending",
    block_reason: str("block_reason"),
    created_at: str("created_at"),
    updated_at: str("updated_at"),
    completed_at: str("completed_at"),
  };
}

async function deleteBoardMilestoneSk(
  node: NodeClient,
  schemaHash: string,
  board: string,
  sk: string,
): Promise<void> {
  try {
    await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: sk });
  } catch {
    // best-effort
  }
}

async function retireSupersededBoardMilestoneRows(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
  previous?: Milestone | null,
): Promise<void> {
  const nextFields = boardMilestoneFieldsFromMilestone(milestone);
  const nextBoard = String(nextFields.board);
  const nextSk = String(nextFields.sk);
  const slug = String(nextFields.slug);

  if (previous) {
    const prevBoard = previous.board || "default";
    const prevSk = boardMilestoneSk(previous.state, previous.position, previous.slug);
    if (prevBoard !== nextBoard || prevSk !== nextSk) {
      await deleteBoardMilestoneSk(node, boardMilestonesHash(cfg)!, prevBoard, prevSk);
    }
    if (prevBoard !== nextBoard && previous.slug) {
      await purgeOtherBoardMilestoneRows(node, cfg, prevBoard, previous.slug, null);
    }
    if (prevSk !== nextSk || prevBoard !== nextBoard) {
      await purgeOtherBoardMilestoneRows(node, cfg, nextBoard, slug, nextSk);
    }
    return;
  }

  await purgeOtherBoardMilestoneRows(node, cfg, nextBoard, slug, nextSk);
}

/**
 * Delete-only cleanup for the protein-primary hot milestone path. The fat
 * Milestone write is the payload owner; Mini folds the current BoardMilestones
 * tip, while fkanban retires obsolete keyed rows it can address.
 */
export async function retireBoardMilestoneMembership(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
  previous?: Milestone | null,
): Promise<void> {
  if (!boardMilestonesHash(cfg)) return;
  await retireSupersededBoardMilestoneRows(node, cfg, milestone, previous ?? null);
}

/**
 * Ensure a BoardMilestones membership tip exists for this milestone.
 *
 * Protein-primary writes rely on Mini fold to create the keyed tip. List /
 * portfolio / gap-report are BoardMilestones-only: if fold never lands, the
 * milestone disappears from factory inventory while remaining point-readable.
 * When the partition is readable and the slug is absent, dual-write membership
 * so drivers can see it. If the partition read fails, best-effort upsert
 * (recoverable) rather than leave an invisible hole.
 */
export async function ensureBoardMilestoneMembership(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
  previous?: Milestone | null,
): Promise<"present" | "upserted" | "skipped"> {
  if (!boardMilestonesHash(cfg) || !milestone.slug) return "skipped";
  const board = milestone.board || "default";
  const part = await listBoardMilestonesPartition(node, cfg, board);
  if (part !== null && part.some((m) => m.slug === milestone.slug)) {
    return "present";
  }
  await upsertBoardMilestone(node, cfg, milestone, previous ?? null);
  return "upserted";
}

/**
 * Delete BoardMilestones rows for `slug` on `board` except optional keepSk.
 */
export async function purgeOtherBoardMilestoneRows(
  node: NodeClient,
  cfg: Config,
  board: string,
  slug: string,
  keepSk: string | null,
): Promise<number> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash || !slug) return 0;
  // Address rows by their range key, not through the display read — which can
  // deny a row whose `layout` copy did not come back, and which rebuilds the sk
  // from copied scalars. See {@link listBoardMilestonesPartitionSpine}.
  const part = await listBoardMilestonesPartitionSpine(node, cfg, board);
  if (!part) return 0;
  let n = 0;
  for (const row of part) {
    if (row.slug !== slug) continue;
    if (keepSk !== null && row.sk === keepSk) continue;
    await deleteBoardMilestoneSk(node, schemaHash, board, row.sk);
    n += 1;
  }
  return n;
}

export async function upsertBoardMilestone(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
  previous?: Milestone | null,
): Promise<void> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash) return;

  const nextFields = boardMilestoneFieldsFromMilestone(milestone);
  const nextBoard = String(nextFields.board);
  const nextSk = String(nextFields.sk);
  const slug = String(nextFields.slug);

  // Retire the rows this write supersedes — AFTER the destination row is
  // durable, never before. Same rule, and the same reasoning, as
  // `upsertBoardCard`; see `test/board-milestones-move-durability.test.ts`.
  //
  // A state change rewrites the sk (`state#position#slug`), so the destination
  // is a DIFFERENT row from the source and LastDB gives us no transaction
  // spanning the two. Something is observable in between and the only choice is
  // WHICH something. Deleting first makes it "the milestone has no
  // BoardMilestones row on any board", and that is worse here than it is for
  // cards: `listAllBoardMilestones` falls back to the fat Milestone scan only
  // when a partition query THREW. A partition that answers, minus one row, is
  // authoritative — so the milestone is simply absent from `milestone list`,
  // `milestone portfolio` and `groom`, and STAYS absent if the destination
  // write failed, until the next `groom milestone-indexes`. Live kanban
  // mutations average ~2.2s and have been measured at 41s, so that window is
  // seconds wide on the hot path of every state transition.
  //
  // Writing first makes the in-between state "the milestone has two rows" —
  // one this module already resolves on purpose: `listAllBoardMilestones`
  // dedupes by slug preferring the fresher `updated_at`, and `milestoneUpsertCmd`
  // stamps that field on every mutation, so the row just written wins by
  // construction. `purgeOtherBoardMilestoneRows` and `groom milestone-indexes`
  // reap the loser.
  //
  // Both failures are recoverable. Only one of them is invisible while it
  // waits, so prefer the visible one.
  const retireSupersededRows = async () => {
    if (previous) {
      const prevBoard = previous.board || "default";
      const prevSk = boardMilestoneSk(previous.state, previous.position, previous.slug);
      if (prevBoard !== nextBoard || prevSk !== nextSk) {
        await deleteBoardMilestoneSk(node, schemaHash, prevBoard, prevSk);
      }
      if (prevBoard !== nextBoard && previous.slug) {
        await purgeOtherBoardMilestoneRows(node, cfg, prevBoard, previous.slug, null);
      }
      if (prevSk !== nextSk || prevBoard !== nextBoard) {
        await purgeOtherBoardMilestoneRows(node, cfg, nextBoard, slug, nextSk);
      }
      return;
    }
    await purgeOtherBoardMilestoneRows(node, cfg, nextBoard, slug, nextSk);
  };

  // No `completed_at` fallback here. There used to be one — a retry that
  // stripped the field when the node rejected it — and it could not fire:
  // `boardMilestoneFieldsFromMilestone` deliberately never emits
  // `completed_at` (see its comment), so the `"completed_at" in nextFields`
  // guard was always false. It advertised a defence this path did not have.
  try {
    await node.updateRecord({ schemaHash, fields: nextFields, keyHash: nextBoard, rangeKey: nextSk });
  } catch {
    await node.createRecord({ schemaHash, fields: nextFields, keyHash: nextBoard, rangeKey: nextSk });
  }
  await retireSupersededRows();
}

export async function removeBoardMilestone(
  node: NodeClient,
  cfg: Config,
  milestone: Milestone,
): Promise<void> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash) return;
  const board = milestone.board || "default";
  const sk = boardMilestoneSk(milestone.state, milestone.position, milestone.slug);
  await deleteBoardMilestoneSk(node, schemaHash, board, sk);
  if (milestone.slug) {
    await purgeOtherBoardMilestoneRows(node, cfg, board, milestone.slug, null);
  }
}

/** One keyed BoardMilestones partition (all states on that board). */
export async function listBoardMilestonesPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
): Promise<Milestone[] | null> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash) return null;
  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [...BOARD_MILESTONES_FIELDS],
      filter: { HashKey: board },
    });
    const out: Milestone[] = [];
    for (const r of res.results) {
      const f = (r.fields ?? {}) as Record<string, unknown>;
      // Only rows dual-written by this client — but a marker that did not come
      // back is NOT a foreign marker. The node returns partial rows (measured
      // on the live primary 2026-08-01, `scripts/probe-wire-projection-semantics.ts`:
      // 33 of 33 rows here come back with no `completed_at` key at all), so
      // `f.layout ?? ""` reads absence as foreignness and denies a row the node
      // supplied. Only a marker that is PRESENT and DIFFERENT is evidence.
      const marker = f.layout;
      if (typeof marker === "string" && marker.length > 0 && marker !== BOARD_MILESTONES_LAYOUT) {
        continue;
      }
      const m = milestoneFromBoardMilestoneFields(f);
      // The range key is the row's address; the copies are copies.
      const parsed = parseBoardMilestoneSk(typeof r.key?.range === "string" ? r.key.range : "");
      if (parsed) {
        if (m.slug.length === 0) m.slug = parsed.slug;
        if (m.position.length === 0) m.position = parsed.position;
        if (!f.state) m.state = parsed.state;
      }
      if (m.slug.length === 0) continue;
      out.push(m);
    }
    return out;
  } catch {
    return null;
  }
}

/**
 * A BoardMilestones row reduced to what identifies and addresses it, with `sk`
 * taken from the row's REAL range key rather than the payload copy of it.
 */
export type BoardMilestoneRow = {
  board: string;
  sk: string;
  slug: string;
  state: string;
  position: string;
};

/**
 * Every row in a board's milestone partition, addressed by its range key.
 *
 * The counterpart to `listBoardCardsPartitionSpine` and
 * `listMilestoneCardsPartitionSpine`. It projects only `slug` — not the
 * partition key `board`, which the caller already knows because it is the
 * filter, and not the 15 payload fields the display read pays for and this
 * caller drops. A row whose address cannot be resolved is skipped rather than
 * addressed by a guess.
 */
export async function listBoardMilestonesPartitionSpine(
  node: NodeClient,
  cfg: Config,
  board: string,
): Promise<BoardMilestoneRow[] | null> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash) return null;
  let res;
  try {
    res = await node.queryAll({
      schemaHash,
      fields: ["slug"],
      filter: { HashKey: board },
    });
  } catch {
    return null;
  }
  const out: BoardMilestoneRow[] = [];
  for (const r of res.results) {
    const row = boardMilestoneRowFromQueryRow(r, board);
    if (row !== null) out.push(row);
  }
  return out;
}

/**
 * One BoardMilestones query row reduced to its address, or `null` if the row
 * cannot be addressed at all.
 *
 * Shared by {@link listBoardMilestonesPartitionSpine} and
 * {@link sweepBoardMilestonesPartition} so the two cannot disagree about what a
 * row IS — they must differ only in which field leads, since that difference is
 * exactly what the parity check measures.
 *
 * A row with no resolvable range key is skipped rather than addressed by a
 * guess: the one thing `purgeOtherBoardMilestoneRows` does with a spine row is
 * delete it, and a guessed key either deletes nothing (and counts it) or
 * deletes the wrong thing. See `milestoneCardRowFromQueryRow` for the sibling
 * index, where the empty-range row has a known identity.
 */
function boardMilestoneRowFromQueryRow(
  r: QueryRow,
  board: string,
): BoardMilestoneRow | null {
  const f = (r.fields ?? {}) as Record<string, unknown>;
  const sk = typeof r.key?.range === "string" && r.key.range.length > 0
    ? r.key.range
    : typeof f.sk === "string"
      ? f.sk
      : "";
  if (sk.length === 0) return null;
  const parsed = parseBoardMilestoneSk(sk);
  const slug = parsed?.slug ?? (typeof f.slug === "string" ? f.slug : "");
  if (slug.length === 0) return null;
  return {
    board,
    sk,
    slug,
    state: parsed?.state ?? "",
    position: parsed?.position ?? "",
  };
}

/** The result of {@link sweepBoardMilestonesPartition}: rows reached, and gaps. */
export type BoardMilestonesPartitionSweep = {
  /** Every row reachable under some leading field, deduped by range key. */
  rows: BoardMilestoneRow[];
  /**
   * Leads the node refused. Non-empty means `rows` is a LOWER BOUND, and a
   * caller asserting completeness must fail rather than report a clean result.
   */
  failedLeads: Array<{ field: string; error: string }>;
};

/**
 * Every row in a board's milestone partition, reached under EVERY leading
 * field — the complete baseline, as `sweepBoardCardsPartition` is for cards.
 *
 * The `slug`-led spine it replaces as a parity baseline is blind to a row
 * carrying neither `slug` nor `board`: such a row is missing from both sides of
 * the parity subtraction, nets to zero, and reads as clean. That blind spot is
 * the one this check exists to find.
 *
 * Measured on the live primary 2026-08-04, both boards, 40 rows
 * (`scripts/probe-milestone-parity-baseline-cost.ts`): 201ms for the one-lead
 * spine against 584ms for the 17-lead sweep — 2.9x, +0.4s. Doctor / heal price,
 * not a list price.
 */
export async function sweepBoardMilestonesPartition(
  node: NodeClient,
  cfg: Config,
  board: string,
): Promise<BoardMilestonesPartitionSweep | null> {
  const schemaHash = boardMilestonesHash(cfg);
  if (!schemaHash) return null;
  const filter = { HashKey: board } as QueryFilter;

  const perLead = await mapWithConcurrency(BOARD_MILESTONES_FIELDS, async (lead) => {
    try {
      const res = await node.queryAll({ schemaHash, fields: [lead], filter });
      const rows: BoardMilestoneRow[] = [];
      for (const r of res.results) {
        const row = boardMilestoneRowFromQueryRow(r, board);
        if (row !== null) rows.push(row);
      }
      return { rows, failure: null };
    } catch (err) {
      // Reported, never swallowed — a swallowed lead hands back a short
      // enumeration labelled complete, which is the failure this removes.
      return {
        rows: [] as BoardMilestoneRow[],
        failure: { field: lead, error: err instanceof Error ? err.message : String(err) },
      };
    }
  }, PARTITION_READ_CONCURRENCY);

  const bySk = new Map<string, BoardMilestoneRow>();
  const failedLeads: BoardMilestonesPartitionSweep["failedLeads"] = [];
  for (const lead of perLead) {
    if (lead.failure) failedLeads.push(lead.failure);
    for (const r of lead.rows) if (!bySk.has(r.sk)) bySk.set(r.sk, r);
  }
  return { rows: [...bySk.values()], failedLeads };
}

/**
 * List milestones via BoardMilestones partitions (one query per board).
 * Returns null if the index is unbound or ANY partition query fails.
 *
 * All-or-nothing, matching {@link listAllBoardCards} — and for the same
 * reason. The union used to skip a failed partition and return whatever the
 * others produced, going null only if EVERY board failed. That makes a
 * successful read of one board vouch for a board nobody managed to read, and
 * the live topology turns it into the worst possible answer: all 32 milestones
 * sit on `default`, `agent-dogfood-scratch` has none. The empty scratch
 * partition is the cheap one and effectively always succeeds; `default` is the
 * one that sheds under backpressure. So a single `service_timeout` on
 * `default` returned `[]` — non-null, therefore authoritative — and
 * `listMilestones` reported ZERO milestones instead of falling back to the
 * Milestone full-scan that exists for exactly this case.
 *
 * A partition that could not be read is not an empty partition. Only a read
 * that SUCCEEDED may establish that a board has no milestones.
 */
export async function listAllBoardMilestones(
  node: NodeClient,
  cfg: Config,
  boards: Array<{ slug: string }>,
): Promise<Milestone[] | null> {
  if (!boardMilestonesHash(cfg)) return null;
  if (boards.length === 0) return [];
  // Read the partitions TOGETHER, matching `listAllBoardCards`. These are
  // independent partition reads and a read is almost entirely per-request
  // latency, so the unit of cost is the serial wave (`concurrency.ts`:
  // ceil(N/width) x ~190ms). Read one board after another this cost one wave
  // per board on `list`, `milestone portfolio` and `groom`, for reads that
  // never needed to wait on each other.
  //
  // Ordering is preserved — `mapWithConcurrency` lands each result at its input
  // index — so the dedupe below still walks boards in the caller's order and
  // resolves a cross-board duplicate exactly as it did when the reads were
  // serial.
  const parts = await mapWithConcurrency(
    boards,
    (b) => listBoardMilestonesPartition(node, cfg, b.slug),
    PARTITION_READ_CONCURRENCY,
  );
  const out: Milestone[] = [];
  for (const part of parts) {
    // The unbound-index case is already handled above, so null here means the
    // query threw. Fail closed and let the caller fall back.
    //
    // Every partition is now READ before this check, where the serial loop
    // stopped at the first failure. That is the same trade `listAllBoardCards`
    // already makes: these are reads, so the extra work is wasted effort on a
    // failing call rather than a side effect, and the verdict is unchanged.
    if (part === null) return null;
    out.push(...part);
  }
  // Dedupe by slug (prefer fresher updated_at)
  const bySlug = new Map<string, Milestone>();
  for (const m of out) {
    const prev = bySlug.get(m.slug);
    if (!prev || (m.updated_at || "") > (prev.updated_at || "")) bySlug.set(m.slug, m);
  }
  return [...bySlug.values()];
}
