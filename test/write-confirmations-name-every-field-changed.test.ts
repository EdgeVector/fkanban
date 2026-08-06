// A write command's confirmation must name EVERY field the write changed —
// not just the one the verb is named after.
//
// This is the third family found by the head-line audit that runs (c)/(d)/(e)
// worked through. Those were about a NUMBER: sourced from a plan instead of a
// counter (c/d), or a CONCLUSION printed without consulting the classifier that
// existed to produce it (e). This one is about a FIELD: the write changed two
// things and the result type could only express one.
//
// Two sites, same shape:
//
// 1. `dep add` on a default/todo card ALSO demotes it to backlog — default/todo
//    is the pickup claim lane and a card with an unfinished dep is not
//    claimable there. The demote is deliberate and was already pinned
//    (test/add-update-board.test.ts asserts `column === "backlog"`), but the
//    test discards the command's RETURN value, `DepResult` had no field for a
//    column, and `formatDep` printed only the edge. So the operator (or agent)
//    who ran `dep add` was told the card now depends on something, and not that
//    it had just left the lane where work gets picked up.
//
// 2. `sanitizeDefaultTodoLaneMetadata` clears `branch`/`pr_url` on a requeue
//    into default/todo. Its OWN docstring makes reporting the caller's job —
//    "A clear that nobody reports is how `add --pr-url` spent months exiting 0
//    on a card whose `pr_url` stayed `\"\"`" — and it returns the field names for
//    exactly that purpose. `move` honoured it. `add` called it for effect and
//    threw the names away, on BOTH its create and its update path. The same
//    requeue, voiced under one verb and silent under the other.
//
// And the reason a fix to either could still miss the larger caller:
// `src/mcp/server.ts` imported nothing from `src/format.ts` and hand-built all
// thirteen write confirmations as template literals. Two had already drifted
// from the CLI (`move` dropped its `; promoted … to todo` suffix; `mark` said
// "marked X" where the CLI says "marked card X"). Duplicated prose means every
// future honesty fix lands for operators and silently misses agents.
//
// PREDICTED SPLIT, written before running: reverting the fix should fail 6 and
// pass 1. The survivor is the quiet gate — `dep add` on a card that was NOT in
// the pickup lane must read exactly as it always has.

import { readFileSync } from "node:fs";

import { beforeEach, describe, expect, test } from "bun:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { fakeNode } from "./fake-node.ts";
import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { depAddCmd } from "../src/commands/dep.ts";
import { formatDep, formatMark, formatMove } from "../src/format.ts";
import { createFkanbanMcpServer } from "../src/mcp/server.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

const validPickupBody =
  "Repo: EdgeVector/fkanban\nBase: main\n\n## GOAL\nFixture work.\n\n## END STATE\nFixture complete.";

function seedBoard(node: NodeClient, slug: string, columns: string[]) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({ slug, title: slug, body: "", columns, created_at: now, updated_at: now }),
  });
}

/** Capture stderr warnings for the duration of one action. */
async function captureWarnings<T>(fn: () => T | Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    return { result: await fn(), warnings };
  } finally {
    console.error = original;
  }
}

describe("dep add names the demote it performs", () => {
  let node: NodeClient;

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
    await addCmd({ cfg, node, slug: "blocker", title: "Blocker", column: "todo", body: validPickupBody });
  });

  test("(1) the result reports the column change, not only the edge", async () => {
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", column: "todo", body: validPickupBody });

    const res = await depAddCmd({ cfg, node, slug: "dependent", dep: "blocker" });

    // The card really did move — this is the state the confirmation must describe.
    expect((await findCard(node, cfg, "dependent"))?.column).toBe("backlog");
    expect(res.demoted).toEqual({ from: "todo", to: "backlog" });
  });

  test("(2) the human line names the lane the card just left", async () => {
    await addCmd({ cfg, node, slug: "dependent", title: "Dependent", column: "todo", body: validPickupBody });

    const line = formatDep(await depAddCmd({ cfg, node, slug: "dependent", dep: "blocker" }));

    // The edge is still the headline; the demote must not be a separate line
    // the reader can skip, because the conclusion line is the one that is read.
    expect(line).toContain("dependent now depends on blocker");
    expect(line).toContain("todo → backlog");
    expect(line).toContain("pickup claim lane");
  });

  test("(3) a card that was NOT in the pickup lane reads exactly as before", async () => {
    // The quiet gate. `dep add` on a backlog card changes one field, and its
    // confirmation must not grow a clause about a move that did not happen.
    await addCmd({ cfg, node, slug: "quiet", title: "Quiet", column: "backlog", body: validPickupBody });

    const res = await depAddCmd({ cfg, node, slug: "quiet", dep: "blocker" });

    expect(res.demoted).toBeUndefined();
    expect(formatDep(res)).toBe("quiet now depends on blocker (deps: blocker)");
  });
});

