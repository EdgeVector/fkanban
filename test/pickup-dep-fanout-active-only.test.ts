// A dep edge declared ONLY by a card in a terminal column must not be
// point-read: `buildPickupStatusReport` classifies `activeCards`, so that edge
// produces a `depStatus` no code path can observe.
//
// This got worse, not better, as the `done` archive drained — archiving a
// finished card whose dependents are also finished turns each of those edges into
// a dangling target, and the live count went 4 -> 14 mid-sweep.
import { describe, expect, test } from "bun:test";

import type { Config, } from "../src/config.ts";
import type { NodeClient, QueryFilter } from "../src/client.ts";
import { buildPickupStatusReportWithSituations } from "../src/pickup.ts";
import type { Board, Card } from "../src/record.ts";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: { card: "card-hash" },
} as unknown as Config;

const boards: Board[] = [
  {
    slug: "default",
    title: "default",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "",
    updated_at: "",
  } as Board,
];

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

/** A node that records every HashKey slug the dep fan-out asks for. */
function recordingNode(): { node: NodeClient; hashKeyReads: string[] } {
  const hashKeyReads: string[] = [];
  const node = {
    queryAll: async (args: { filter?: QueryFilter }) => {
      const slug = (args.filter as Record<string, string> | undefined)?.HashKey;
      if (typeof slug === "string") hashKeyReads.push(slug);
      return { results: [] };
    },
  } as unknown as NodeClient;
  return { node, hashKeyReads };
}

describe("pickup dep fan-out is bounded to the classified set", () => {
  test("a dep declared only by a TERMINAL card is never point-read", async () => {
    const { node, hashKeyReads } = recordingNode();
    const cards = [
      card({ slug: "finished", column: "done", deps: ["ghost-dep"] }),
      card({ slug: "waiting", column: "todo" }),
    ];

    await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    expect(hashKeyReads).not.toContain("ghost-dep");
  });

  test("a dep declared by an ACTIVE card IS still point-read", async () => {
    const { node, hashKeyReads } = recordingNode();
    const cards = [card({ slug: "waiting", column: "todo", deps: ["off-board-dep"] })];

    await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    expect(hashKeyReads).toContain("off-board-dep");
  });

  test("a same-board dep is resolved from the read set, not point-read", async () => {
    const { node, hashKeyReads } = recordingNode();
    const cards = [
      card({ slug: "waiting", column: "todo", deps: ["peer"] }),
      card({ slug: "peer", column: "done" }),
    ];

    await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    expect(hashKeyReads).not.toContain("peer");
  });

  test("the active card's verdict is unchanged: a missing dep still blocks it", async () => {
    const { node } = recordingNode();
    const cards = [
      card({ slug: "waiting", column: "todo", deps: ["off-board-dep"] }),
      card({ slug: "finished", column: "done", deps: ["ghost-dep"] }),
    ];

    const report = await buildPickupStatusReportWithSituations(cards, boards, undefined, {
      cfg,
      node,
    });

    const waiting = report.cards.find((c) => c.slug === "waiting");
    expect(waiting).toBeDefined();
    expect(waiting!.missingDeps).toContain("off-board-dep");
    // Terminal cards are not classified at all, before or after this change.
    expect(report.cards.map((c) => c.slug)).not.toContain("finished");
  });
});
