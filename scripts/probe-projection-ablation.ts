#!/usr/bin/env bun
/**
 * READ-ONLY probe: drop ONE field from the list projection and see what the
 * list path actually returns differently.
 *
 * Consumer-level tracing (`probe-projection-field-consumption.ts`) can say what
 * a RENDERER reads, and that is not the same question — the shared read path
 * reads fields no renderer sees (`deriveStructuredFields` reads `surfaces`,
 * `preferFresherBoardCard` reads `updated_at`), so "the consumer never touched
 * it" is not evidence that the projection may drop it.
 *
 * This asks the end-to-end question instead: run the REAL list path at the real
 * projection, then again with one field removed, and diff the Card set. Whatever
 * changes is what that field is buying.
 *
 * The result to watch for is NOT which fields change the output. It is the
 * SHAPE of the change: `cardFromBoardCardFields` builds a complete Card with
 * `""` / `[]` / `"unknown"` defaults for every field regardless of what was
 * projected, so an unprojected field is indistinguishable, downstream, from a
 * field the card genuinely does not have. A narrowing mistake here does not
 * throw and does not render blank — it renders a plausible wrong value.
 *
 * Run: bun scripts/probe-projection-ablation.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listCardsOnBoard, CARD_LIST_FIELDS, type Card } from "../src/record.ts";
import { boardCardsProjectionForCardFields, boardCardsWireProjection } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});

const BOARD = "default";
const wireOf = (cardFields: string[]) =>
  boardCardsWireProjection(boardCardsProjectionForCardFields(cardFields));

function digest(cards: Card[]): Map<string, Record<string, string>> {
  const out = new Map<string, Record<string, string>>();
  for (const c of cards) {
    const row: Record<string, string> = {};
    for (const f of CARD_LIST_FIELDS) {
      const v = (c as unknown as Record<string, unknown>)[f];
      row[f] = Array.isArray(v) ? v.join("|") : String(v ?? "");
    }
    out.set(c.slug, row);
  }
  return out;
}

const t0 = performance.now();
const baseline = digest(await listCardsOnBoard(node, cfg, BOARD, [...CARD_LIST_FIELDS]));
const baseMs = performance.now() - t0;
const baseWire = wireOf([...CARD_LIST_FIELDS]);
console.log(
  `baseline — ${baseline.size} cards, ${baseWire.length} wire fields, ${baseMs.toFixed(0)}ms`,
);
console.log(`wire: ${baseWire.join(", ")}\n`);
console.log("field         wire  rows-changed  ms     effect");
console.log("------------  ----  ------------  -----  ------");

for (const drop of CARD_LIST_FIELDS) {
  const narrowed = CARD_LIST_FIELDS.filter((f) => f !== drop);
  const wire = wireOf(narrowed);
  if (wire.length === baseWire.length) {
    console.log(
      `${drop.padEnd(12)}  ${String(wire.length).padStart(4)}  ${"—".padStart(12)}  ${"—".padStart(5)}  NOT DROPPABLE — projection re-adds it`,
    );
    continue;
  }
  const t = performance.now();
  const got = digest(await listCardsOnBoard(node, cfg, BOARD, narrowed));
  const ms = performance.now() - t;

  let changed = 0;
  const fieldsAffected = new Set<string>();
  for (const [slug, row] of baseline) {
    const other = got.get(slug);
    if (!other) {
      changed++;
      fieldsAffected.add("ROW MISSING");
      continue;
    }
    let differs = false;
    for (const f of CARD_LIST_FIELDS) {
      if (row[f] !== other[f]) {
        differs = true;
        fieldsAffected.add(`${f}:"${row[f]}"->"${other[f] ?? ""}"`.slice(0, 40));
      }
    }
    if (differs) changed++;
  }
  if (got.size !== baseline.size) fieldsAffected.add(`CARD COUNT ${baseline.size}->${got.size}`);

  const effect = changed === 0
    ? "no observable difference"
    : [...fieldsAffected].slice(0, 2).join("  ");
  console.log(
    `${drop.padEnd(12)}  ${String(wire.length).padStart(4)}  ${String(changed).padStart(12)}  ${ms.toFixed(0).padStart(5)}  ${effect}`,
  );
}