describe("a requeue into default/todo voices its lane clear under every verb", () => {
  let node: NodeClient;

  // A card mid-flight: in `doing`, carrying the branch and PR link that
  // default/todo will not keep.
  async function seedInFlight(slug: string): Promise<void> {
    await addCmd({ cfg, node, slug, title: slug, column: "todo", body: validPickupBody });
    await moveCmd({ cfg, node, slug, column: "doing" });
    await addCmd({ cfg, node, slug, branch: `kanban/${slug}`, prUrl: `https://example.invalid/pr/${slug}` });
  }

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("(4) `add` requeueing a card to todo says which fields it dropped", async () => {
    await seedInFlight("requeued-by-add");

    const { warnings } = await captureWarnings(() =>
      addCmd({ cfg, node, slug: "requeued-by-add", column: "todo", force: true }),
    );

    // The clear happened either way — the defect was never the write.
    const after = await findCard(node, cfg, "requeued-by-add");
    expect(after?.pr_url).toBe("");
    expect(after?.branch).toBe("");

    const cleared = warnings.filter((w) => w.includes("cleared"));
    expect(cleared).toHaveLength(1);
    expect(cleared[0]).toContain("branch and pr_url");
    expect(cleared[0]).toContain("https://example.invalid/pr/requeued-by-add");
  });

  test("(5) `move` and `add` describe the identical requeue identically", async () => {
    await seedInFlight("requeued-by-move");
    await seedInFlight("requeued-by-add-2");

    const moved = await captureWarnings(() =>
      moveCmd({ cfg, node, slug: "requeued-by-move", column: "todo", force: true }),
    );
    const added = await captureWarnings(() =>
      addCmd({ cfg, node, slug: "requeued-by-add-2", column: "todo", force: true }),
    );

    const only = (ws: string[]) => {
      const c = ws.filter((w) => w.includes("cleared"));
      expect(c).toHaveLength(1);
      return c[0]!;
    };
    // Same sentence, differing only in the slug and its PR URL. Two wordings
    // for one event is how the pair drifted apart in the first place.
    expect(only(moved.warnings).replaceAll("requeued-by-move", "SLUG"))
      .toBe(only(added.warnings).replaceAll("requeued-by-add-2", "SLUG"));
  });
});

describe("MCP write tools render through the CLI formatters", () => {
  let node: NodeClient;

  async function connected(): Promise<Client> {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "test", version: "0.0.0" });
    const server = createFkanbanMcpServer({ cfg, node });
    await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
    return client;
  }

  const textOf = (res: unknown): string =>
    ((res as { content: Array<{ type: string; text: string }> }).content[0]?.text) ?? "";

  beforeEach(async () => {
    node = fakeNode();
    await seedBoard(node, "default", [...DEFAULT_COLUMNS]);
  });

  test("(6) `fkanban_move` carries the dependent-promotion suffix the CLI has always printed", async () => {
    // Moving a blocker to done promotes its unblocked backlog dependents. The
    // CLI said so; the MCP text dropped the whole clause, so an agent that just
    // unblocked three cards was told only that one card moved.
    await addCmd({ cfg, node, slug: "blocker", title: "Blocker", column: "todo", body: validPickupBody });
    await addCmd({
      cfg, node, slug: "waiter", title: "Waiter", column: "backlog",
      body: validPickupBody, kind: "pr", deps: ["blocker"],
    });
    await moveCmd({ cfg, node, slug: "blocker", column: "doing" });

    const client = await connected();
    const res = await client.callTool({ name: "fkanban_move", arguments: { slug: "blocker", column: "done" } });

    expect((await findCard(node, cfg, "waiter"))?.column).toBe("todo");
    expect(textOf(res)).toContain("promoted waiter to todo");
    expect(textOf(res)).toBe(formatMove({ slug: "blocker", from: "doing", to: "done", promotedDependents: ["waiter"] }));
  });

  test("(7) `fkanban_mark` says what the CLI says", async () => {
    await addCmd({ cfg, node, slug: "notes", title: "Notes", column: "backlog", body: validPickupBody });

    const client = await connected();
    const res = await client.callTool({ name: "fkanban_mark", arguments: { slug: "notes", line: "PROGRESS: one" } });

    expect(textOf(res)).toBe(formatMark({ slug: "notes", action: "updated", board: "default", column: "backlog" }));
  });

  test("(8) no write tool hand-builds its own confirmation string", async () => {
    // The reach check. Tests (6) and (7) prove two tools were fixed; this one
    // is what stops a THIRD from being written with a fresh template literal —
    // the way both of those drifted, one line at a time, without any test
    // noticing that the CLI and the MCP surface had stopped agreeing.
    //
    // Scoped to `toolResult` calls whose text argument is a template literal.
    // The milestone pair is exempt by construction: `milestone add`/`milestone
    // state` have no CLI formatter to share, so there is no second copy of
    // their prose to drift from.
    const src = readFileSync(new URL("../src/mcp/server.ts", import.meta.url), "utf8");
    const handRolled = src
      .split("\n")
      .map((line, i) => ({ line: line.trim(), n: i + 1 }))
      .filter(({ line }) => line.startsWith("return toolResult(`"))
      .filter(({ line }) => !line.includes("milestone"));

    expect(handRolled.map(({ line, n }) => `${n}: ${line}`)).toEqual([]);
  });
});
