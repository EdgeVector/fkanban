// Heal must be able to see a row whose only atom is one no read leads with.
//
// Every BoardCards enumeration in this codebase has been a projection, and a
// projection is a FILTER: measured on the live primary 2026-08-01
// (`scripts/probe-projection-order-dependence.ts`, `-first-field-witness.ts`,
// `-width-scan.ts`, `-pair-matrix.ts`), a query returns a row only if the field
// LEADING the projection has an atom on it. `[title,board]` returns the witness
// row and `[board,title]` does not — same field set, two orders, two answers,
// which rules out intersection and union alike.
//
// So each successive "narrowest available" read was still gated on its own
// leading field, and each still had a blind spot:
//
//   - the five-field spine led with `board`  → lost 19 of 357 rows (2026-08-01)
//   - `BOARD_CARDS_ADDRESS_FIELDS` (`["slug"]`) → cannot see a row with no
//     `slug` atom, and one exists on the live `default` partition today:
//     `todo#00007777#debug-protein`, a single `title` atom, no Card record —
//     precisely the orphan shape `board-cards heal` exists to reap.
//
// The row is not exotic. `sk` decodes to column/position/slug, so heal knows
// exactly what to do with it the moment it can see it; it simply never came
// back from any read. Only the union over leading fields reaches it.
//
// Both tests below fail against the spine-based heal: the orphan is invisible,
// so `missing_card` is 0 and the row survives the reap.

import { describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, nowIso, type Card } from "../src/record.ts";
import {
  boardCardFieldsFromCard,
  boardCardSk,
  sweepBoardCardsPartition,
  listBoardCardsPartitionSpine,
} from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BOARD = "default";
/** The live witness, reproduced: one atom, and it is not the one reads lead with. */
const GHOST_SK = "todo#00007777#debug-protein";

function healthyCard(slug: string): Card {
  const now = nowIso();
  return {
    slug,
    title: slug,
    body: "",
    board: BOARD,
    column: "todo",
    position: "p1",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
    priority: "",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "",
    branch: "",
    created_by: "test",
  } as Card;
}

/**
 * One ordinary card (with its Card record, so heal leaves it alone) plus the
 * sparse ghost: keyed into the partition, carrying `title` and nothing else.
 */
function boardWithGhost(): FakeNode {
  const node = fakeNode();
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    fields: boardToFields({
      slug: BOARD,
      title: BOARD,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });

  const live = healthyCard("live-card");
  node.seed({ schemaHash: "cardhash", keyHash: live.slug, fields: { ...live } });
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: BOARD,
    rangeKey: boardCardSk(live.column, live.position, live.slug),
    fields: boardCardFieldsFromCard(live),
  });

  // The ghost. No Card record — so once heal can SEE it, delete-orphan is the
  // branch it takes, exactly as for any other Card-less row.
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: BOARD,
    rangeKey: GHOST_SK,
    fields: { title: "dbg title" },
  });
  return node;
}

describe("BoardCards rows that no single projection can lead to", () => {
  // NON-VACUITY. If the spine could already see the ghost there is nothing to
  // fix, and the reap test below would pass for the wrong reason. Pin the gap.
  test("the spine read cannot see the ghost — it does not carry `slug`", async () => {
    const node = boardWithGhost();
    const spine = await listBoardCardsPartitionSpine(node, cfg, BOARD);

    expect(spine?.map((r) => r.sk)).not.toContain(GHOST_SK);
    expect(spine).toHaveLength(1);
  });

  test("the complete sweep reaches it, and reads its address off the range key", async () => {
    const node = boardWithGhost();
    const sweep = await sweepBoardCardsPartition(node, cfg, BOARD);

    expect(sweep?.failedLeads).toEqual([]);
    const all = sweep?.rows;
    const ghost = all?.find((r) => r.sk === GHOST_SK);
    expect(ghost).toBeDefined();
    // `slug`/`column`/`position` come from the KEY. The row has no atom for any
    // of them, so anything that read the payload copies would report empty here
    // and heal would skip the row as unaddressable.
    expect(ghost?.slug).toBe("debug-protein");
    expect(ghost?.column).toBe("todo");
    // `parseBoardCardSk` un-pads: the sk stores the sortable zero-padded form,
    // the card carries the numeric one.
    expect(ghost?.position).toBe("7777");
    // One row per address: the ghost is reached under a single lead, the live
    // card under all 24, and both appear exactly once.
    expect(all).toHaveLength(2);
  });

  test("heal reaps the ghost as an orphan and leaves the live card alone", async () => {
    const node = boardWithGhost();
    const { report } = await boardCardsHealResult({
      cfg,
      node,
      board: BOARD,
      json: true,
      apply: true,
    });

    expect(report.missing_card).toBe(1);
    const reaped = report.actions.filter((a) => a.action === "delete-orphan");
    expect(reaped.map((a) => a.slug)).toEqual(["debug-protein"]);

    // The row is really gone, and the healthy one really is not.
    const left = node.rowsOf("boardcardshash");
    expect(left.map((r) => r.rangeKey)).toEqual([boardCardSk("todo", "p1", "live-card")]);
  });
});

// A lead can fail on its own. Found on the live primary the first time the
// sweep ran: board `agent-dogfood-scratch` answers every lead with 0 rows
// except `column`, which returns
// `HTTP 400 … laststore: corrupt: empty rec`. No kanban read path leads with
// `column`, so that partition has reported itself empty and healthy to every
// check in the codebase.
//
// Both wrong answers were available and both are pinned closed here: swallowing
// the error returns a short row set labelled complete, and throwing lets one
// corrupt marker on one board stop heal from running on every board.
describe("a lead the node refuses", () => {
  /** `fakeNode` with one lead wired to fail, the way the primary fails it. */
  function nodeWithCorruptLead(lead: string): FakeNode {
    const node = boardWithGhost();
    const realQueryAll = node.queryAll.bind(node);
    node.queryAll = async (opts) => {
      if (opts.schemaHash === "boardcardshash" && opts.fields[0] === lead && opts.fields.length === 1) {
        throw new Error("Node /api/query returned HTTP 400: Storage backend error: laststore: corrupt: empty rec");
      }
      return realQueryAll(opts);
    };
    return node;
  }

  test("the sweep reports the gap instead of hiding it or throwing", async () => {
    const node = nodeWithCorruptLead("column");
    const sweep = await sweepBoardCardsPartition(node, cfg, BOARD);

    expect(sweep?.failedLeads.map((f) => f.field)).toEqual(["column"]);
    expect(sweep?.failedLeads[0]?.error).toContain("corrupt: empty rec");
    // The other 23 leads still did their job — the sweep degrades, it does not
    // collapse.
    expect(sweep?.rows.map((r) => r.sk)).toContain(GHOST_SK);
  });

  test("heal still runs, still reaps, and says its counts are a lower bound", async () => {
    const node = nodeWithCorruptLead("column");
    const { text, report } = await boardCardsHealResult({
      cfg,
      node,
      board: BOARD,
      json: true,
      apply: true,
    });

    // Under-reaping is the safe degradation; not running at all is not.
    expect(report.missing_card).toBe(1);
    expect(report.incomplete_leads).toEqual([`${BOARD}:column`]);
    expect(text).toContain("INCOMPLETE");
    expect(text).toContain("LOWER BOUND");
  });
});
