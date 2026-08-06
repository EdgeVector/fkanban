// A capped `--json` page that says nothing is a wrong answer, not a short one.
//
// Measured on the live primary 2026-08-06, latest main (`822f4c1b`):
//
//     kanban list --board default --json   ->  34 rows   (of 229)   0 bytes on fd 2
//     kanban search "kanban" --json        ->  20 rows   (of 204)   0 bytes on fd 2
//
// while the SAME invocations' human rendering prints "… N more (--all)". The
// MCP siblings cap too and report `total`/`truncated` — search.ts's own comment
// says the MCP cap "is never silent" — so the asymmetry was documented in the
// source and never closed on the CLI side. `CLAUDE.md` tells every agent to
// begin work with `kanban list`.
//
// WHAT THIS FILE PINS, and why each assertion is here rather than implied:
//
//   1. The notice fires on the implicit cap, and NAMES THE TRUE TOTAL. A bare
//      "output was truncated" would satisfy a weaker test and still leave the
//      reader unable to tell 34-of-36 from 34-of-229.
//   2. POSITIVE CONTROL: an uncapped page emits NOTHING. Without this, a "fix"
//      that unconditionally warns passes every other assertion in the file —
//      and an always-on warning is exactly as uninformative as always-off,
//      because a reader learns nothing from a line that is always there.
//   3. stdout STAYS A BARE ARRAY. This is not tidiness; it is the entire reason
//      the notice went to fd 2 instead of into an `{items, total, truncated}`
//      envelope. The consumer sweep found routine `milestone-driver` reading
//      `jq 'length'` off three `list --json` call sites. Against an envelope
//      `jq length` does not error — it returns the KEY COUNT — so those gates
//      would silently read a constant. If someone later swaps the shape without
//      migrating that consumer, THIS is the assertion that must stop them.
//   4. The `--column` path — the one `milestone-driver` actually calls — is
//      uncapped and silent, and stays that way.
//   5. Explicit `--limit` and `--all` do not warn. Those are the caller stating
//      a bound; the defect was the no-flag default.
//   6. The MCP data path (`listResult`) does not emit the notice. MCP already
//      signals truncation structurally; a second channel would be noise, and
//      putting the notice one level down would have reached it by accident.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse, QueryRow } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardCardFieldsFromCard } from "../src/board-cards.ts";
import { DEFAULT_SEARCH_LIMIT } from "../src/board.ts";
import { DEFAULT_COLUMN_LIMIT, listCmd, listResult } from "../src/commands/list.ts";
import { searchCmd } from "../src/commands/search.ts";
import { truncationNotice } from "../src/truncation_notice.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  nowIso,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://stub",
  schemaServiceUrl: "http://stub",
  userHash: "stub",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash", card_list_index: "cardlisthash" },
};

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "card",
    title: "Card",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    created_at: now,
    updated_at: now,
    ...emptyStructuredFields(),
    ...partial,
  };
}

