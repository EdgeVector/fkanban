// Body-free projections must never reach a body VERDICT or a card WRITE.
//
// Why this file exists: `listCards` serves a board-wide list from the
// BoardCards partitions, which carry no `body`. The Card it returns is
// `body: ""` — indistinguishable by value from a card whose stored body really
// is empty. Six call sites treated the two as the same thing, and because the
// fake node in every other test file returns whatever it stored (never a
// projection), the whole class was invisible to the suite while being the
// normal path in production. Measured on the live board 2026-07-30: `groom
// stale-blockers` called 238 of 245 active cards hollow and would have demoted
// all 102 todo cards, blanking each brief on the way out.
//
// These tests use a MUTABLE fake that serves BoardCards body-free and Card
// whole, the way a real install does, and then assert on the STORED record
// after the command runs — the only place a silent body wipe is visible.

import { describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  isBodyOmitted,
  listCards,
  rowToCard,
  updateCardRecord,
  type Board,
  type Card,
} from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { classifyPickupCard, pickupClassificationNeedsBody } from "../src/pickup.ts";
import { groomStaleBlockersResult, groomStructuredRoutingResult } from "../src/commands/groom.ts";
import { rankCmd } from "../src/commands/rank.ts";
import { moveCmd } from "../src/commands/move.ts";
import { overlapAgainstCards, overlapCmd } from "../src/commands/overlap.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { pickupExplainResult } from "../src/commands/pickup_explain.ts";
import { pickupStatusResult } from "../src/commands/pickup_status.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

const BRIEF = [
  "Repo: EdgeVector/kanban",
  "Base: main",
  "",
  "## GOAL",
  "Prove the stored brief survives a board sweep.",
  "",
  "## END STATE",
  "The body is still here after rank/groom/move.",
  "",
].join("\n");

function board(partial: Partial<Board> = {}): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: BRIEF,
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    repo: "EdgeVector/kanban",
    base: "main",
    kind: "pr",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

type Row = { fields: Record<string, unknown>; hash: string; range: string | null };

/**
 * A fake node that behaves like a real install: the BoardCards partitions are
 * body-free by construction, the Card schema is whole, writes persist, and
 * `queryAll` honors the requested field projection instead of handing back
 * every stored field. That last point is the reason this fake exists —
 * without it a projection bug cannot fail a test.
 */
