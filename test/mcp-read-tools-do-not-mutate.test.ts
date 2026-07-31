// Every tool in FKANBAN_READ_TOOLS is advertised to every connecting model as
// one that "never mutates", and each carries `readOnlyHint: true` — the MCP
// annotation a host uses to decide a tool is safe to run WITHOUT asking the
// user first.
//
// Until this file existed, that claim was only ever checked against ITSELF:
// `mcp.test.ts` asserts the declared read list equals the set of tools
// annotated read-only. Both sides can be wrong together, and were —
// `fkanban_milestone_reconcile` sat in the read list, annotated read-only,
// while issuing one MilestoneCards write per drifted row (seconds each on the
// shared primary) as a heal-on-read side effect. A consistency check between
// two declarations cannot catch a declaration that disagrees with the CODE.
//
// So this asserts the property against behaviour: drive each read tool over a
// real MCP client against a node that RECORDS writes, and require it wrote
// nothing.
import { describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createFkanbanMcpServer, FKANBAN_READ_TOOLS } from "../src/mcp/server.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, nowIso } from "../src/record.ts";
import { addCmd } from "../src/commands/add.ts";
import { milestoneAddCmd } from "../src/commands/milestone.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { fakeNode, type FakeNode } from "./fake-node.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    milestone: "milestonehash",
    board_cards: "boardcards-hash",
    board_milestones: "boardms-hash",
    milestone_cards: "mscards-hash",
  },
};

/**
 * Read tools this fixture cannot honestly exercise, and why. Excluded BY NAME
 * so that adding a read tool without deciding where it belongs fails the
 * coverage assertion below rather than silently skipping the new tool.
 */
const NOT_EXERCISED: Record<string, string> = {
  // Reads the node's search plane through `rawCall`, which this fixture does
  // not stand up. Its write behaviour is not in question — it issues none.
  fkanban_search: "needs the node search plane (rawCall)",
  // The ONE read tool that genuinely writes, on purpose: its liveness check
  // creates and deletes a throwaway row under a reserved probe slug to prove
  // the configured schema is writable at all (fkanban #94). It touches no user
  // data and leaves nothing behind. Whether a create+delete probe belongs
  // under `readOnlyHint: true` is a real question, but it is a different one
  // from a command that leaves rows changed, and it is not settled here.
  fkanban_doctor: "write-probes schemas by design (create+delete of a reserved probe slug)",
};

/** Args for each exercised read tool. Keys must cover exactly the rest. */
const READ_TOOL_ARGS: Record<string, Record<string, unknown>> = {
  fkanban_list: {},
  fkanban_show: { slug: "look-a" },
  fkanban_overlap: { slug: "look-a" },
  fkanban_pickup_status: {},
  fkanban_board_list: {},
  fkanban_milestone_list: {},
  fkanban_milestone_show: { slug: "ms-look" },
  fkanban_milestone_portfolio: {},
  fkanban_milestone_detail: { slug: "ms-look" },
  fkanban_milestone_groom: {},
  fkanban_ping: {},
};

async function connect(node: FakeNode): Promise<Client> {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "test", version: "0.0.0" });
  const server = createFkanbanMcpServer({ cfg, node });
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return client;
}

/**
 * A board carrying REAL index drift.
 *
 * The drift is the whole point: against a converged milestone the heal writes
 * nothing anyway, so "no writes" would hold equally for a tool that repairs and
 * one that does not, and the guard would prove nothing.
 *
 * The drift arrives for free here, and for an honest reason. MilestoneCards is
 * maintained by a node-side sibling fold off BoardCards, not by fkanban's write
 * path — and the shared fake does not model that fold. So every card added
 * below lands on the board with NO MilestoneCards row, which is exactly the
 * "missing from the index" state reconcile exists to repair. The test asserting
 * a write actually fires here is what keeps that claim honest.
 */
async function seedDriftedBoard(): Promise<FakeNode> {
  const node = fakeNode();
  const now = nowIso();
  await node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
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
  await milestoneAddCmd({
    cfg,
    node,
    slug: "ms-look",
    title: "Look outcome",
    state: "active",
    northStar: "ns-look",
    driver: "driver",
  });
  for (const slug of ["look-a", "look-b"]) {
    await addCmd({
      cfg,
      node,
      slug,
      title: `PR ${slug}`,
      milestone: "ms-look",
      northStar: "ns-look",
      repo: "EdgeVector/fkanban",
      base: "main",
      kind: "pr",
      column: "todo",
      body: `Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nWork ${slug}.\n\n## END STATE\nDone.\n`,
    });
  }
  return node;
}

describe("declared MCP read tools do not mutate", () => {
  test("the exercised set plus the excluded set is exactly FKANBAN_READ_TOOLS", () => {
    const covered = new Set([...Object.keys(READ_TOOL_ARGS), ...Object.keys(NOT_EXERCISED)]);
    expect(covered).toEqual(new Set(FKANBAN_READ_TOOLS));
  });

  // The fixture must be capable of provoking a write, or every assertion below
  // passes for free. `fkanban_milestone_reconcile` is the same heal-on-read
  // path the read tools share — now correctly declared a WRITE tool — so this
  // proves the drift is real and reachable through the MCP layer.
  test("the fixture provokes a write from the tool that is allowed to write", async () => {
    const node = await seedDriftedBoard();
    const client = await connect(node);
    node.writes.length = 0;

    const res = await client.callTool({ name: "fkanban_milestone_reconcile", arguments: { slug: "ms-look" } });

    expect(res.isError).toBeFalsy();
    const milestoneCardWrites = node.writes.filter((w) => w.schemaHash === cfg.schemaHashes.milestone_cards);
    expect(milestoneCardWrites.length).toBeGreaterThan(0);
  });

  for (const [tool, args] of Object.entries(READ_TOOL_ARGS)) {
    test(`${tool} issues no writes`, async () => {
      const node = await seedDriftedBoard();
      const client = await connect(node);
      node.writes.length = 0;

      const res = await client.callTool({ name: tool, arguments: args });

      // A tool that failed early would also have written nothing, which would
      // make the real assertion hollow — so require it actually ran.
      expect(res.isError).toBeFalsy();
      expect(node.writes).toEqual([]);
    });
  }

  // The specific regression: `detail` shares reconcile's snapshot path, so it
  // used to repair the index just by being asked to look at it.
  test("fkanban_milestone_detail reports the drift it declined to repair", async () => {
    const node = await seedDriftedBoard();
    const client = await connect(node);
    node.writes.length = 0;

    const res = await client.callTool({ name: "fkanban_milestone_detail", arguments: { slug: "ms-look" } });

    expect(node.writes).toEqual([]);
    const structured = res.structuredContent as { repairs: { applied: boolean; upserts: number; deferred: number }; children: Array<{ slug: string }> };
    expect(structured.repairs).toMatchObject({ applied: false, upserts: 2, issued: 0, deferred: 2 });
    // The answer is complete regardless: children come from Card truth, not
    // from the index rows the repair would have written.
    expect(structured.children.map((child) => child.slug).sort()).toEqual(["look-a", "look-b"]);
  });
});
