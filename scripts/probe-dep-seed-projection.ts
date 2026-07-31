#!/usr/bin/env bun
/**
 * READ-ONLY: candidate projection for the `list --column` dependency seed.
 *
 * The seed feeds `depStatus` (reads slug/board/column/kind) through
 * `listCardsByColumn`, which also drops hidden cards (`isHiddenCard` reads
 * `tags`). So the candidate is board/sk/slug/column/position/tags/kind.
 *
 * Proves it is (a) materially cheaper than the 24-field read and (b) drop-free
 * — a projected field missing from a row removes the whole row silently.
 *
 *   bun scripts/probe-dep-seed-projection.ts [column] [reps]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";
import { BOARD_CARDS_SPINE_FIELDS, parseBoardCardSk } from "../src/board-cards.ts";
import type { QueryFilter } from "../src/client.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const schemaHash = cfg.schemaHashes["board_cards"]!;
const COLUMN = process.argv[2] ?? "done";
const REPS = Number(process.argv[3] ?? "3");
const filter = { HashRangePrefix: { hash: "default", prefix: `${COLUMN}#` } } as unknown as QueryFilter;

const CANDIDATE = [...BOARD_CARDS_SPINE_FIELDS, "tags", "kind"];

const VARIANTS = [
  { name: `wide(${BOARD_CARDS_FIELDS.length})`, fields: [...BOARD_CARDS_FIELDS] },
  { name: `candidate(${CANDIDATE.length})`, fields: CANDIDATE },
  { name: `spine(${BOARD_CARDS_SPINE_FIELDS.length})`, fields: [...BOARD_CARDS_SPINE_FIELDS] },
];

const times = new Map<string, number[]>(VARIANTS.map((v) => [v.name, []]));
const slugSets = new Map<string, Set<string>>();

for (let rep = 0; rep < REPS; rep++) {
  for (const v of VARIANTS) {
    const t0 = performance.now();
    const res = await node.queryAll({ schemaHash, fields: v.fields, filter });
    times.get(v.name)!.push(performance.now() - t0);
    if (rep === 0) {
      const s = new Set<string>();
      for (const r of res.results) {
        const f = r.fields as Record<string, unknown>;
        const sk = typeof f.sk === "string" ? f.sk : "";
        const slug = parseBoardCardSk(sk)?.slug ?? (typeof f.slug === "string" ? f.slug : "");
        if (slug) s.add(slug);
      }
      slugSets.set(v.name, s);
    }
  }
}

console.log(`column=${COLUMN} reps=${REPS}`);
for (const [name, samples] of times) {
  const sorted = [...samples].sort((a, b) => a - b);
  console.log(
    `  ${name.padEnd(14)} median=${sorted[Math.floor(sorted.length / 2)]!.toFixed(0)}ms` +
      `  rows=${slugSets.get(name)!.size}`,
  );
}

const spine = slugSets.get(`spine(${BOARD_CARDS_SPINE_FIELDS.length})`)!;
for (const [name, s] of slugSets) {
  const lost = [...spine].filter((x) => !s.has(x));
  console.log(`  ${name} drops vs spine: ${lost.length}${lost.length ? ` (${lost.slice(0, 5).join(", ")})` : ""}`);
}
