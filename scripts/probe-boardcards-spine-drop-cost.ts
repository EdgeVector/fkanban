#!/usr/bin/env bun
/**
 * READ-ONLY probe: what does the SPINE cost on the real list projection?
 *
 * `probe-boardcards-per-field-cost.ts` found the surprise: `["slug"]` reads the
 * partition in 152ms and the five-field spine takes 362ms — same rows, +210ms,
 * for four fields that are payload COPIES of data the caller already holds.
 * `board` is the filter argument it passed in; `sk` is `QueryRow.key.range`;
 * column/position/slug fall out of `parseBoardCardSk(sk)`. Nothing in the spine
 * has to be fetched at all — `sweepBoardCardsPartition` already reconstructs it
 * exactly this way (src/board-cards.ts:1067).
 *
 * That was measured on spine+1. This asks whether the saving survives on the
 * projection the board actually serves: 22 fields with the spine against the
 * same set with the spine reconstructed from the key.
 *
 * ROWS ARE PART OF THE RESULT, not a sanity check. Dropping spine fields can
 * only ADD rows (a narrower projection drops fewer), and any extra row is
 * partial-write residue that today's list is structurally blind to. A cost win
 * that quietly changes the row set is a different change than a cost win, and
 * the two must not be reported as one.
 *
 * Run: bun scripts/probe-boardcards-spine-drop-cost.ts [reps] [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  BOARD_CARDS_SPINE_FIELDS,
  BOARD_CARDS_LIST_FIELDS,
  BOARD_CARDS_DISPLAY_FIELDS,
  BOARD_CARDS_DEP_SEED_FIELDS,
  boardCardsHash,
  parseBoardCardSk,
} from "../src/board-cards.ts";

const reps = Number(process.argv[2] ?? 7);
const board = process.argv[3] ?? "default";
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const hash = boardCardsHash(cfg);
if (!hash) {
  console.error("no board_cards schema hash in config");
  process.exit(1);
}

const spine = new Set<string>(BOARD_CARDS_SPINE_FIELDS);
/**
 * The same want-list with the spine reconstructed from the key — leading with
 * `slug`. Cheapest, but it CHANGES THE GATE: the leading projected field
 * decides the row set, and `["slug"]` was measured seeing 357 rows where the
 * `board`-led spine saw 338.
 */
const debonedSlugLed = (fields: readonly string[]): string[] => [
  "slug",
  ...fields.filter((f) => !spine.has(f)),
];

/**
 * The strictly-safe variant: KEEP `board` as the leading field, so the gate is
 * byte-identical to today's, and drop only the trailing spine copies
 * (`sk`/`slug`/`column`/`position`) that `parseBoardCardSk(key.range)` recovers.
 * Per the measured rule in `listBoardCardsPartitionComplete`, dropping trailing
 * fields cannot change which rows come back.
 */
const debonedBoardLed = (fields: readonly string[]): string[] => [
  "board",
  ...fields.filter((f) => !spine.has(f)),
];

const cases: Array<{ label: string; fields: string[] }> = [
  { label: "list  wide (spine)", fields: [...BOARD_CARDS_LIST_FIELDS] },
  { label: "list  wide (board)", fields: debonedBoardLed(BOARD_CARDS_LIST_FIELDS) },
  { label: "list  wide (slug)", fields: debonedSlugLed(BOARD_CARDS_LIST_FIELDS) },
  { label: "display   (spine)", fields: [...BOARD_CARDS_DISPLAY_FIELDS] },
  { label: "display   (board)", fields: debonedBoardLed(BOARD_CARDS_DISPLAY_FIELDS) },
  { label: "display   (slug)", fields: debonedSlugLed(BOARD_CARDS_DISPLAY_FIELDS) },
  { label: "dep seed  (spine)", fields: [...BOARD_CARDS_DEP_SEED_FIELDS] },
  { label: "dep seed  (board)", fields: debonedBoardLed(BOARD_CARDS_DEP_SEED_FIELDS) },
  { label: "dep seed  (slug)", fields: debonedSlugLed(BOARD_CARDS_DEP_SEED_FIELDS) },
];

