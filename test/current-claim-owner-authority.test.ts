import { describe, expect, test } from "bun:test";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { type Config } from "../src/config.ts";
import { showResult } from "../src/commands/show.ts";
import { cardToFields, rowToCard } from "../src/record.ts";
import { fakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "synthetic-owner-review",
  schemaHashes: { card: "card", board_cards: "board-cards" },
};

describe("canonical recovery owner reads", () => {
  for (const owner of ["loom:foreign", ""]) {
    test(`an equal-time stale doing projection cannot restore the old owner over ${owner || "a release"}`, async () => {
      const timestamp = "2026-09-25T00:00:00.123Z";
      const card = rowToCard({
        key: { hash: "recovery-owner", range: null },
        fields: {
          slug: "recovery-owner", title: "Owner authority", board: "default",
          column: "todo", position: "200", assignee: owner,
          body: "PROGRESS: loom land-card exec=foreign-exec claimed",
          tags: [], deps: [], surfaces: [], created_at: timestamp, updated_at: timestamp,
        },
      });
      const staleClaim = { ...card, column: "doing", position: "100", assignee: "loom:original" };
      const node = fakeNode({ hashFields: { card: "slug", "board-cards": "board" } });
      node.seed({ schemaHash: "card", keyHash: card.slug, fields: cardToFields(card) });
      node.seed({
        schemaHash: "board-cards", keyHash: "default",
        rangeKey: boardCardSk(staleClaim.column, staleClaim.position, staleClaim.slug),
        fields: boardCardFieldsFromCard(staleClaim),
      });

      const result = await showResult({ node, cfg, slug: card.slug, canonical: true });

      expect(result.card.assignee).toBe(owner);
      expect(result.card.column).toBe("todo");
      expect(result.card.body).toBe(card.body);
      expect(result.card.assignee).not.toBe("loom:original");
      expect(node.writes).toHaveLength(0);
      expect(node.reads.filter(read => read.schemaHash === "board-cards")).toHaveLength(0);

      // The ordinary compatibility view remains a separate contract. Equal
      // timestamps let it prefer the old projection; recovery must not use it.
      const ordinary = await showResult({ node, cfg, slug: card.slug });
      expect(ordinary.card.assignee).toBe("loom:original");
      expect(ordinary.card.column).toBe("doing");
    });
  }
});
