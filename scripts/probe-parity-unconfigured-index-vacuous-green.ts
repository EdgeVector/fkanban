// PROBE: can `groom parity-check` report GREEN while having checked nothing?
//
// Context: `parity-check` is the read-only detector for a row silently dropped
// from every product read, and the open papercut on it is that NOTHING RUNS IT.
// Before staffing it into a routine, the question that decides whether staffing
// helps is whether its green means "I looked and found nothing" or can also
// mean "I did not look".
//
// PREDICTIONS RECORDED BEFORE RUNNING:
//   H1  cfg WITHOUT board_cards  -> ok:true, partitions_checked:0, rows_checked:0.
//       `sweepBoardCardsPartition` returns null on an unresolvable schema hash,
//       and `parity_check` does `if (sweep === null) continue` without pushing
//       a result — so the partition leaves no trace in the report.
//   H2  cfg WITH board_cards, WITHOUT milestone_cards -> milestone partitions
//       silently absent; ok:true; nothing in `incomplete` names the index that
//       was never checked.
//   H3  `ok` drives the exit code, so a routine gating on it sees success.
//
// Run: bun run scripts/probe-parity-unconfigured-index-vacuous-green.ts

import { fakeNode, type FakeNode } from "../test/fake-node.ts";
import type { Config } from "../src/config.ts";
import { parityCheckResult } from "../src/commands/parity_check.ts";
import { boardCardSk } from "../src/board-cards.ts";

const BOARD = "default";

function base(schemaHashes: Record<string, string>): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    schemaServiceUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes,
  } as Config;
}

function board(): FakeNode {
  const node = fakeNode({
    projectionRule: "hash_else_lead",
    hashFields: { bchash: "board", boardhash: "slug", mchash: "milestone" },
  });
  node.seed({
    schemaHash: "boardhash",
    keyHash: BOARD,
    rangeKey: null,
    fields: {
      slug: BOARD,
      title: "Default",
      body: "",
      columns: "backlog,todo,doing,done",
      created_at: "2026-01-01T00:00:00.000Z",
      updated_at: "2026-01-01T00:00:00.000Z",
    },
  });
  return node;
}

function seedCard(node: FakeNode, sk: string, slug: string, fields: Record<string, unknown> = {}) {
  node.seed({
    schemaHash: "bchash",
    keyHash: BOARD,
    rangeKey: sk,
    fields: { board: BOARD, sk, slug, title: slug, column: "todo", position: "1", ...fields },
  });
}

type Report = Awaited<ReturnType<typeof parityCheckResult>>;

function summarize(label: string, r: Report) {
  console.log(
    `${label.padEnd(46)} ok=${String(r.ok).padEnd(5)} partitions=${String(r.partitions_checked).padStart(3)} ` +
      `rows=${String(r.rows_checked).padStart(4)} drift=${r.drift.length} incomplete=${r.incomplete.length} ` +
      `unconfirmed=${r.unconfirmed.length}`,
  );
}

// ---- ARM 1: board_cards absent entirely -----------------------------------
{
  const node = board();
  seedCard(node, boardCardSk("todo", "1", "stays"), "stays");
  seedCard(node, boardCardSk("todo", "2", "leaves"), "leaves");
  const r = await parityCheckResult({ cfg: base({ card: "cardhash", board: "boardhash" }), node });
  summarize("A1  no board_cards hash at all", r);
  console.log(
    `      VERDICT: ${
      r.ok && r.partitions_checked === 0
        ? "VACUOUS GREEN — two seeded rows, nothing checked, exit would be 0"
        : "reported something"
    }`,
  );
}

// ---- ARM 2: board_cards present, milestone_cards absent --------------------
{
  const node = board();
  seedCard(node, boardCardSk("todo", "1", "stays"), "stays", { milestone: "m1" });
  seedCard(node, boardCardSk("todo", "2", "leaves"), "leaves", { milestone: "m1" });
  const r = await parityCheckResult({
    cfg: base({ card: "cardhash", board: "boardhash", board_cards: "bchash" }),
    node,
  });
  summarize("A2  board_cards only, milestone_cards absent", r);
  const named = [...new Set([...r.drift, ...r.incomplete, ...r.churn, ...r.unconfirmed].map((x) => x.index))];
  console.log(`      indexes named anywhere in the report: ${JSON.stringify(named)}`);
}

// ---- ARM 3: the control — board_cards configured, clean board --------------
{
  const node = board();
  seedCard(node, boardCardSk("todo", "1", "stays"), "stays");
  const r = await parityCheckResult({
    cfg: base({ card: "cardhash", board: "boardhash", board_cards: "bchash" }),
    node,
  });
  summarize("A3  control, one clean card", r);
}
