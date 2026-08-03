// `pickup status` issues two independent Card fan-outs: the off-set dependency
// resolution and the routing-body hydrate. They used to be awaited one after the
// other, which on this node costs a whole extra round-trip WAVE for nothing.
//
// Measured on the live primary 2026-08-03: a Card point read costs the node
// 1.9ms and the caller ~197ms — ~99% of a kanban read is per-request latency
// this process does not control — and it parallelizes completely (10 sequential
// requests 1.90s, 10 concurrent 0.177s). So the unit of cost is the serial wave,
// and two independent waves must be one.
//
// These tests pin the OVERLAP itself, not a timing: the hydrate read must be in
// flight while the dep read is still unresolved. A pure "same results" test
// passes against the serial version too.
import { describe, expect, test } from "bun:test";

import type { Config } from "../src/config.ts";
import type { NodeClient, QueryFilter } from "../src/client.ts";
import { buildPickupStatusReportWithSituations } from "../src/pickup.ts";
import { BODY_OMITTED, type Board, type Card } from "../src/record.ts";

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

/** A card that `pickupClassificationNeedsBody` will want a body for. */
function needsBodyCard(slug: string, extra: Partial<Card> = {}): Card {
  const c = card({ slug, repo: "", ...extra });
  c[BODY_OMITTED] = true;
  return c;
}

/**
 * A node whose reads for `blockedSlugs` hang until `release()` is called, and
 * which records the order every HashKey read was ISSUED in.
 */
function gatedNode(blockedSlugs: string[]): {
  node: NodeClient;
  issued: string[];
  release: () => void;
  gateReached: Promise<void>;
} {
  const issued: string[] = [];
  let releaseFn: () => void = () => {};
  const gate = new Promise<void>((resolve) => {
    releaseFn = resolve;
  });
  let markReached: () => void = () => {};
  const gateReached = new Promise<void>((resolve) => {
    markReached = resolve;
  });

  const node = {
    queryAll: async (args: { filter?: QueryFilter }) => {
      const slug = (args.filter as Record<string, string> | undefined)?.HashKey;
      if (typeof slug === "string") {
        issued.push(slug);
        if (blockedSlugs.includes(slug)) {
          markReached();
          await gate;
        }
      }
      return { results: [] };
    },
  } as unknown as NodeClient;

  return { node, issued, release: releaseFn, gateReached };
}

describe("pickup status overlaps the dep fan-out with the body hydrate", () => {
  test("the hydrate read is in flight while the dep read is still unresolved", async () => {
    // `needs-body` is active, pr-kind and has no repo -> wants a body.
    // `has-dep` points at `off-set-dep`, which is not in the card set -> point-read.
    const cards = [needsBodyCard("needs-body"), card({ slug: "has-dep", deps: ["off-set-dep"] })];
    const { node, issued, release, gateReached } = gatedNode(["off-set-dep"]);

    const pending = buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    // Wait until the dep read has actually been issued and is parked on the gate.
    await gateReached;
    // Give any already-scheduled microtasks a chance to run, so this asserts
    // "was not issued", not "has not been scheduled yet".
    await new Promise((r) => setTimeout(r, 5));

    expect(issued).toContain("off-set-dep");
    // THE ASSERTION: the body hydrate went out without waiting for the dep read.
    expect(issued).toContain("needs-body");

    release();
    await pending;
  });

  test("both fan-outs still read exactly the slugs they should", async () => {
    const cards = [needsBodyCard("needs-body"), card({ slug: "has-dep", deps: ["off-set-dep"] })];
    const { node, issued, release } = gatedNode([]);
    release();

    await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    expect(issued.filter((s) => s === "off-set-dep")).toHaveLength(1);
    expect(issued.filter((s) => s === "needs-body")).toHaveLength(1);
    // A card that already carries its body is never point-read.
    expect(issued).not.toContain("has-dep");
  });

  test("a card the dep step INTRODUCED still gets its body hydrated", async () => {
    // `off-set-dep` comes back from the dep fan-out as a live, active, repo-less
    // pr card — it was never in the input, so only the second pass can hydrate it.
    const introduced = needsBodyCard("off-set-dep");
    const node = {
      queryAll: async (args: { filter?: QueryFilter }) => {
        const slug = (args.filter as Record<string, string> | undefined)?.HashKey;
        issuedSlugs.push(slug ?? "");
        if (slug === "off-set-dep") {
          return { results: [{ fields: { ...introduced, tags: [], deps: [], surfaces: [] } }] };
        }
        return { results: [] };
      },
    } as unknown as NodeClient;
    const issuedSlugs: string[] = [];

    const cards = [card({ slug: "has-dep", deps: ["off-set-dep"] })];
    await buildPickupStatusReportWithSituations(cards, boards, undefined, { cfg, node });

    // Read twice on purpose: once by the dep fan-out (status fields), once by the
    // late hydrate (body). The point is that the SECOND one happens at all.
    expect(issuedSlugs.filter((s) => s === "off-set-dep").length).toBeGreaterThanOrEqual(2);
  });
});
