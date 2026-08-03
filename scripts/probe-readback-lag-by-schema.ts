#!/usr/bin/env bun
/**
 * Probe: is the post-ack read lag a property of the RECORD or of the INDEX?
 *
 * ## Why this exists
 *
 * `probe-write-readback-visibility.ts` measured that a BoardCards write is
 * invisible for ~400-750ms after its ack — 0 of 8 rows readable on the first
 * read. That was measured on ONE schema, and generalizing from one schema is
 * how this repo has been wrong before (see the `schema_type` correction in
 * `lastdb-molecule-gate-kanban-is-the-worst-offender-...`: the declared type was
 * never the variable that mattered).
 *
 * kanban writes two shapes and the difference decides which surfaces are
 * affected:
 *
 *   Card        Hash,      hash=slug   — what `show` reads
 *   BoardCards  HashRange, hash=board  — what `list`/`pickup`/`overlap` read
 *
 * If only the HashRange index lags, then `kanban show <slug>` right after
 * `kanban add` is safe while `kanban list` is not, and the rule to write down
 * is about indexes, not about writes.
 *
 * ## Method
 *
 * Same write→poll loop for both schemas, interleaved so node warmth cannot
 * favour whichever ran first. Each schema is read back the way its own
 * consumers read it: Card by its hash key, BoardCards by its partition.
 *
 * WRITES synthetic `zzlag-*` records: Card rows under throwaway slugs, and
 * BoardCards rows on a synthetic board partition. Never touches `default`,
 * never creates a Board record. All rows deleted on the way out.
 *
 * Run: bun scripts/probe-readback-lag-by-schema.ts [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, boardCardFieldsFromCard } from "../src/board-cards.ts";
import type { Card } from "../src/record.ts";

const REPS = Number(process.argv[2] ?? 6);
const MAX_POLLS = 30;

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boardCardsSchema = boardCardsHash(cfg);
const cardSchema = cfg.schemaHashes?.card;
if (!boardCardsSchema) throw new Error("no board_cards schema hash in config");
if (!cardSchema) throw new Error("no card schema hash in config");

const STAMP = Date.now();
const BOARD = `zzlag-${STAMP}`;
const bcWritten: string[] = [];
const cardWritten: string[] = [];

function synthetic(i: number): Card {
  return {
    slug: `zzlag-${STAMP}-${i}`,
    title: `lag-by-schema probe ${i}`,
    column: "todo",
    position: String(1000 + i),
    board: BOARD,
    body: "",
    created_at: new Date(STAMP).toISOString(),
    updated_at: new Date().toISOString(),
  } as Card;
}

/** Write + poll until readable. Returns ms from ack to first successful read. */
async function writeThenSee(
  write: () => Promise<void>,
  see: () => Promise<boolean>,
): Promise<{ writeMs: number; lagMs: number | null; polls: number }> {
  const t0 = performance.now();
  await write();
  const writeMs = performance.now() - t0;
  const tAck = performance.now();
  for (let p = 1; p <= MAX_POLLS; p++) {
    if (await see()) return { writeMs, lagMs: performance.now() - tAck, polls: p };
  }
  return { writeMs, lagMs: null, polls: MAX_POLLS };
}

async function bcCase(i: number) {
  const card = synthetic(i);
  const fields = boardCardFieldsFromCard(card);
  const sk = String(fields.sk);
  bcWritten.push(sk);
  return writeThenSee(
    () => node.updateRecord({ schemaHash: boardCardsSchema!, fields, keyHash: BOARD, rangeKey: sk }),
    async () => {
      const res = await node.queryAll({
        schemaHash: boardCardsSchema!,
        fields: ["slug", "column", "board"],
        filter: { HashKey: BOARD },
      });
      return res.results.some((r) => String((r.fields ?? {}).slug ?? "") === card.slug);
    },
  );
}

async function cardCase(i: number) {
  const card = synthetic(1000 + i);
  cardWritten.push(card.slug);
  const fields: Record<string, unknown> = {
    slug: card.slug,
    title: card.title,
    body: "",
    column: card.column,
    position: card.position,
    board: card.board,
    created_at: card.created_at,
    updated_at: card.updated_at,
  };
  return writeThenSee(
    () => node.updateRecord({ schemaHash: cardSchema!, fields, keyHash: card.slug }),
    async () => {
      const res = await node.queryAll({
        schemaHash: cardSchema!,
        fields: ["slug", "title"],
        filter: { HashKey: card.slug },
      });
      return res.results.some((r) => String((r.fields ?? {}).slug ?? "") === card.slug);
    },
  );
}

function report(label: string, rs: Array<{ writeMs: number; lagMs: number | null; polls: number }>) {
  const lags = rs.map((r) => r.lagMs).filter((x): x is number => x !== null);
  const immediate = rs.filter((r) => r.polls === 1).length;
  const never = rs.filter((r) => r.lagMs === null).length;
  const avg = lags.length ? lags.reduce((a, b) => a + b, 0) / lags.length : 0;
  const max = lags.length ? Math.max(...lags) : 0;
  console.log(
    `${label.padEnd(26)} readable-on-first-read=${immediate}/${rs.length}  ` +
      `lag avg=${avg.toFixed(0).padStart(4)}ms max=${max.toFixed(0).padStart(4)}ms  never=${never}`,
  );
}

async function main() {
  console.log(`board partition: ${BOARD} (synthetic)   reps=${REPS}\n`);
  const bc: Array<Awaited<ReturnType<typeof bcCase>>> = [];
  const cd: Array<Awaited<ReturnType<typeof cardCase>>> = [];
  // Interleaved: node warmth cannot favour whichever schema ran first.
  for (let i = 0; i < REPS; i++) {
    bc.push(await bcCase(i));
    cd.push(await cardCase(i));
  }
  console.log("");
  report("BoardCards (HashRange)", bc);
  report("Card (Hash)", cd);
  console.log("");
  const bcImmediate = bc.filter((r) => r.polls === 1).length;
  const cdImmediate = cd.filter((r) => r.polls === 1).length;
  if (cdImmediate === REPS && bcImmediate < REPS) {
    console.log("VERDICT: the INDEX lags, the record does not. `show` (Card, by hash)");
    console.log("         reads its own write; every BoardCards-backed surface");
    console.log("         (list/pickup/overlap/rank/portfolio) can miss it.");
  } else if (bcImmediate < REPS && cdImmediate < REPS) {
    console.log("VERDICT: BOTH shapes lag — the delay is in the write path, not the index.");
  } else {
    console.log("VERDICT: read the numbers above; the split is not the expected one.");
  }
}

try {
  await main();
} finally {
  let cleaned = 0;
  const total = bcWritten.length + cardWritten.length;
  for (const sk of bcWritten) {
    try {
      await node.deleteRecord({ schemaHash: boardCardsSchema!, keyHash: BOARD, rangeKey: sk });
      cleaned++;
    } catch { /* best effort */ }
  }
  for (const slug of cardWritten) {
    try {
      await node.deleteRecord({ schemaHash: cardSchema!, keyHash: slug });
      cleaned++;
    } catch { /* best effort */ }
  }
  console.log(`\ncleanup: deleted ${cleaned}/${total} probe rows`);
}
