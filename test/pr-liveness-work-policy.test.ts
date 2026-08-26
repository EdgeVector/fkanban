import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { pickupWorkPolicyResult } from "../src/commands/pickup_work_policy.ts";
import { pickupExplainResult } from "../src/commands/pickup_explain.ts";
import {
  classifyPrProbe,
  parsePrUrl,
  probePrLiveness,
  workPolicyAction,
  type PrLiveness,
  type PrLivenessProbe,
} from "../src/pr_liveness.ts";
import { classifyPickupCard } from "../src/pickup.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  nowIso,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const CLOSED_FORGE_PR = "http://100.109.94.59:3300/EdgeVector/fold/pulls/1694";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

function baseCard(over: Partial<Card> = {}): Card {
  return {
    ...emptyStructuredFields(),
    slug: "demo-ready",
    title: "Demo ready card",
    body: "Repo: EdgeVector/fold\nBase: main\nKind: pr\n\n## GOAL\nShip it.\n\n## END STATE\nDone.\n",
    board: "default",
    column: "todo",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: ["src/foo.ts"],
    created_at: nowIso(),
    updated_at: nowIso(),
    done_at: "",
    db: "",
    repo: "EdgeVector/fold",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "north-star-host-track",
    pr_url: "",
    branch: "",
    ...over,
    position: over.position ?? "1000",
  };
}

