// `pickup status` is the gate every pickup worker runs BEFORE it can claim a
// card, so its read cost is throughput, not tidiness. Two reads in it were
// paid for rows no verdict could ever depend on. Measured on the live primary
// 2026-09-04, one call issued 532 node queries and took 38s against the gate's
// 45s cap; 16 of 70 pickup cycles claimed nothing because the read did not
// finish, while the board held 16 ready.
//
// 1. OFF-BOARD ROWS. Milestone rows reach the card list through BoardCards, and
//    arrive carrying a Milestone `state` in `column` (`planned`/`active`/
//    `complete`/`abandoned`). Boards cannot redefine columns, so no `fkanban
//    move` can route such a row — yet all 29 of them were classified, and all
//    29 landed in `malformed-routing` complaining about a `repo` field a
//    milestone does not have by design. That bucket was 29 false positives and
//    0 real cards.
// 2. THE MILESTONE SEED. The milestone-state map was seeded from the whole
//    portfolio: 217 rows, 14.0s, of which 27 were referenced by an active card.
//    Classification only ever looks the map up by `card.milestone`, so the
//    other 190 could not be read out of it by any path.
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient, QueryFilter } from "../src/client.ts";
import { buildPickupStatusReportWithSituations } from "../src/pickup.ts";
import type { Card } from "../src/record.ts";

const MILESTONE_HASH = "milestone-hash";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { card: "card-hash", milestone: MILESTONE_HASH },
  enforceLivePrMilestone: true,
} as unknown as Config;

function card(partial: Partial<Card> & { slug: string }): Card {
  return {
    title: partial.slug,
    body: "",
    board: "default",
    column: "todo",
    position: "0",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: "",
    created_by: "test",
    updated_at: "",
    done_at: "",
    db: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

type Seen = { schemaHash: string; filter?: QueryFilter };

/** Records every query the report issues, with the schema it was aimed at. */
function recordingNode(): { node: NodeClient; queries: Seen[] } {
  const queries: Seen[] = [];
  const node = {
    queryAll: async (args: { schemaHash: string; fields: string[]; filter?: QueryFilter }) => {
      queries.push({ schemaHash: args.schemaHash, filter: args.filter });
      return { results: [] };
    },
  } as unknown as NodeClient;
  return { node, queries };
}

const hashKeysFor = (queries: Seen[], schemaHash: string): string[] =>
  queries
    .filter((q) => q.schemaHash === schemaHash)
    .map((q) => (q.filter as Record<string, string> | undefined)?.HashKey)
    .filter((slug): slug is string => typeof slug === "string");

describe("pickup status skips rows that are on no board column", () => {
  test("a Milestone-shaped row is counted apart, never classified as a broken card", async () => {
    const { node } = recordingNode();
    const cards = [
      card({ slug: "real-card", column: "todo" }),
      // What BoardCards actually hands back: a milestone state in `column`, and
      // no repo — which the router used to report as malformed routing.
      card({ slug: "some-milestone-proof", column: "complete", repo: "", base: "" }),
      card({ slug: "another-milestone", column: "planned", repo: "", base: "" }),
    ];

    const report = await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });

    expect(report.cards.map((c) => c.slug)).toEqual(["real-card"]);
    expect(report.counts["off-board/non-card"]).toBe(2);
    expect(report.counts["malformed-routing"]).toBe(0);
    expect(report.scanned).toBe(1);
  });

  test("an off-board row's dependency edges are not point-read", async () => {
    const { node, queries } = recordingNode();
    const cards = [
      card({ slug: "real-card", column: "todo" }),
      card({ slug: "some-milestone-proof", column: "complete", deps: ["ghost-dep"] }),
    ];

    await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });

    expect(hashKeysFor(queries, "card-hash")).not.toContain("ghost-dep");
  });

  test("a real card on a real column is still classified", async () => {
    const { node } = recordingNode();
    const report = await buildPickupStatusReportWithSituations(
      [card({ slug: "real-card", column: "todo" })],
      undefined,
      { cfg, node },
    );

    expect(report.scanned).toBe(1);
    expect(report.cards.map((c) => c.slug)).toEqual(["real-card"]);
    expect(report.counts["off-board/non-card"]).toBe(0);
  });
});

describe("pickup status reads only the milestones some card references", () => {
  test("a referenced milestone is point-read; the portfolio is never enumerated", async () => {
    const { node, queries } = recordingNode();
    const cards = [card({ slug: "real-card", column: "todo", milestone: "ms-referenced" })];

    await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });

    const milestoneQueries = queries.filter((q) => q.schemaHash === MILESTONE_HASH);
    expect(hashKeysFor(queries, MILESTONE_HASH)).toContain("ms-referenced");
    // Every Milestone read is a keyed point read for a slug a card named. A
    // portfolio list would show up here as a query with no HashKey.
    for (const q of milestoneQueries) {
      const filter = q.filter as Record<string, string> | undefined;
      expect(typeof filter?.HashKey).toBe("string");
    }
  });

  test("no card naming a milestone means no Milestone read at all", async () => {
    const { node, queries } = recordingNode();
    const cards = [card({ slug: "real-card", column: "todo", milestone: "" })];

    await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });

    expect(queries.filter((q) => q.schemaHash === MILESTONE_HASH)).toHaveLength(0);
  });

  test("an off-board row's milestone reference does not buy a Milestone read", async () => {
    const { node, queries } = recordingNode();
    const cards = [
      card({ slug: "real-card", column: "todo", milestone: "" }),
      card({ slug: "some-milestone-proof", column: "complete", milestone: "ms-unreachable" }),
    ];

    await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });

    expect(hashKeysFor(queries, MILESTONE_HASH)).not.toContain("ms-unreachable");
  });
});
