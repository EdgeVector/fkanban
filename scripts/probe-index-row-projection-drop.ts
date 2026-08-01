#!/usr/bin/env bun
/**
 * READ-ONLY probe: can `readIndexRow`'s projection LOSE the `all_boards` row?
 *
 * `readIndexRow` (src/card-list-index.ts) projects three fields — key,
 * payload_json, updated_at — and every caller reads a `null` return as "the row
 * does not exist". LastDB returns a row only when EVERY projected field has an
 * atom (the rule this repo states at board-cards.ts:105), so that `null` also
 * means "one of the three fields is missing an atom" — a state the callers have
 * no way to distinguish.
 *
 * The write path's own existence probe in `writeIndexPayload` projects ONE
 * field (`key`), so the two disagree in exactly the dangerous direction:
 * the read says absent, the probe says present.
 *
 * This probe asks four questions in one pass (a probe that models only the
 * branch you suspect is the hypothesis with a shell around it):
 *
 *   1. WIDTH     — does each index row survive a read at 1, 2 and 3 fields?
 *   2. ATOMS     — which of the three fields actually carries a value?
 *   3. DISAGREE  — do the 3-field read and the 1-field existence probe differ?
 *   4. NEIGHBOUR — the same three questions for `all_cards`, the retired row.
 *
 * Measured on the primary 2026-08-01: CLEAN. `all_boards` carries all three
 * atoms and both widths agree, so the defect this guards was LATENT, not live —
 * `groom board-list-heal` read 2 entries against 2 truth boards, 0 ghosts,
 * 0 missing. `all_cards` is absent at every width, as expected for the retired
 * rollup. Keep the probe: the damaged state is silent, self-concealing (the
 * repair verb used to report `index_absent` and decline), and nothing else
 * re-checks it.
 *
 * NOT a perf probe. Narrowing the product read from 3 fields to 1 was measured
 * on the primary at 196ms vs 195ms median over interleaved reps — a wash, and
 * expected to be: this is a single row, so per-field resolution is noise. The
 * narrowing is worth it for droppability alone.
 *
 * It writes nothing. Run: bun scripts/probe-index-row-projection-drop.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient, type QueryFilter } from "../src/client.ts";
import { CARD_LIST_INDEX_FIELDS, CARD_LIST_INDEX_KEY } from "../src/schemas.ts";
import { BOARD_LIST_INDEX_KEY } from "../src/card-list-index.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const schemaHash = schemaHashFor("card_list_index", cfg);
if (!schemaHash) {
  console.error("no card_list_index schema hash in config — nothing to probe");
  process.exit(1);
}

/**
 * No try/catch. A probe that cannot read must STOP, not score the failure as a
 * finding — the last probe that swallowed a read error reported that every row
 * on the board was broken (checkpoint 20260801b).
 */
async function readAt(key: string, fields: readonly string[]) {
  const res = await node.queryAll({
    schemaHash: schemaHash!,
    fields: [...fields],
    filter: { HashKey: key } as QueryFilter,
  });
  return res.results[0] ?? null;
}

const WIDTHS: Array<[string, readonly string[]]> = [
  ["1  key                 (writeIndexPayload existence probe)", ["key"]],
  ["2  key,payload_json", ["key", "payload_json"]],
  ["3  key,payload,updated (readIndexRow — every product read)", CARD_LIST_INDEX_FIELDS],
];

for (const key of [BOARD_LIST_INDEX_KEY, CARD_LIST_INDEX_KEY]) {
  console.log(`\n=== ${key} ===`);

  const survives: Record<string, boolean> = {};
  for (const [label, fields] of WIDTHS) {
    const row = await readAt(key, fields);
    survives[label] = row !== null;
    console.log(`  ${row ? "FOUND  " : "MISSING"}  ${label}`);
  }

  // Which fields actually carry an atom? Read each one ALONE, so a missing
  // sibling cannot drop the row and hide the answer.
  const present: string[] = [];
  const absent: string[] = [];
  for (const field of CARD_LIST_INDEX_FIELDS) {
    const row = await readAt(key, [field]);
    (row === null ? absent : present).push(field);
  }
  console.log(`  atoms present: ${present.join(", ") || "(none)"}`);
  console.log(`  atoms ABSENT : ${absent.join(", ") || "(none)"}`);

  const probeSees = survives[WIDTHS[0]![0]];
  const readSees = survives[WIDTHS[2]![0]];
  if (probeSees && !readSees) {
    console.log(
      "  *** DISAGREEMENT: the 1-field existence probe FINDS this row and the\n" +
        "      3-field product read does NOT. patchBoardListIndex would rebuild\n" +
        "      the rollup from an EMPTY base and updateRecord it with no CAS,\n" +
        "      and `groom board-list-heal` would report index_absent and decline\n" +
        "      to repair it.",
    );
  } else if (probeSees && readSees) {
    console.log("  agreement: both widths see the row — not currently reachable.");
  } else if (!probeSees && !readSees) {
    console.log("  agreement: row genuinely absent at every width.");
  }

  // Neighbouring fact: how big is the payload, and how many entries?
  const full = await readAt(key, CARD_LIST_INDEX_FIELDS);
  const raw = (full?.fields as Record<string, unknown> | undefined)?.payload_json;
  if (typeof raw === "string") {
    let count = "unparseable";
    try {
      const parsed = JSON.parse(raw) as unknown;
      count = Array.isArray(parsed) ? String(parsed.length) : "not-an-array";
    } catch {
      count = "unparseable";
    }
    console.log(`  payload_json: ${raw.length} B, ${count} entries`);
  }
}

console.log(
  "\nNote: `readIndexRow` returning null is read as 'no row' by readBoardListIndex,\n" +
    "readCardListIndex, patchBoardListIndex and groom board-list-heal alike.\n",
);