type Row = { slug: string; column: string; position: string };
const collect = (results: any[], hasSpine: boolean): Map<string, Row> => {
  const out = new Map<string, Row>();
  for (const r of results) {
    const f = r.fields as Record<string, unknown>;
    const sk = typeof r.key?.range === "string" ? r.key.range : "";
    const parsed = parseBoardCardSk(sk);
    const slug = hasSpine
      ? String(f.slug ?? parsed?.slug ?? "")
      : String(f.slug ?? parsed?.slug ?? "");
    const column = hasSpine ? String(f.column ?? "") : (parsed?.column ?? "");
    const position = hasSpine ? String(f.position ?? "") : (parsed?.position ?? "");
    if (sk.length > 0) out.set(sk, { slug, column, position });
  }
  return out;
};

async function timeOnce(fields: string[], hasSpine: boolean) {
  const t0 = performance.now();
  const res = await node.queryAll({ schemaHash: hash!, fields, filter: { HashKey: board } });
  const ms = performance.now() - t0;
  return { ms, rows: collect(res.results, hasSpine) };
}

const samples = new Map<string, number[]>();
const lastRows = new Map<string, Map<string, Row>>();
for (const c of cases) samples.set(c.label, []);

for (const c of cases) await timeOnce(c.fields, c.label.includes("(spine)"));

for (let r = 0; r < reps; r++) {
  for (const c of cases) {
    const { ms, rows } = await timeOnce(c.fields, c.label.includes("(spine)"));
    samples.get(c.label)!.push(ms);
    lastRows.set(c.label, rows);
  }
  process.stderr.write(`  rep ${r + 1}/${reps}\n`);
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};

console.log(`\n== median of ${reps} reps, HashKey(${board}) ==`);
for (let i = 0; i < cases.length; i += 3) {
  const a = cases[i]!;
  const ma = median(samples.get(a.label)!);
  const ra = lastRows.get(a.label)!;
  console.log(
    `  ${a.label.padEnd(18)} fields=${String(a.fields.length).padStart(2)} ${Math.round(ma).toString().padStart(4)}ms rows=${ra.size}   (baseline)`,
  );
  for (const b of [cases[i + 1]!, cases[i + 2]!]) {
    const mb = median(samples.get(b.label)!);
    const rb = lastRows.get(b.label)!;
    console.log(
      `  ${b.label.padEnd(18)} fields=${String(b.fields.length).padStart(2)} ${Math.round(mb).toString().padStart(4)}ms rows=${rb.size}` +
        `   ${mb < ma ? "-" : "+"}${Math.abs(Math.round(mb - ma))}ms (${Math.round((mb / ma) * 100)}%)`,
    );
    // Row-set delta, and whether the reconstructed spine agrees where both saw a row.
    const extra = [...rb.keys()].filter((k) => !ra.has(k));
    const missing = [...ra.keys()].filter((k) => !rb.has(k));
    let disagree = 0;
    const sampleDisagree: string[] = [];
    for (const [sk, av] of ra) {
      const bv = rb.get(sk);
      if (!bv) continue;
      if (av.slug !== bv.slug || av.column !== bv.column || av.position !== bv.position) {
        disagree++;
        if (sampleDisagree.length < 3) sampleDisagree.push(`${sk}: ${JSON.stringify(av)} vs ${JSON.stringify(bv)}`);
      }
    }
    console.log(
      `     +${extra.length} row(s) vs baseline, -${missing.length}; reconstructed-spine disagreement: ${disagree}` +
        (sampleDisagree.length ? `\n       ${sampleDisagree.join("\n       ")}` : ""),
    );
    if (extra.length > 0) console.log(`       extra e.g. ${extra.slice(0, 3).map((k) => rb.get(k)!.slug || k).join(", ")}`);
  }
  console.log("");
}
