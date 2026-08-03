#!/usr/bin/env bun
/**
 * READ-ONLY probe: does replacing the position un-pad change ANY live row?
 *
 * `parseBoardCardSk` used to un-pad the position segment with
 * `String(Number(segment))` and now strips the padding at the string level.
 * The two agree on plain integers and disagree destructively elsewhere
 * ("0000000m" -> "NaN"; "000001e3" -> "1000"). Every position on the live board
 * is a plain integer, so the claim this probe exists to VERIFY rather than
 * assert is: the fix is a behaviour change for the broken cases and a strict
 * no-op for everything currently stored.
 *
 * Run: bun scripts/probe-position-unpad-differential.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsHash, parseBoardCardSk } from "../src/board-cards.ts";
import { listBoards } from "../src/record.ts";

/** Exactly the pre-2026-08-03 un-pad, kept here so the diff is measurable. */
const legacyPosition = (sk: string): string | null => {
  const i = sk.indexOf("#");
  if (i < 0) return null;
  const j = sk.indexOf("#", i + 1);
  if (j < 0) return null;
  return String(Number(sk.slice(i + 1, j)));
};

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
const differs: Array<{ board: string; sk: string; legacy: string; fixed: string }> = [];

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
    const legacy = legacyPosition(sk);
    const fixed = parseBoardCardSk(sk)?.position ?? null;
    if (legacy !== fixed) {
      differs.push({ board: b.slug, sk, legacy: String(legacy), fixed: String(fixed) });
    }
  }
}

console.log(`\nrows examined: ${total} across ${boards.length} board(s)`);
console.log(`rows where the fixed un-pad DIFFERS from the legacy one: ${differs.length}\n`);
for (const d of differs.slice(0, 20)) {
  console.log(`  ${d.board}  ${d.sk}`);
  console.log(`      legacy=${d.legacy}  fixed=${d.fixed}`);
}
if (differs.length === 0) {
  console.log("  none — every stored position is a plain integer, so this fix");
  console.log("  changes only the cases that were already wrong.");
}