function fakeNode(cards: Card[], boards: Board[] = [board()]) {
  const tables = new Map<string, Row[]>();
  const rowsOf = (schemaHash: string): Row[] => {
    let t = tables.get(schemaHash);
    if (!t) {
      t = [];
      tables.set(schemaHash, t);
    }
    return t;
  };

  for (const b of boards) rowsOf("boardhash").push({ fields: boardToFields(b), hash: b.slug, range: null });
  for (const c of cards) {
    rowsOf("cardhash").push({ fields: cardToFields(c), hash: c.slug, range: null });
    rowsOf("boardcardshash").push({
      fields: boardCardFieldsFromCard(c),
      hash: c.board,
      range: boardCardSk(c.column, c.position, c.slug),
    });
  }

  const project = (fields: Record<string, unknown>, requested?: string[]): Record<string, unknown> => {
    if (!requested || requested.length === 0) return { ...fields };
    const out: Record<string, unknown> = {};
    for (const f of requested) if (f in fields) out[f] = fields[f];
    return out;
  };

  const stub = () => {
    throw new Error("not implemented in fake node");
  };

  /**
   * `merge` distinguishes the two node verbs, which are NOT the same write:
   * `createRecord` states the whole record, `updateRecord` states a subset and
   * leaves every unsent field alone. A fake that replaces on update is
   * strictly more destructive than LastDB — which sounds safe and isn't: it
   * makes a correct narrow write look like data loss, and it means the suite
   * cannot catch a genuine partial-write bug.
   */
  const write = (
    schemaHash: string,
    fields: Record<string, unknown>,
    hash: string,
    range: string | null,
    merge = false,
  ) => {
    const t = rowsOf(schemaHash);
    const idx = t.findIndex((r) => r.hash === hash && r.range === range);
    if (idx >= 0) t[idx] = { fields: merge ? { ...t[idx]!.fields, ...fields } : fields, hash, range };
    else t.push({ fields, hash, range });
  };

  const node = {
    baseUrl: "http://fake",
    userHash: "test-user",
    /** The stored Card record for a slug — truth, after every write. */
    stored(slug: string): Card | null {
      const row = rowsOf("cardhash").find((r) => r.hash === slug);
      return row ? rowToCard({ fields: row.fields, key: { hash: row.hash, range: row.range } } as QueryRow) : null;
    },
    autoIdentity: stub as never,
    bootstrap: stub as never,
    loadSchemas: stub as never,
    listSchemas: stub as never,
    rawCall: stub as never,
    nodeTransport: stub as never,
    async createRecord({ schemaHash, fields, keyHash, rangeKey }: {
      schemaHash: string;
      fields: Record<string, unknown>;
      keyHash: string;
      rangeKey?: string;
    }) {
      write(schemaHash, fields, keyHash, rangeKey ?? null);
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }: {
      schemaHash: string;
      fields: Record<string, unknown>;
      keyHash: string;
      rangeKey?: string;
    }) {
      write(schemaHash, fields, keyHash, rangeKey ?? null, true);
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }: {
      schemaHash: string;
      keyHash: string;
      rangeKey?: string;
    }) {
      const t = rowsOf(schemaHash);
      const idx = t.findIndex((r) => r.hash === keyHash && r.range === (rangeKey ?? null));
      if (idx >= 0) t.splice(idx, 1);
    },
    async queryAll(q: { schemaHash: string; fields?: string[]; filter?: QueryFilter }): Promise<QueryResponse> {
      const all = rowsOf(q.schemaHash);
      const prefix = (q.filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
        ?.HashRangePrefix;
      let rows = all;
      if (prefix?.hash !== undefined && prefix.prefix !== undefined) {
        rows = all.filter((r) => r.hash === prefix.hash && (r.range ?? "").startsWith(prefix.prefix!));
      } else if (q.filter?.HashKey) {
        rows = all.filter((r) => r.hash === q.filter!.HashKey);
      }
      const results = rows.map((r) => ({
        fields: project(r.fields, q.fields),
        key: { hash: r.hash, range: r.range },
      }));
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
  };
  return node as unknown as NodeClient & { stored(slug: string): Card | null };
}

describe("the board list is a body-free projection and says so", () => {
  test("listCards marks its cards body-omitted; the stored card still has its body", async () => {
    const node = fakeNode([card({ slug: "a" })]);
    const [listed] = await listCards(node, cfg);

    expect(listed!.body).toBe("");
    expect(isBodyOmitted(listed!)).toBe(true);
    expect(node.stored("a")!.body).toBe(BRIEF);
  });

  test("the marker never reaches the wire — it is not part of the card's JSON shape", async () => {
    const node = fakeNode([card({ slug: "a" })]);
    const [listed] = await listCards(node, cfg);

    expect(Object.keys(JSON.parse(JSON.stringify(listed)))).not.toContain("body_omitted");
    expect(JSON.stringify(listed)).not.toContain("Omitted");
  });

  test("a card write refuses the projection outright", async () => {
    const node = fakeNode([card({ slug: "a" })]);
    const [listed] = await listCards(node, cfg);

    const err = await updateCardRecord({ cfg, node }, { ...listed!, position: "20" }).catch((e) => e);
    expect(err).toBeInstanceOf(FkanbanError);
    expect((err as FkanbanError).code).toBe("card_body_not_loaded");
    // The point of the guard: the brief is untouched.
    expect(node.stored("a")!.body).toBe(BRIEF);
  });
});

describe("rank", () => {
  test("honors a Priority: body header and leaves every body intact", async () => {
    const node = fakeNode([
      card({ slug: "tagged-p1", position: "1", tags: ["p1"], body: BRIEF }),
      card({ slug: "header-p0", position: "2", body: `Priority: P0\n${BRIEF}` }),
    ]);

    const result = await rankCmd({ cfg, node, board: "default", column: "todo" });

    // The header outranks the tag — the signal only exists in the body, so on
    // the body-free list both cards defaulted to P2 and kept insertion order.
    expect(result.order.map((c) => c.slug)).toEqual(["header-p0", "tagged-p1"]);
    expect(node.stored("header-p0")!.body).toContain("## GOAL");
    expect(node.stored("tagged-p1")!.body).toBe(BRIEF);
  });
});

