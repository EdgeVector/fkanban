/**
 * `show` must join claim placement from BoardCards with the full Card body.
 * The join is one keyed doing-column read. It does not poll or sleep.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { addCmd } from "../src/commands/add.ts";
import { claimCard } from "../src/commands/move.ts";
import { pickupClaimResult } from "../src/commands/pickup_claim.ts";
import { showResult } from "../src/commands/show.ts";
import { type QueryResponse } from "../src/client.ts";
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
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nClaim one card.\n\n## END STATE\nShow reports the claim.";

async function seed(node: FakeNode): Promise<void> {
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
  await addCmd({
    cfg,
    node,
    slug: "claim-me",
    title: "Claim me",
    column: "todo",
    body,
  });
}

function projected(
  fields: Record<string, unknown>,
  names: readonly string[],
): Record<string, unknown> {
  return Object.fromEntries(names.filter((name) => name in fields).map((name) => [name, fields[name]]));
}

describe("pickup claim / show coherence", () => {
  let node: FakeNode;

  beforeEach(async () => {
    node = fakeNode({ hashFields: { [BOARD_CARDS_HASH]: "board" } });
    await seed(node);
  });

  test("an immediate show returns the claim while the Card point read is stale", async () => {
    const stale = { ...node.rowAt(CARD_HASH, "claim-me")!.fields };
    const queryAll = node.queryAll.bind(node);
    const updateRecord = node.updateRecord.bind(node);
    let lagCardRead = false;
    let staleCardReads = 0;

    node.updateRecord = async (args) => {
      await updateRecord(args);
      if (args.schemaHash === CARD_HASH && args.fields.column === "doing") lagCardRead = true;
    };
    node.queryAll = async (args): Promise<QueryResponse> => {
      if (lagCardRead && args.schemaHash === CARD_HASH && args.filter?.HashKey === "claim-me") {
        staleCardReads += 1;
        return {
          ok: true,
          results: [{
            fields: projected(stale, args.fields),
            key: { hash: "claim-me", range: null },
          }],
          returned_count: 1,
          total_count: 1,
        };
      }
      return queryAll(args);
    };

    const claim = await pickupClaimResult({ cfg, node, worker: "worker-a" });
    node.reads.length = 0;
    const shown = await showResult({ cfg, node, slug: "claim-me" });

    expect(claim.claimed).toBe(true);
    expect(claim.card?.column).toBe("doing");
    expect(claim.card?.assignee).toBe("worker-a");
    expect(shown.card.column).toBe("doing");
    expect(shown.card.assignee).toBe("worker-a");
    expect(shown.card.body).toBe(body);
    expect(staleCardReads).toBe(1);
    expect(node.reads.filter((read) => read.schemaHash === BOARD_CARDS_HASH)).toHaveLength(1);
    expect(node.reads.find((read) => read.schemaHash === BOARD_CARDS_HASH)?.filter as unknown).toEqual({
      HashRangePrefix: { hash: "default", prefix: "doing#" },
    });
  });

  test("a legitimate todo card stays todo when no doing projection exists", async () => {
    node.reads.length = 0;
    const shown = await showResult({ cfg, node, slug: "claim-me" });

    expect(shown.card.column).toBe("todo");
    expect(shown.card.assignee).toBe("");
    expect(node.reads.filter((read) => read.schemaHash === BOARD_CARDS_HASH)).toHaveLength(1);
  });

  test("a current owned doing Card needs no projection join", async () => {
    await claimCard({ cfg, node, slug: "claim-me", worker: "worker-a" });
    node.reads.length = 0;
    const shown = await showResult({ cfg, node, slug: "claim-me" });

    expect(shown.card.column).toBe("doing");
    expect(shown.card.assignee).toBe("worker-a");
    expect(node.reads.some((read) => read.schemaHash === BOARD_CARDS_HASH)).toBe(false);
  });

  test("an older doing projection does not override a later todo reopen", async () => {
    await claimCard({ cfg, node, slug: "claim-me", worker: "worker-a" });
    await node.updateRecord({
      schemaHash: CARD_HASH,
      keyHash: "claim-me",
      fields: {
        column: "todo",
        assignee: "",
        updated_at: "2099-01-01T00:00:00.000Z",
      },
    });

    const shown = await showResult({ cfg, node, slug: "claim-me" });

    expect(shown.card.column).toBe("todo");
    expect(shown.card.assignee).toBe("");
  });
});
