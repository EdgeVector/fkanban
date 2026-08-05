#!/usr/bin/env bun
/**
 * READ-ONLY probe: which projected fields does each consumer actually READ?
 *
 * `BOARD_CARDS_LIST_FIELDS` justifies its width as "every dual-written
 * BoardCards field a body-free list consumer reads". That is an assertion about
 * consumers, and nothing has ever checked it — while projection width is a
 * first-class node cost (measured 0.083ms per row-field on the live `default`
 * partition, `probe-list-read-cost-axes.ts`), and `board_cards` hydrate is
 * 99.6% of kanban's single largest node cost.
 *
 * Method: fetch live cards through the REAL list path at the REAL projection,
 * wrap each row in a read-recording Proxy, then run the REAL consumer (the pure
 * build/render functions the commands call) and diff projected-vs-read.
 *
 * Three verdicts per path, because two of them are reasons NOT to narrow:
 *
 *   READ     the consumer touched the field — keep it
 *   UNREAD   no read observed on live data, and the field name appears nowhere
 *            in the consumer's module set — a narrowing candidate
 *   OPAQUE   the consumer enumerated whole card objects (spread / JSON /
 *            Object.keys). Every field is "read" by construction and this probe
 *            can say NOTHING about that path. Reported, never narrowed.
 *
 * The `ownKeys` trap is the whole reason this is trustworthy rather than
 * optimistic: without it a single `{...card}` anywhere in a consumer would mark
 * all 19 fields READ and the probe would agree with whatever it was handed.
 *
 * Live data can only ever show the branches this board's rows reach, so an
 * unread field is cross-checked against a static scan of the consumer sources
 * before it is called a candidate. A field that greps as reachable is reported
 * CONDITIONAL — the probe declines to pick a branch rather than narrowing on a
 * quiet board.
 *
 * Run: bun scripts/probe-projection-field-consumption.ts
 */
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  listBoards,
  listCards,
  listCardsForDisplay,
  CARD_LIST_FIELDS,
  CARD_DISPLAY_FIELDS,
  type Card,
} from "../src/record.ts";
import { boardCardsProjectionForCardFields, boardCardsWireProjection } from "../src/board-cards.ts";
import { renderBoard } from "../src/board.ts";
import { buildPickupStatusReport, renderPickupStatus } from "../src/pickup.ts";

type Trace = { read: Set<string>; opaque: string[] };

/** Wrap a card so every property read is recorded, and whole-object
 *  enumeration is recorded as a separate, louder fact. */
function traceCard(card: Card, trace: Trace, tag: string): Card {
  return new Proxy(card, {
    get(target, prop, recv) {
      if (typeof prop === "string") trace.read.add(prop);
      return Reflect.get(target, prop, recv);
    },
    ownKeys(target) {
      // spread, JSON.stringify, Object.keys/entries/assign — the consumer took
      // the whole row, so per-field evidence from this path is worthless.
      if (!trace.opaque.includes(tag)) trace.opaque.push(tag);
      return Reflect.ownKeys(target);
    },
  }) as Card;
}

/** Does this field name appear at all in the consumer sources? A field read
 *  only on a branch this board cannot reach must not be called unread. */
const SRC = join(import.meta.dir, "..", "src");
function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) out.push(...sourceFiles(p));
    else if (e.name.endsWith(".ts")) out.push(p);
  }
  return out;
}
const SOURCES = new Map(sourceFiles(SRC).map((p) => [p, readFileSync(p, "utf8")]));
function mentions(field: string, files: string[]): string[] {
  const re = new RegExp(`[.\\[]"?${field}\\b`);
  const hits: string[] = [];
  for (const f of files) {
    for (const [p, text] of SOURCES) {
      if (!p.endsWith(f)) continue;
      if (re.test(text)) hits.push(p.slice(SRC.length + 1));
    }
  }
  return hits;
}

function report(
  name: string,
  cardFields: string[],
  trace: Trace,
  consumerFiles: string[],
): void {
  const wire = boardCardsWireProjection(boardCardsProjectionForCardFields(cardFields));
  console.log(`\n=== ${name}`);
  console.log(`  projection: ${wire.length} fields on the wire — ${wire.join(", ")}`);
  if (trace.opaque.length > 0) {
    console.log(`  OPAQUE — consumer enumerated whole cards (${trace.opaque.join(", ")}).`);
    console.log(`  This path cannot be audited per-field. No narrowing conclusion.`);
    return;
  }
  const unread = wire.filter((f) => !trace.read.has(f));
  const read = wire.filter((f) => trace.read.has(f));
  console.log(`  READ (${read.length}): ${read.join(", ") || "—"}`);
  if (unread.length === 0) {
    console.log(`  UNREAD: none — projection is exactly its consumer.`);
    return;
  }
  for (const f of unread) {
    const hits = mentions(f, consumerFiles);
    console.log(
      hits.length > 0
        ? `  CONDITIONAL  ${f} — unread on live data, but reachable in ${hits.join(", ")}`
        : `  UNREAD       ${f} — no read, and no mention in ${consumerFiles.join(", ")}`,
    );
  }
}

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const boards = await listBoards(node, cfg);
const board = boards.find((b) => b.slug === "default") ?? boards[0]!;

// ---- 1. `kanban list` (bare text) — CARD_DISPLAY_FIELDS -> renderBoard
{
  const cards = await listCardsForDisplay(node, cfg, { boards: [board] });
  const trace: Trace = { read: new Set(), opaque: [] };
  const traced = cards.map((c) => traceCard(c, trace, "renderBoard"));
  renderBoard(board, traced, { color: false });
  report("kanban list (text) — renderBoard", CARD_DISPLAY_FIELDS, trace, ["board.ts"]);
}

// ---- 2. `kanban pickup status` — CARD_LIST_FIELDS -> classification report
{
  const cards = await listCards(node, cfg, { boards, activeOnly: true });
  const trace: Trace = { read: new Set(), opaque: [] };
  const traced = cards.map((c) => traceCard(c, trace, "pickup"));
  renderPickupStatus(buildPickupStatusReport(traced));
  report("kanban pickup status — classify + render", CARD_LIST_FIELDS, trace, [
    "pickup.ts",
    "pickup_lanes.ts",
  ]);
}

// ---- 3. `kanban list --json` — CARD_LIST_FIELDS -> JSON.stringify
{
  const cards = await listCards(node, cfg, { boards: [board] });
  const trace: Trace = { read: new Set(), opaque: [] };
  const traced = cards.map((c) => traceCard(c, trace, "json"));
  JSON.stringify(traced);
  report("kanban list --json — serialize", CARD_LIST_FIELDS, trace, ["commands/list.ts"]);
}