describe("groom stale-blockers", () => {
  test("does not call a card with a full brief hollow", async () => {
    const node = fakeNode([card({ slug: "well-formed" })]);

    const { report } = await groomStaleBlockersResult({ cfg, node, apply: true });

    const kinds = report.cards.flatMap((c) => c.issues.map((i) => i.kind));
    expect(kinds).not.toContain("hollow-pr-in-todo");
    expect(kinds).not.toContain("hollow-pr-brief");
    expect(report.changed).toBe(0);
    // The card stayed in the pickup lane with its brief.
    expect(node.stored("well-formed")!.column).toBe("todo");
    expect(node.stored("well-formed")!.body).toBe(BRIEF);
  });

  test("still catches a genuinely hollow card", async () => {
    const node = fakeNode([card({ slug: "shell", body: "Repo: EdgeVector/kanban\nBase: main\n" })]);

    const { report } = await groomStaleBlockersResult({ cfg, node });

    const kinds = report.cards.flatMap((c) => c.issues.map((i) => i.kind));
    expect(kinds).toContain("hollow-pr-in-todo");
  });
});

describe("groom structured-routing", () => {
  test("backfills structured routing without blanking the stored brief", async () => {
    const node = fakeNode([
      card({
        slug: "body-routed",
        repo: "",
        base: "",
        body: BRIEF,
      }),
    ]);

    const { report } = await groomStructuredRoutingResult({ cfg, node, apply: true });

    expect(report.changed).toBe(1);
    const stored = node.stored("body-routed")!;
    expect(stored.repo).toBe("EdgeVector/kanban");
    expect(stored.base).toBe("main");
    expect(stored.body).toBe(BRIEF);
  });
});

describe("pickup explain", () => {
  test("the write-guard gate passes for a card that is in fact pickup-ready", async () => {
    const node = fakeNode([card({ slug: "ready" })]);

    const report = await pickupExplainResult({ cfg, node, slug: "ready" });

    expect(report.write_guard.ok).toBe(true);
    expect(report.gates.find((g) => g.name.startsWith("write-guard"))!.ok).toBe(true);
    expect(report.eligible_for_claim).toBe(true);
  });
});

describe("move into the terminal column", () => {
  test("promotes an unblocked backlog dependent and keeps its brief", async () => {
    const node = fakeNode([
      card({ slug: "blocker", column: "doing", position: "1" }),
      card({ slug: "dependent", column: "backlog", position: "1", deps: ["blocker"] }),
    ]);

    await moveCmd({ cfg, node, slug: "blocker", column: "done" });

    // The gate that decides this reads the brief. On the body-free list it saw
    // an empty body on every dependent, threw `default_todo_not_pickup_ready`,
    // and the promotion loop swallowed it — so this silently never happened.
    expect(node.stored("dependent")!.column).toBe("todo");
    expect(node.stored("dependent")!.body).toBe(BRIEF);
  });
});

describe("pickup claim over the body-free projection", () => {
  test("claims a card whose list row is body-free and leaves the stored brief intact", async () => {
    // The live poison-queue shape: every BoardCards row serves body:"" while
    // the stored Card carries a full brief. The claim must read Card truth at
    // the write choke points — and every write it performs along the way
    // (move, assignee stamp, self-heal) must leave the stored brief alone.
    const node = fakeNode([card({ slug: "blank-row" })]);

    const result = await pickupClaimResult({ cfg, node, worker: "w1" });

    expect(result.claimed).toBe(true);
    expect(result.card?.slug).toBe("blank-row");

    const stored = node.stored("blank-row")!;
    expect(stored.column).toBe("doing");
    expect(stored.assignee).toBe("w1");
    expect(stored.body).toBe(BRIEF);
  });
});

// ── Read-only surfaces ─────────────────────────────────────────────────────
// These three never write, which is why they were split out of the CR that
// fixed the write paths. They still reported a body-derived VERDICT about a
// body they never fetched, which is its own kind of damage: a conflict that
// is never seen, and a routing complaint about a card that routes fine.