function board(partial: Partial<Board> = {}): Board {
  const now = nowIso();
  return {
    slug: "default",
    title: "Default",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function node(cards: Card[], boards: Board[] = [board()]): NodeClient {
  const rows = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    if (schemaHash === "cardhash") {
      return cards.map((c) => ({ key: { hash: c.slug, range: null }, fields: cardToFields(c) }));
    }
    if (schemaHash === "boardhash") {
      return boards.map((b) => ({ key: { hash: b.slug, range: null }, fields: boardToFields(b) }));
    }
    if (schemaHash === "boardcardshash") {
      const rangePrefix = (filter as unknown as { HashRangePrefix?: { hash?: string; prefix?: string } } | undefined)
        ?.HashRangePrefix;
      let out = cards.map((c) => {
        const fields = boardCardFieldsFromCard(c);
        return { key: { hash: String(fields.board), range: String(fields.sk) }, fields };
      });
      if (rangePrefix?.hash && rangePrefix.prefix !== undefined) {
        out = out.filter((r) =>
          r.key.hash === rangePrefix.hash &&
          r.key.range !== null &&
          r.key.range.startsWith(rangePrefix.prefix!)
        );
      } else if (filter?.HashKey) {
        out = out.filter((r) => r.key.hash === filter.HashKey);
      }
      return out;
    }
    if (schemaHash === "cardlisthash") {
      const key = filter?.HashKey;
      if (key === "all_boards") {
        return [
          {
            key: { hash: "all_boards", range: null },
            fields: {
              key: "all_boards",
              payload_json: JSON.stringify(boards),
              updated_at: "2026-01-01T00:00:00.000Z",
            },
          },
        ];
      }
      if (key !== undefined && key !== "all_cards") return [];
      return [
        {
          key: { hash: "all_cards", range: null },
          fields: {
            key: "all_cards",
            payload_json: JSON.stringify(cards.map((c) => ({ ...c, body: "" }))),
            updated_at: "2026-01-01T00:00:00.000Z",
          },
        },
      ];
    }
    return [];
  };
  return {
    baseUrl: "http://stub",
    userHash: "stub",
    autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
    bootstrap: async () => ({ userHash: "stub" }),
    loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
    listSchemas: async () => [],
    createRecord: async () => {},
    updateRecord: async () => {},
    deleteRecord: async () => {},
    queryAll: async (q: { schemaHash: string; filter?: QueryFilter }): Promise<QueryResponse> => {
      const results = rows(q.schemaHash, q.filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: async () => ({ status: 200, body: "" }),
  } as unknown as NodeClient;
}

/** A collector standing in for `console.error`, so the notice is asserted rather than printed. */
function sink(): { lines: string[]; warn: (m: string) => void } {
  const lines: string[] = [];
  return { lines, warn: (m: string) => lines.push(m) };
}

// One column deliberately OVER the per-column cap and one deliberately under,
// so a per-column cap and a whole-page cap cannot be confused: 15 todo + 2
// doing = 17 total, capped to 12 + 2 = 14.
const OVER_CAP = DEFAULT_COLUMN_LIMIT + 3;
const UNDER_CAP = 2;
const listCards = [
  ...Array.from({ length: OVER_CAP }, (_, i) =>
    card({ slug: `todo-${i}`, title: `Todo ${i}`, column: "todo", position: `${100 + i}` })),
  ...Array.from({ length: UNDER_CAP }, (_, i) =>
    card({ slug: `doing-${i}`, title: `Doing ${i}`, column: "doing", position: `${200 + i}` })),
];
const LIST_TOTAL = OVER_CAP + UNDER_CAP;
const LIST_KEPT = DEFAULT_COLUMN_LIMIT + UNDER_CAP;

describe("truncationNotice", () => {
  test("names kept, total, and the escape hatch", () => {
    const msg = truncationNotice("list", 34, 229);
    expect(msg).toContain("34 of 229");
    expect(msg).toContain("--all");
  });

  // The boundary, both sides. `kept === total` is the exact page that is
  // complete-but-at-the-cap — the case an off-by-one turns into a false alarm
  // on every full page.
  test("is silent when nothing was dropped", () => {
    expect(truncationNotice("list", 12, 12)).toBeUndefined();
    expect(truncationNotice("list", 13, 12)).toBeUndefined();
    expect(truncationNotice("list", 12, 13)).toBeDefined();
  });
});

describe("list --json capped page", () => {
  test("warns, and the notice carries the true total", async () => {
    const s = sink();
    const out = await listCmd({ cfg, node: node(listCards), json: true, warn: s.warn });
    const rows = JSON.parse(out) as unknown[];

    expect(rows.length).toBe(LIST_KEPT);
    expect(s.lines.length).toBe(1);
    // The real total, not the page size — the whole point of the notice.
    expect(s.lines[0]).toContain(`${LIST_KEPT} of ${LIST_TOTAL}`);
    expect(s.lines[0]).toContain("--all");
  });

  // POSITIVE CONTROL. Without it, `warn: () => always` passes everything above.
  test("says NOTHING when the page is complete", async () => {
    const s = sink();
    const small = [card({ slug: "only", column: "todo" })];
    const out = await listCmd({ cfg, node: node(small), json: true, warn: s.warn });

    expect((JSON.parse(out) as unknown[]).length).toBe(1);
    expect(s.lines).toEqual([]);
  });

  // The compat guarantee this whole design was chosen to preserve.
  test("stdout stays a BARE ARRAY, not an envelope", async () => {
    const s = sink();
    const out = await listCmd({ cfg, node: node(listCards), json: true, warn: s.warn });
    const parsed = JSON.parse(out);

    expect(Array.isArray(parsed)).toBe(true);
    // `jq length` on an envelope silently returns the key count instead of
    // erroring — this is the assertion that catches that swap.
    expect((parsed as unknown[]).length).toBe(LIST_KEPT);
  });

  test("--all returns everything and does not warn", async () => {
    const s = sink();
    const out = await listCmd({ cfg, node: node(listCards), json: true, all: true, warn: s.warn });

    expect((JSON.parse(out) as unknown[]).length).toBe(LIST_TOTAL);
    expect(s.lines).toEqual([]);
  });

  test("an explicit --limit is the caller's own bound, so it is not a surprise", async () => {
    const s = sink();
    const out = await listCmd({ cfg, node: node(listCards), json: true, limit: 1, warn: s.warn });

    expect((JSON.parse(out) as unknown[]).length).toBe(2); // 1 per column, 2 columns
    expect(s.lines).toEqual([]);
  });

  // Regression guard for the live consumer found by the sweep: routine
  // `milestone-driver` runs `fkanban list --column <col> --json` and takes
  // `jq 'length'` off it. That path must stay complete AND stay a bare array.
  test("--column is uncapped, silent, and still a bare array", async () => {
    const s = sink();
    const out = await listCmd({ cfg, node: node(listCards), json: true, column: "todo", warn: s.warn });
    const parsed = JSON.parse(out);

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(OVER_CAP);
    expect(s.lines).toEqual([]);
  });

  // The notice belongs to the CLI rendering, not the shared data path — MCP
  // reports truncation structurally and must not also get a stderr line.
  test("the MCP data path does not emit it", async () => {
    const s = sink();
    const res = await listResult({ cfg, node: node(listCards), json: true, warn: s.warn });

    expect(res.cards.length).toBe(LIST_TOTAL);
    expect(s.lines).toEqual([]);
  });
});

describe("search --json capped page", () => {
  const hits = Array.from({ length: DEFAULT_SEARCH_LIMIT + 4 }, (_, i) =>
    card({ slug: `needle-${i}`, title: `needle ${i}`, column: "todo", position: `${300 + i}` }));

  test("warns with the true total, and stdout stays a bare array", async () => {
    const s = sink();
    const out = await searchCmd({ cfg, node: node(hits), query: "needle", json: true, warn: s.warn });
    const parsed = JSON.parse(out);

    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(DEFAULT_SEARCH_LIMIT);
    expect(s.lines.length).toBe(1);
    expect(s.lines[0]).toContain(`${DEFAULT_SEARCH_LIMIT} of ${hits.length}`);
  });

  test("says NOTHING when every match fits", async () => {
    const s = sink();
    const few = [card({ slug: "needle-only", title: "needle only", column: "todo" })];
    const out = await searchCmd({ cfg, node: node(few), query: "needle", json: true, warn: s.warn });

    expect((JSON.parse(out) as unknown[]).length).toBe(1);
    expect(s.lines).toEqual([]);
  });

  test("--all returns everything and does not warn", async () => {
    const s = sink();
    const out = await searchCmd({ cfg, node: node(hits), query: "needle", json: true, all: true, warn: s.warn });

    expect((JSON.parse(out) as unknown[]).length).toBe(hits.length);
    expect(s.lines).toEqual([]);
  });
});