function fakeNode(cards: Card[]): NodeClient {
  const now = nowIso();
  const cardRows = new Map(cards.map((c) => [c.slug, cardToFields(c)]));
  const boardFields = boardToFields({
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
  });
  const boardCardRows: QueryRow[] = cards.map((c) => ({
    fields: boardCardFieldsFromCard(c),
    key: { hash: c.board, range: boardCardSk(c.column, c.position, c.slug) },
  }));
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    if (schemaHash === cfg.schemaHashes.board_cards) {
      if (filter && "HashRangePrefix" in (filter as object)) {
        const prefix = (filter as { HashRangePrefix?: { hash: string; prefix: string } }).HashRangePrefix;
        if (prefix) {
          return boardCardRows.filter((r) =>
            r.key.hash === prefix.hash && (r.key.range ?? "").startsWith(prefix.prefix),
          );
        }
      }
      if (filter?.HashKey) return boardCardRows.filter((r) => r.key.hash === filter.HashKey);
      return boardCardRows;
    }
    const fields = schemaHash === cfg.schemaHashes.card
      ? cardRows
      : new Map([["default", boardFields]]);
    const entries = filter?.HashKey
      ? (fields.has(filter.HashKey) ? [[filter.HashKey, fields.get(filter.HashKey)!] as const] : [])
      : [...fields.entries()];
    return entries.map(([hash, rowFields]) => ({ fields: rowFields, key: { hash, range: null } }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`fakeNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    createRecord: notImpl("createRecord") as NodeClient["createRecord"],
    updateRecord: notImpl("updateRecord") as NodeClient["updateRecord"],
    deleteRecord: notImpl("deleteRecord") as NodeClient["deleteRecord"],
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
  };
}

const closedUnmergedProbe: PrLivenessProbe = async () => ({
  found: true,
  open: false,
  merged: false,
});

const openProbe: PrLivenessProbe = async () => ({
  found: true,
  open: true,
  merged: false,
});

const mergedProbe: PrLivenessProbe = async () => ({
  found: true,
  open: false,
  merged: true,
});

describe("parsePrUrl", () => {
  test("classifies a Forgejo /pulls/ locator", () => {
    const p = parsePrUrl(CLOSED_FORGE_PR);
    expect(p.venue).toBe("forgejo");
    expect(p.owner).toBe("EdgeVector");
    expect(p.repo).toBe("fold");
    expect(p.number).toBe("1694");
    expect(p.origin).toBe("http://100.109.94.59:3300");
  });

  test("classifies a GitHub /pull/ locator", () => {
    const p = parsePrUrl("https://github.com/EdgeVector/fkanban/pull/12");
    expect(p.venue).toBe("github");
    expect(p.owner).toBe("EdgeVector");
    expect(p.repo).toBe("fkanban");
    expect(p.number).toBe("12");
  });

  test("classifies a lastgit locator", () => {
    const p = parsePrUrl("lastgit://fkanban/cr/cr-abc123");
    expect(p.venue).toBe("lastgit");
    expect(p.lastgitSlug).toBe("fkanban");
    expect(p.crId).toBe("cr-abc123");
  });
});

describe("classifyPrProbe → work-policy action", () => {
  test("closed unmerged returns fresh work, not reconcile", () => {
    const live = classifyPrProbe(CLOSED_FORGE_PR, "forgejo", {
      found: true,
      open: false,
      merged: false,
    });
    expect(live.state).toBe("closed-unmerged");
    expect(live.action).toBe("work");
    expect(workPolicyAction(live.state)).toBe("work");
  });

  test("open returns reconcile", () => {
    const live = classifyPrProbe(CLOSED_FORGE_PR, "forgejo", {
      found: true,
      open: true,
      merged: false,
    });
    expect(live.state).toBe("open");
    expect(live.action).toBe("reconcile");
  });

  test("merged returns closeout", () => {
    const live = classifyPrProbe("lastgit://fkanban/cr/cr-1", "lastgit", {
      found: true,
      open: false,
      merged: true,
    });
    expect(live.state).toBe("merged");
    expect(live.action).toBe("closeout");
  });

  test("404 / missing row is closed-unmerged (dead locator)", () => {
    const live = classifyPrProbe(CLOSED_FORGE_PR, "forgejo", {
      found: false,
      open: false,
      merged: false,
    });
    expect(live.state).toBe("closed-unmerged");
    expect(live.action).toBe("work");
  });

  test("probe error is unknown fail-closed reconcile", () => {
    const live = classifyPrProbe(CLOSED_FORGE_PR, "forgejo", {
      found: false,
      open: false,
      merged: false,
      error: "timeout",
    });
    expect(live.state).toBe("unknown");
    expect(live.action).toBe("reconcile");
  });

  test("empty pr_url is none → work", () => {
    const live = classifyPrProbe("", "unknown", null);
    expect(live.state).toBe("none");
    expect(live.action).toBe("work");
  });
});

describe("classifyPickupCard with PR liveness", () => {
  const dep = { blocked: false, blockedBy: [], missing: [] };

  test("a closed-unmerged pr_url is pickup-ready, not a collision", () => {
    const card = baseCard({ slug: "stale-pr", pr_url: CLOSED_FORGE_PR });
    const live: PrLiveness = {
      pr_url: CLOSED_FORGE_PR,
      state: "closed-unmerged",
      venue: "forgejo",
      action: "work",
      note: "PR/CR is closed and unmerged; treat as no PR (fresh WORK)",
    };
    const c = classifyPickupCard(card, [card], dep, undefined, {
      prLivenessBySlug: new Map([[card.slug, live]]),
    });
    expect(c.ready).toBe(true);
    expect(c.category).toBe("pickup-ready");
    expect(c.details.join(" ")).toContain("closed-unmerged");
  });

  test("an open pr_url stays a collision so pickup does not start a second WORK unit", () => {
    const card = baseCard({ slug: "open-pr", pr_url: CLOSED_FORGE_PR });
    const live: PrLiveness = {
      pr_url: CLOSED_FORGE_PR,
      state: "open",
      venue: "forgejo",
      action: "reconcile",
      note: "PR/CR is open; reconcile (not pickup WORK)",
    };
    const c = classifyPickupCard(card, [card], dep, undefined, {
      prLivenessBySlug: new Map([[card.slug, live]]),
    });
    expect(c.ready).toBe(false);
    expect(c.category).toBe("collision");
    expect(c.suggestion).toContain("open PR");
  });

  test("without a liveness map, any pr_url stays fail-closed collision", () => {
    const card = baseCard({ slug: "no-probe", pr_url: CLOSED_FORGE_PR });
    const c = classifyPickupCard(card, [card], dep);
    expect(c.ready).toBe(false);
    expect(c.category).toBe("collision");
  });
});

describe("pickup work-policy command", () => {
  test("fixture card with a closed unmerged PR returns work, not reconcile", async () => {
    const card = baseCard({ slug: "stale-pr", pr_url: CLOSED_FORGE_PR });
    const node = fakeNode([card]);
    const report = await pickupWorkPolicyResult({
      cfg,
      node,
      slug: "stale-pr",
      probe: closedUnmergedProbe,
    });
    expect(report.action).toBe("work");
    expect(report.pr_liveness.state).toBe("closed-unmerged");
    expect(report.stale_pr_url).toBe(true);
    expect(report.action).not.toBe("reconcile");
  });

  test("open PR returns reconcile", async () => {
    const card = baseCard({ slug: "open-pr", pr_url: CLOSED_FORGE_PR });
    const node = fakeNode([card]);
    const report = await pickupWorkPolicyResult({
      cfg,
      node,
      slug: "open-pr",
      probe: openProbe,
    });
    expect(report.action).toBe("reconcile");
    expect(report.pr_liveness.state).toBe("open");
  });

  test("merged PR returns closeout", async () => {
    const card = baseCard({ slug: "merged-pr", pr_url: "lastgit://fold/cr/cr-1" });
    const node = fakeNode([card]);
    const report = await pickupWorkPolicyResult({
      cfg,
      node,
      slug: "merged-pr",
      probe: mergedProbe,
    });
    expect(report.action).toBe("closeout");
    expect(report.pr_liveness.state).toBe("merged");
  });
});

describe("pickup explain prints PR-liveness", () => {
  test("explain text and JSON carry the closed-unmerged verdict", async () => {
    const card = baseCard({ slug: "stale-pr", pr_url: CLOSED_FORGE_PR });
    const node = fakeNode([card]);
    const report = await pickupExplainResult({
      cfg,
      node,
      slug: "stale-pr",
      prLivenessProbe: closedUnmergedProbe,
    });
    expect(report.pr_liveness.state).toBe("closed-unmerged");
    expect(report.pr_liveness.action).toBe("work");
    expect(report.ready).toBe(true);
    const gate = report.gates.find((g) => g.name === "pr-liveness");
    expect(gate).toBeDefined();
    expect(gate!.note).toContain("closed-unmerged");
    expect(gate!.ok).toBe(true);
  });
});

describe("probePrLiveness uses the injected probe", () => {
  test("does not hit the network when a probe is supplied", async () => {
    const live = await probePrLiveness(CLOSED_FORGE_PR, { probe: closedUnmergedProbe });
    expect(live.state).toBe("closed-unmerged");
    expect(live.action).toBe("work");
  });
});
