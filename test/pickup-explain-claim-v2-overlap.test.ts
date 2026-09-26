/**
 * `pickup explain` must apply claim-v2's overlap rule, not only the advisory
 * surface verdict.
 *
 * Measured 2026-09-26T11:05Z on the live board: explain reported
 * `eligible_for_claim: YES` and "Pick this card up next" for
 * cloud-sync-resume-evidence-provenance-20260924, with the surface gate UNK
 * ("declares no surfaces; nothing was compared"). claim-v2 read the same empty
 * list as "**", skipped the card for a doing card in the same repo, and every
 * pickup worker logged `no_card_claimed reason=none` for about 40 minutes.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { pickupExplainResult, renderPickupExplain } from "../src/commands/pickup_explain.ts";
import { type Config } from "../src/config.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const CARD_HASH = "card-hash";
const BOARD_HASH = "board-hash";
const BOARD_CARDS_HASH = "board-cards-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD_HASH, board: BOARD_HASH, board_cards: BOARD_CARDS_HASH },
};

const body =
  "Repo: EdgeVector/last-stack\nBase: main\nKind: pr\n\n## GOAL\nShip it.\n\n## END STATE\nMerged.";

async function seedBoard(node: FakeNode): Promise<void> {
  const now = nowIso();
  await node.createRecord({
    schemaHash: BOARD_HASH,
    keyHash: "default",
    fields: boardToFields({
      slug: "default",
      title: "Default",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

async function seed(node: FakeNode, slug: string, surfaces?: string[]): Promise<void> {
  await addCmd({ cfg, node, slug, title: slug, column: "todo", body, surfaces });
}

describe("pickup explain agrees with claim-v2 on overlap", () => {
  let node: FakeNode;

  beforeEach(async () => {
    node = fakeNode({ hashFields: { [BOARD_CARDS_HASH]: "board" } });
    await seedBoard(node);
  });

  test("a card with no Surfaces is not eligible while a same-repo card is in doing", async () => {
    await seed(node, "running");
    await seed(node, "waiting");
    await moveCmd({ cfg, node, slug: "running", column: "doing" });

    const report = await pickupExplainResult({ cfg, node, slug: "waiting" });

    expect(report.surface_overlap.claim_v2_blocked_by).toBe("running");
    expect(report.surface_overlap.would_skip).toBe(true);
    expect(report.eligible_for_claim).toBe(false);
    const gate = report.gates.find((g) => g.name.startsWith("claim-v2 overlap"));
    expect(gate?.ok).toBe(false);
    expect(gate?.note).toContain("declares no Surfaces");
    expect(renderPickupExplain(report)).toContain("surface-overlap skip: running");
  });

  test("disjoint Surfaces in the same repo leave the card eligible", async () => {
    await seed(node, "running", ["src/a.ts"]);
    await seed(node, "waiting", ["docs/b.md"]);
    await moveCmd({ cfg, node, slug: "running", column: "doing" });

    const report = await pickupExplainResult({ cfg, node, slug: "waiting" });

    expect(report.surface_overlap.claim_v2_blocked_by).toBeNull();
    const gate = report.gates.find((g) => g.name.startsWith("claim-v2 overlap"));
    expect(gate?.ok).toBe(true);
  });
});
