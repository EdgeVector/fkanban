#!/usr/bin/env bun
/**
 * Spike: Dynamo-style board partition for fkanban (no live node required).
 *
 * Question: is HashRange(hash=board, range=column#pos#slug) enough, or do we
 * also need a separate column partition table?
 *
 * Run:  bun scripts/spike-board-partition.ts
 * Exit 0 = access math holds (list/move/show without scan or board-wide N+1).
 */

// ---------------------------------------------------------------------------
// Key design under test
// ---------------------------------------------------------------------------

type Column = "backlog" | "todo" | "doing" | "done";

type ThinCard = {
  slug: string;
  title: string;
  board: string;
  column: Column;
  position: number;
  kind: string;
  deps: string[];
  // NO body here — body is a separate point-get
};

type BodyRow = { slug: string; body: string };

/** BoardCards HashRange: pk = board, sk = column#pos#slug */
function sk(column: Column, position: number, slug: string): string {
  return `${column}#${String(position).padStart(8, "0")}#${slug}`;
}

function parseSk(range: string): { column: Column; position: number; slug: string } {
  const [column, pos, ...rest] = range.split("#");
  return {
    column: column as Column,
    position: Number(pos),
    slug: rest.join("#"),
  };
}

// ---------------------------------------------------------------------------
// In-memory "LastDB" that only supports Hash / HashRange / HashKey partition
// ---------------------------------------------------------------------------

class FakeNode {
  queries = 0;
  mutations = 0;
  /** schema -> hashKey -> rangeKey -> fields  (rangeKey "" for Hash) */
  tables = new Map<string, Map<string, Map<string, Record<string, unknown>>>>();

  private table(schema: string) {
    let t = this.tables.get(schema);
    if (!t) {
      t = new Map();
      this.tables.set(schema, t);
    }
    return t;
  }

  putHash(schema: string, key: string, fields: Record<string, unknown>) {
    this.mutations++;
    const t = this.table(schema);
    let p = t.get(key);
    if (!p) {
      p = new Map();
      t.set(key, p);
    }
    p.set("", { ...fields });
  }

  getHash(schema: string, key: string): Record<string, unknown> | null {
    this.queries++;
    return this.table(schema).get(key)?.get("") ?? null;
  }

  putHashRange(
    schema: string,
    hash: string,
    range: string,
    fields: Record<string, unknown>,
  ) {
    this.mutations++;
    const t = this.table(schema);
    let p = t.get(hash);
    if (!p) {
      p = new Map();
      t.set(hash, p);
    }
    p.set(range, { ...fields });
  }

  deleteHashRange(schema: string, hash: string, range: string) {
    this.mutations++;
    this.table(schema).get(hash)?.delete(range);
  }

  /** Partition query: all ranges under one hash (LastDB filter: { HashKey: board }) */
  queryPartition(schema: string, hash: string): Array<{ range: string; fields: Record<string, unknown> }> {
    this.queries++;
    const p = this.table(schema).get(hash);
    if (!p) return [];
    return [...p.entries()]
      .filter(([r]) => r !== "")
      .map(([range, fields]) => ({ range, fields }))
      .sort((a, b) => a.range.localeCompare(b.range));
  }

  /** Column slice: partition query + sk prefix (client or range-prefix filter) */
  queryColumn(
    schema: string,
    hash: string,
    column: Column,
  ): Array<{ range: string; fields: Record<string, unknown> }> {
    // Still ONE partition query if we pull the board and filter prefix client-side;
    // with HashRangePrefix it can be one server-side range-bounded query (same cost class).
    return this.queryPartition(schema, hash).filter((row) => row.range.startsWith(`${column}#`));
  }

  resetCounters() {
    this.queries = 0;
    this.mutations = 0;
  }
}

// ---------------------------------------------------------------------------
// Kanban API on top of FakeNode
// ---------------------------------------------------------------------------

const BOARD_CARDS = "BoardCards";
const CARD_BODY = "CardBody";
const BOARD = "Board";

function thinFromFields(f: Record<string, unknown>): ThinCard {
  return {
    slug: String(f.slug),
    title: String(f.title),
    board: String(f.board),
    column: f.column as Column,
    position: Number(f.position),
    kind: String(f.kind ?? "pr"),
    deps: Array.isArray(f.deps) ? (f.deps as string[]) : [],
  };
}

class Kanban {
  constructor(private node: FakeNode) {}

  ensureBoard(slug: string) {
    this.node.putHash(BOARD, slug, {
      slug,
      title: slug,
      columns: ["backlog", "todo", "doing", "done"],
    });
  }

  addCard(card: ThinCard, body: string) {
    const range = sk(card.column, card.position, card.slug);
    this.node.putHashRange(BOARD_CARDS, card.board, range, { ...card });
    this.node.putHash(CARD_BODY, card.slug, { slug: card.slug, body });
  }

  /** List whole board: ONE partition query. No body. */
  listBoard(board: string): ThinCard[] {
    return this.node.queryPartition(BOARD_CARDS, board).map((r) => thinFromFields(r.fields));
  }

  /** List one column: ONE partition query + prefix filter (or prefix server-side). */
  listColumn(board: string, column: Column): ThinCard[] {
    return this.node.queryColumn(BOARD_CARDS, board, column).map((r) => thinFromFields(r.fields));
  }

