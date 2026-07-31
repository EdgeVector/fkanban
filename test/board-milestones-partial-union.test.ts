/**
 * A partition that could not be read is not an empty partition.
 *
 * `listAllBoardMilestones` used to skip a failed partition and return whatever
 * the surviving boards produced, going null only if EVERY board failed. That
 * lets a board nobody could read be vouched for by a board that happened to
 * succeed — and the live topology makes it maximally bad: every milestone sits
 * on `default`, while `agent-dogfood-scratch` has none. The empty scratch
 * partition is cheap and effectively always succeeds; `default` is the one that
 * sheds under load. So one `service_timeout` on `default` produced a non-null
 * `[]`, which `listMilestones` took as authoritative and returned as ZERO
 * milestones — suppressing the Milestone full-scan fallback that exists for
 * precisely this case.
 *
 * These tests model a TRANSIENT shed (one partition throws, the other is
 * healthy), not a node that is down. A fake that throws on every read cannot
 * tell the fixed code from the broken code: both produce nothing.
 */
import { describe, expect, test } from "bun:test";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import { listAllBoardMilestones, upsertBoardMilestone } from "../src/board-milestones.ts";
import { listMilestones, type Board, type Milestone } from "../src/record.ts";
import { DEFAULT_COLUMNS, fieldsFor } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: "mscards-hash",
  },
};

/** The two live boards, in the order `listBoards` returns them. */
function board(slug: string): Board {
  return {
    slug,
    title: slug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
  };
}
const BOARDS: Board[] = [board("agent-dogfood-scratch"), board("default")];

function milestone(slug: string, boardSlug = "default"): Milestone {
  return {
    slug,
    board: boardSlug,
    title: `Milestone ${slug}`,
    body: "",
    state: "active",
    position: "1",
    north_star: "",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "2026-07-31T00:00:00.000Z",
    updated_at: "2026-07-31T00:00:00.000Z",
    completed_at: "",
  } as Milestone;
}

/**
 * Seed BoardMilestones (the index) AND fat Milestone rows (what the fallback
 * full-scan reads), so a test can tell "fell back and recovered" apart from
 * "returned nothing".
 *
 * The index row is written by the real `upsertBoardMilestone` and then given a
 * `completed_at` atom, because that is the shape of the rows actually on the
 * primary: measured 2026-07-31, all 32 live `default` rows survive a full
 * 17-field `BOARD_MILESTONES_FIELDS` read. The writer omits `completed_at` on
 * purpose (see boardMilestoneFieldsFromMilestone), so without this the faithful
 * fake's drop rule would hide every row and the healthy-path assertions below
 * would pass for the wrong reason.
 */
async function seededNode(slugs: string[]) {
  const node = fakeNode();
  for (const slug of slugs) {
    const m = milestone(slug);
    await upsertBoardMilestone(node, cfg, m, null);
    for (const row of node.rowsOf(cfg.schemaHashes.board_milestones!)) {
      if (row.fields.slug === slug && !("completed_at" in row.fields)) row.fields.completed_at = "";
    }
    const fat: Record<string, unknown> = {};
    for (const name of fieldsFor("milestone")) fat[name] = "";
    Object.assign(fat, {
      slug: m.slug,
      board: m.board,
      title: m.title,
      state: m.state,
      position: String(m.position),
      driver: m.driver,
      deps: [],
      created_at: m.created_at,
      updated_at: m.updated_at,
    });
    node.seed({ schemaHash: cfg.schemaHashes.milestone!, keyHash: slug, fields: fat });
  }
  return node;
}

/**
 * Make exactly one BoardMilestones partition throw, once — the shape of
 * `service_timeout` / "too many concurrent reads" on a busy node. Every other
 * read, including the fallback full-scan, stays healthy.
 */
function shedPartitionOnce(node: ReturnType<typeof fakeNode>, board: string) {
  const base = node.queryAll.bind(node);
  let shed = false;
  node.queryAll = async (req) => {
    const filter = req.filter as QueryFilter & { HashKey?: string };
    if (!shed && req.schemaHash === cfg.schemaHashes.board_milestones && filter?.HashKey === board) {
      shed = true;
      throw new Error("service_timeout: too many concurrent reads");
    }
    return base(req);
  };
}

describe("BoardMilestones union: a failed partition is not an empty one", () => {
  test("one board sheds -> null, so the caller can fall back (was: partial/empty)", async () => {
    const node = await seededNode(["ms-alpha", "ms-beta", "ms-gamma"]);
    shedPartitionOnce(node, "default");

    const got = await listAllBoardMilestones(node, cfg, BOARDS);

    // The empty `agent-dogfood-scratch` partition succeeds and used to make
    // this a non-null `[]` — "there are no milestones", authoritatively.
    expect(got).toBeNull();
  });

  test("listMilestones refuses to answer a shed from the product scan", async () => {
    const node = await seededNode(["ms-alpha", "ms-beta", "ms-gamma"]);
    shedPartitionOnce(node, "default");

    // The index is BOUND, so null from the union means a partition threw. The
    // Milestone product scan is not a safe substitute on real data — measured
    // on the primary it misses 24 live milestones and surfaces 54 unreachable
    // slug-only rows — so this must surface the failure, not a plausible wrong
    // list. A caller can retry a throw; it cannot detect a wrong list.
    await expect(listMilestones(node, cfg, { boards: BOARDS })).rejects.toThrow(
      /BoardMilestones partition read failed/,
    );
  });

  test("an UNBOUND index still falls back to the product scan — that is what it is for", async () => {
    const node = await seededNode(["ms-alpha", "ms-beta", "ms-gamma"]);
    const unbound: Config = {
      ...cfg,
      schemaHashes: { ...cfg.schemaHashes, board_milestones: "" },
    };

    // Fresh node / pre-backfill: there is no index to shed, and the scan is the
    // only source there is. The refusal above must not swallow this case.
    const got = await listMilestones(node, unbound, { boards: BOARDS });

    expect(got.map((m) => m.slug).sort()).toEqual(["ms-alpha", "ms-beta", "ms-gamma"]);
  });

  test("a genuinely empty board still answers [] — the index is not abandoned", async () => {
    const node = await seededNode([]);

    const got = await listAllBoardMilestones(node, cfg, BOARDS);

    // No throw anywhere: every partition was read and every one was empty.
    // That answer is authoritative and must NOT provoke a product full scan.
    expect(got).toEqual([]);
  });

  test("all partitions healthy -> milestones come from the index, no full scan", async () => {
    const node = await seededNode(["ms-alpha", "ms-beta"]);
    node.reads.length = 0;

    const got = await listMilestones(node, cfg, { boards: BOARDS });

    expect(got.map((m) => m.slug).sort()).toEqual(["ms-alpha", "ms-beta"]);
    const scanned = node.reads.some(
      (r) => r.schemaHash === cfg.schemaHashes.milestone && !r.filter,
    );
    expect(scanned).toBe(false);
  });
});
