/**
 * `pickup claim` (v1) must never report a claim it did not take ownership of.
 *
 * The defect these tests pin, measured 2026-09-07T08:56Z on the live board:
 * `kanban pickup claim --worker w3` returned `{"claimed":true}` for a card that
 * `pickup explain` classified `collision - card is already in doing`, and
 * `show` still attributed to worker `w2` afterwards. Two independent holes fed
 * it — a requeue to default/todo leaves `assignee` set, and `planDoingClaim`
 * used to keep that stale name over the claiming worker.
 *
 * Written against the observable (what `show` reports after the claim), not
 * against the internal path that produced it.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { pickupExplainResult } from "../src/commands/pickup_explain.ts";
import { showResult } from "../src/commands/show.ts";
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
  schemaHashes: {
    card: CARD_HASH,
    board: BOARD_HASH,
    board_cards: BOARD_CARDS_HASH,
  },
};

const body =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nClaim one card.\n\n## END STATE\nOne worker owns it.";

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

async function seedCard(node: FakeNode, slug: string): Promise<void> {
  await addCmd({ cfg, node, slug, title: slug, column: "todo", body });
}

describe("pickup claim ownership", () => {
  let node: FakeNode;

  beforeEach(async () => {
    node = fakeNode({ hashFields: { [BOARD_CARDS_HASH]: "board" } });
    await seedBoard(node);
  });

  test("a second worker cannot claim a card the first worker already owns", async () => {
    await seedCard(node, "claim-me");

    const first = await pickupClaimResult({ cfg, node, worker: "worker-a" });
    expect(first.claimed).toBe(true);
    expect(first.card?.slug).toBe("claim-me");
    expect(first.card?.assignee).toBe("worker-a");

    const second = await pickupClaimResult({ cfg, node, worker: "worker-b" });
    expect(second.claimed).toBe(false);
    expect(second.card).toBeUndefined();

    const shown = await showResult({ cfg, node, slug: "claim-me" });
    expect(shown.card.column).toBe("doing");
    expect(shown.card.assignee).toBe("worker-a");
  });

  test("a claim reported as won is a claim `show` attributes to that worker", async () => {
    await seedCard(node, "claim-me");
    const before = nowIso();

    const claim = await pickupClaimResult({ cfg, node, worker: "worker-a" });
    expect(claim.claimed).toBe(true);

    const shown = await showResult({ cfg, node, slug: "claim-me" });
    expect(shown.card.assignee).toBe(claim.worker ?? "");
    expect(shown.card.column).toBe("doing");
    expect(shown.card.updated_at >= before).toBe(true);
  });

  test("a todo card wearing an orphaned worker's name is claimed BY the new worker", async () => {
    // The live shape: worker-a claimed the card, was orphaned, and a sweep
    // requeued it. `sanitizeDefaultTodoLaneMetadata` clears branch and pr_url
    // on that requeue; it does not clear `assignee`.
    await seedCard(node, "orphaned-card");
    await pickupClaimResult({ cfg, node, worker: "worker-a" });
    await moveCmd({ cfg, node, slug: "orphaned-card", column: "todo" });

    const requeued = await showResult({ cfg, node, slug: "orphaned-card" });
    expect(requeued.card.column).toBe("todo");

    const reclaim = await pickupClaimResult({ cfg, node, worker: "worker-b" });
    expect(reclaim.claimed).toBe(true);
    expect(reclaim.card?.slug).toBe("orphaned-card");
    expect(reclaim.card?.assignee).toBe("worker-b");

    const shown = await showResult({ cfg, node, slug: "orphaned-card" });
    expect(shown.card.assignee).toBe("worker-b");
  });

  test("claim and explain agree on eligible_for_claim for the same slug", async () => {
    // The reported envelope was a disagreement: `explain` said
    // `collision - card is already in doing` / `eligible_for_claim: NO`, and
    // `claim` returned that same slug as won. They must answer alike.
    await seedCard(node, "card-one");
    await seedCard(node, "card-two");
    const owned = await pickupClaimResult({ cfg, node, worker: "worker-a" });
    const claimedSlug = owned.card!.slug;

    const explained = await pickupExplainResult({ cfg, node, slug: claimedSlug });
    expect(explained.category).toBe("collision");
    expect(explained.eligible_for_claim).toBe(false);

    const next = await pickupClaimResult({ cfg, node, worker: "worker-b" });
    expect(next.card?.slug).not.toBe(claimedSlug);

    const stillOwned = await showResult({ cfg, node, slug: claimedSlug });
    expect(stillOwned.card.assignee).toBe("worker-a");
    expect(stillOwned.card.column).toBe("doing");
  });
});
