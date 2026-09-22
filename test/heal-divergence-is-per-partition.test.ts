// papercut-board-cards-heal-inconsistent-partition-read-20260921
//
// One board (`agent-dogfood-scratch` on the live node) served two column-only
// rows for days. Heal refused EVERY write on EVERY board because of it, so the
// `default` board's orphans were never reaped. The refusal is now per
// partition: the diverged board gets no writes, the others are repaired.

import { describe, expect, test } from "bun:test";

import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import type { QueryFilter } from "../src/client.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash", board_cards: "boardcardshash" },
};

function card(slug: string, board: string, position: string, title = slug): Card {
  const now = nowIso();
  return {
    slug, title, body: "", board, column: "todo", position, assignee: "", tags: [], deps: [],
    surfaces: [], created_at: now, updated_at: now, done_at: "", first_doing_at: "", db: "",
    kind: "pr", priority: "", block_status: "none", block_reason: "", north_star: "",
    milestone: "", repo: "EdgeVector/fkanban", base: "main", pr_url: "", branch: "",
    created_by: "test",
  } as Card;
}

function twoBoards() {
  const node = fakeNode();
  const now = nowIso();
  for (const b of ["default", "scratch"]) {
    node.seed({
      schemaHash: "boardhash",
      keyHash: b,
      fields: boardToFields({ slug: b, title: b, body: "", columns: [...DEFAULT_COLUMNS], created_at: now, updated_at: now }),
    });
  }
  // default: one orphan row (no Card truth).
  const orphan = card("orphan-1", "default", "p1", "");
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: "default",
    rangeKey: boardCardSk(orphan.column, orphan.position, orphan.slug),
    fields: boardCardFieldsFromCard(orphan),
  });
  // scratch: two live cards.
  for (let i = 0; i < 2; i += 1) {
    const c = card(`live-${i}`, "scratch", `p${i}`);
    node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
    node.seed({
      schemaHash: "boardcardshash",
      keyHash: "scratch",
      rangeKey: boardCardSk(c.column, c.position, c.slug),
      fields: boardCardFieldsFromCard(c),
    });
  }
  // scratch's whole-partition read comes back short; its column reads do not.
  const real = node.queryAll.bind(node);
  node.queryAll = async (req) => {
    const res = await real(req);
    const f = req.filter as Record<string, unknown> | undefined as QueryFilter | undefined;
    if (req.schemaHash === "boardcardshash" && (f as Record<string, unknown> | undefined)?.HashKey === "scratch") {
      return { ...res, results: res.results.slice(0, 0) };
    }
    return res;
  };
  return node;
}

describe("board-cards-heal read-divergence refusal is per partition", () => {
  test("a diverged board does not block repairs on a healthy board", async () => {
    const node = twoBoards();
    const { report, text } = await boardCardsHealResult({ cfg, node, json: false, apply: true });

    expect(report.blocked).toBe(false);
    expect(report.healed).toBe(1);
    expect(text).toContain("PARTITION SKIPPED");
    const remaining = node.rowsOf("boardcardshash").map((r) => r.keyHash);
    expect(remaining.filter((b) => b === "default")).toHaveLength(0);
    expect(remaining.filter((b) => b === "scratch")).toHaveLength(2);
  });

  test("a scoped run on the diverged board still blocks", async () => {
    const node = twoBoards();
    const { report } = await boardCardsHealResult({ cfg, node, board: "scratch", json: true, apply: true });
    expect(report.blocked).toBe(true);
  });
});
