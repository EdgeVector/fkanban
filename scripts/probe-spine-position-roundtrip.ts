#!/usr/bin/env bun
/**
 * READ-ONLY probe: does the spine path's `position` survive its own key?
 *
 * `spineRowsFromQueryRows` takes `position` from
 * `parseBoardCardSk(key.range)`, which un-pads through `String(Number(...))`.
 * That round trip is lossy for any position that is not a plain integer:
 * `boardCardSk` pads "m" to "0000000m" and `Number("0000000m")` is NaN.
 *
 * It matters because `board_cards_heal` compares reconstructed addresses —
 * `boardCardSk(r.column, r.position, r.slug) === truthSk` (src/commands/
 * board_cards_heal.ts:565,571) — and writes the value back
 * (`thinCard({...truth, position: row.position})`, line 672). A row whose
 * position does not round-trip therefore reads as STALE while being correct,
 * and a repair would store "NaN" in the field that ORDERS the board.
 *
 * So: enumerate the live partitions and report every row whose real range key
 * disagrees with the key rebuilt from its own parsed parts.
 *
 * Run: bun scripts/probe-spine-position-roundtrip.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, boardCardSk, parseBoardCardSk } from "../src/board-cards.ts";
import { listBoards } from "../src/record.ts";

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

const boards = await listBoards(node, cfg);
let total = 0;
const broken: Array<{ board: string; sk: string; rebuilt: string; parsedPos: string }> = [];

for (const b of boards) {
  const res = await node.queryAll({
    schemaHash: hash,
    fields: ["slug"],
    filter: { HashKey: b.slug } as never,
  });
  for (const r of res.results) {
    const sk = typeof r.key?.range === "string" ? r.key.range : "";
    if (sk.length === 0) continue;
    total++;
    const p = parseBoardCardSk(sk);
    if (!p) continue;
    const rebuilt = boardCardSk(p.column, p.position, p.slug);
    if (rebuilt !== sk) broken.push({ board: b.slug, sk, rebuilt, parsedPos: p.position });
  }
}

console.log(`\nrows examined: ${total} across ${boards.length} board(s)`);
console.log(`rows whose key does NOT survive parse->rebuild: ${broken.length}\n`);
for (const x of broken.slice(0, 20)) {
  console.log(`  ${x.board}  real=${x.sk}`);
  console.log(`  ${" ".repeat(x.board.length)}  rebuilt=${x.rebuilt}   parsed position=${x.parsedPos}`);
}
if (broken.length === 0) {
  console.log("  none — every live position is a plain integer, so the lossy");
  console.log("  round trip is latent on this board rather than firing.");
}
