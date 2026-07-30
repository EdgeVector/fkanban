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
import { groomStaleBlockersResult } from "../src/commands/groom.ts";
import { rankCmd } from "../src/commands/rank.ts";
import { moveCmd } from "../src/commands/move.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { pickupExplainResult } from "../src/commands/pickup_explain.ts";

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

  const write = (schemaHash: string, fields: Record<string, unknown>, hash: string, range: string | null) => {
    const t = rowsOf(schemaHash);
    const idx = t.findIndex((r) => r.hash === hash && r.range === range);
    if (idx >= 0) t[idx] = { fields, hash, range };
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
      write(schemaHash, fields, keyHash, rangeKey ?? null);
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