const BODY_ONLY_ROUTING = [
  "Repo: EdgeVector/kanban",
  "Base: main",
  "Surfaces: src/pickup.ts",
  "",
  "## GOAL",
  "Declare routing and surfaces in the body, the way older cards do.",
  "",
  "## END STATE",
  "Overlap and pickup status both see these.",
  "",
].join("\n");

describe("overlap against a doing peer", () => {
  test("sees a conflict whose surfaces are declared only in the peer's body", async () => {
    const node = fakeNode([
      card({ slug: "candidate", column: "todo", surfaces: ["src/pickup.ts"] }),
      card({
        slug: "peer",
        column: "doing",
        position: "1",
        body: BODY_ONLY_ROUTING,
        surfaces: [],
      }),
    ]);

    const { result } = await overlapCmd({ cfg, node, slug: "candidate" });

    // Before hydration the peer's `Surfaces:` header was invisible, so this
    // read "no surfaces; overlap unknown" and the claim gate let a colliding
    // card through.
    expect(result.conflicts.map((c) => c.slug)).toEqual(["peer"]);
  });

  test("a peer whose repo is unread is reported unknown, not filtered away as a different repo", async () => {
    const listed = await listCards(
      fakeNode([
        card({ slug: "peer", column: "doing", position: "1", repo: "", body: BODY_ONLY_ROUTING }),
      ]),
      cfg,
    );
    const candidate = card({ slug: "candidate", surfaces: ["src/pickup.ts"] });

    const result = overlapAgainstCards(candidate, listed);

    expect(isBodyOmitted(listed[0]!)).toBe(true);
    expect(result.warnings.join("\n")).toContain("body was not read");
    expect(result.warnings.join("\n")).toContain("peer");
  });

  test("an honest absence still reads as an absence, not as an unread body", async () => {
    const node = fakeNode([
      card({ slug: "candidate", column: "todo", surfaces: ["src/pickup.ts"] }),
      card({ slug: "peer", column: "doing", position: "1", surfaces: [], body: BRIEF }),
    ]);

    const { result } = await overlapCmd({ cfg, node, slug: "candidate" });

    expect(result.conflicts).toEqual([]);
    expect(result.warnings.join("\n")).toContain("no surfaces");
    expect(result.warnings.join("\n")).not.toContain("body was not read");
  });
});

describe("pickup status", () => {
  test("a card whose Repo/Base live only in its body is pickup-ready, not malformed-routing", async () => {
    const node = fakeNode([
      card({ slug: "body-routed", repo: "", base: "", body: BODY_ONLY_ROUTING }),
    ]);

    const { report } = await pickupStatusResult({ cfg, node });

    const classification = report.cards.find((c) => c.slug === "body-routed")!;
    expect(classification.category).toBe("pickup-ready");
    expect(classification.repo).toBe("EdgeVector/kanban");
    expect(classification.base).toBe("main");
  });

  test("a card that really has no routing is still reported malformed", async () => {
    const node = fakeNode([
      card({ slug: "unrouted", repo: "", base: "", body: "## GOAL\nNo routing anywhere.\n" }),
    ]);

    const { report } = await pickupStatusResult({ cfg, node });

    const classification = report.cards.find((c) => c.slug === "unrouted")!;
    expect(classification.category).toBe("malformed-routing");
    expect(classification.reason).toBe("missing Repo header");
    // The complaint is about a body we read, so it must not hedge.
    expect(classification.details.join(" ")).not.toContain("not read");
  });

  test("classification never judges routing off a body it did not read", async () => {
    const [unread] = await listCards(
      fakeNode([card({ slug: "thin", repo: "", base: "", body: BODY_ONLY_ROUTING })]),
      cfg,
    );

    const result = classifyPickupCard(unread!, [unread!], {
      blocked: false,
      blockedBy: [],
      missing: [],
    });

    expect(pickupClassificationNeedsBody(unread!)).toBe(true);
    expect(result.reason).toContain("the body was not read");
    expect(result.details).toContain("card body was not read");
  });
});
