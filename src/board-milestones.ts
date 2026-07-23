// BoardMilestones HashRange helpers — Dynamo-style membership: hash=board,
// range=state#position#slug. Thin projection for portfolio/list (includes body
// for list parity with fat Milestone show).
//
// List/portfolio: one partition query per board (filter HashKey=board).
// Never product full-scan the Milestone schema when this index is bound.

import type { Config } from "./config.ts";
import type { NodeClient } from "./client.ts";
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
  const part = await listBoardMilestonesPartition(node, cfg, board);
  if (!part) return 0;
  let n = 0;
  for (const row of part) {
    if (row.slug !== slug) continue;
    const sk = boardMilestoneSk(row.state, row.position, row.slug);
    if (keepSk !== null && sk === keepSk) continue;
    await deleteBoardMilestoneSk(node, schemaHash, board, sk);
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
  } else {
    await purgeOtherBoardMilestoneRows(node, cfg, nextBoard, slug, nextSk);
  }

  const write = async (fields: Record<string, unknown>) => {
    try {
      await node.updateRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    } catch (updateErr) {
      await node.createRecord({ schemaHash, fields, keyHash: nextBoard, rangeKey: nextSk });
    }
  };
  try {
    await write(nextFields);
  } catch (err) {
    // Drop completed_at if a composite expand schema rejects it (or other optional).
    const msg = err instanceof Error ? err.message : String(err);
    if (msg.includes("completed_at") && "completed_at" in nextFields) {
      const { completed_at: _drop, ...rest } = nextFields as Record<string, unknown> & { completed_at?: unknown };
      await write(rest);
      return;
    }
    throw err;
  }
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
    return res.results
      .map((r) => {
        const f = (r.fields ?? {}) as Record<string, unknown>;
        // Only rows dual-written by this client (layout marker).
        if (String(f.layout ?? "") !== BOARD_MILESTONES_LAYOUT) {
          return null;
        }
        return milestoneFromBoardMilestoneFields(f);
      })
      .filter((m): m is Milestone => m !== null && m.slug.length > 0);
  } catch {
    return null;
  }
}

/**
 * List milestones via BoardMilestones partitions (one query per board).
 * Returns null if the index is unbound or every partition query fails.
 */
export async function listAllBoardMilestones(
  node: NodeClient,
  cfg: Config,
  boards: Array<{ slug: string }>,
): Promise<Milestone[] | null> {
  if (!boardMilestonesHash(cfg)) return null;
  if (boards.length === 0) return [];
  const out: Milestone[] = [];
  let anyOk = false;
  for (const b of boards) {
    const part = await listBoardMilestonesPartition(node, cfg, b.slug);
    if (part === null) continue;
    anyOk = true;
    out.push(...part);
  }
  if (!anyOk) return null;
  // Dedupe by slug (prefer fresher updated_at)
  const bySlug = new Map<string, Milestone>();
  for (const m of out) {
    const prev = bySlug.get(m.slug);
    if (!prev || (m.updated_at || "") > (prev.updated_at || "")) bySlug.set(m.slug, m);
  }
  return [...bySlug.values()];
}