  /**
   * Move on same board: delete old sk, put new sk.
   * Cards almost never change board — column/position only.
   */
  move(board: string, slug: string, toColumn: Column, toPosition: number) {
    const all = this.node.queryPartition(BOARD_CARDS, board);
    const hit = all.find((r) => thinFromFields(r.fields).slug === slug);
    if (!hit) throw new Error(`card ${slug} not on board ${board}`);
    const prev = thinFromFields(hit.fields);
    this.node.deleteHashRange(BOARD_CARDS, board, hit.range);
    const next: ThinCard = { ...prev, column: toColumn, position: toPosition };
    this.node.putHashRange(BOARD_CARDS, board, sk(toColumn, toPosition, slug), { ...next });
    return next;
  }

  /** Show: thin row may already be known; body is a separate point get. */
  showBody(slug: string): BodyRow | null {
    const row = this.node.getHash(CARD_BODY, slug);
    if (!row) return null;
    return { slug: String(row.slug), body: String(row.body) };
  }
}

// ---------------------------------------------------------------------------
// Spike scenarios
// ---------------------------------------------------------------------------

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(`ASSERT: ${msg}`);
}

function seed(k: Kanban, board: string, n: number) {
  k.ensureBoard(board);
  const cols: Column[] = ["backlog", "todo", "doing", "done"];
  for (let i = 0; i < n; i++) {
    const column = cols[i % 4]!;
    k.addCard(
      {
        slug: `card-${i}`,
        title: `Card ${i}`,
        board,
        column,
        position: i,
        kind: "pr",
        deps: i > 0 && i % 7 === 0 ? [`card-${i - 1}`] : [],
      },
      `# Spec for card ${i}\n\n`.repeat(20), // fat body — must NOT appear in list path
    );
  }
}

function main() {
  const node = new FakeNode();
  const k = new Kanban(node);
  const BOARD_SLUG = "default";
  const N = 200; // realistic busy board

  seed(k, BOARD_SLUG, N);
  node.resetCounters();

  // --- A: list whole board ---
  const boardList = k.listBoard(BOARD_SLUG);
  assert(boardList.length === N, `listBoard size ${boardList.length} != ${N}`);
  assert(
    boardList.every((c) => !("body" in c) || (c as { body?: string }).body === undefined),
    "list must not carry body",
  );
  const qListBoard = node.queries;
  assert(qListBoard === 1, `listBoard queries=${qListBoard} want 1`);

  // --- B: list todo only (no separate column table) ---
  node.resetCounters();
  const todo = k.listColumn(BOARD_SLUG, "todo");
  assert(todo.length === N / 4, `todo count ${todo.length}`);
  assert(todo.every((c) => c.column === "todo"), "column filter");
  const qTodo = node.queries;
  assert(qTodo === 1, `listColumn queries=${qTodo} want 1`);

  // --- C: move card (same board) ---
  node.resetCounters();
  // list once to find a todo card, then move — real code would know sk from prior read
  // For write path cost we count move() alone after locating by one partition read inside move.
  const before = k.listColumn(BOARD_SLUG, "todo")[0]!;
  node.resetCounters();
  k.move(BOARD_SLUG, before.slug, "doing", 0);
  // move does: 1 partition read + 1 delete + 1 put
  assert(node.queries === 1, `move queries=${node.queries} want 1 (find row)`);
  assert(node.mutations === 2, `move mutations=${node.mutations} want 2 (del+put)`);
  assert(
    k.listColumn(BOARD_SLUG, "todo").every((c) => c.slug !== before.slug),
    "removed from todo",
  );
  assert(
    k.listColumn(BOARD_SLUG, "doing").some((c) => c.slug === before.slug),
    "appears in doing",
  );

  // --- D: show one body (only time we touch CardBody) ---
  node.resetCounters();
  const body = k.showBody(before.slug);
  assert(body && body.body.includes("Spec"), "body point-get");
  assert(node.queries === 1, `showBody queries=${node.queries} want 1`);

  // --- E: contrast with today's N+1 list ---
  // Old: 1 index + N body hydrations for full list
  const oldListQueries = 1 + N;
  const newListQueries = 1;
  assert(newListQueries < oldListQueries, "new list cheaper");

  // --- F: do we need a column partition table? ---
  // With sk = column#pos#slug, column list is still 1 query (partition + prefix).
  // Separate hash=board#column would also be 1 query but adds move rewrites across
  // two partitions when changing column — extra write complexity for same read cost.
  const needColumnTable = false;

  console.log(JSON.stringify({
    ok: true,
    design: {
      board: "Hash key=board slug",
      boardCards: "HashRange hash=board range=column#pos#slug thin projection",
      cardBody: "Hash key=slug (point get only)",
      separateColumnTable: needColumnTable,
      whyNotColumnTable:
        "Cards rarely leave a board; column is sk prefix. listColumn = 1 partition query + prefix. Move = del+put in same board partition.",
    },
    spike: {
      boardSize: N,
      listBoardQueries: qListBoard,
      listColumnQueries: qTodo,
      moveQueries: 1,
      moveMutations: 2,
      showBodyQueries: 1,
      oldFullListWithBodyHydrate: oldListQueries,
      newFullListThin: newListQueries,
      savingsFactor: oldListQueries / newListQueries,
    },
  }, null, 2));
}

main();
