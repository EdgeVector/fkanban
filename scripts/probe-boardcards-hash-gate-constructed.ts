#!/usr/bin/env bun
/**
 * Does the hash gate bite on BOARDCARDS, and does dropping `board` lift it?
 *
 * `probe-boardcards-hash-gate.ts` asks the same question of the LIVE partition
 * and currently answers GREEN — every row in `HashKey=default` carries a
 * `board` atom, so the shipped read loses nothing today. That is a statement
 * about today's rows, not about the read: it cannot distinguish "the gate does
 * not exist here" from "the gate exists and nothing is currently standing on
 * it", and those have opposite consequences for whether the read needs fixing.
 *
 * So construct the rows. Each witness is written with a KNOWN atom set (a
 * narrow `updateRecord` against a non-existent row stores exactly the subset
 * sent), including the shape that was live on this very partition on
 * 2026-08-01 — slug/title/column/position and no key copies, 19 of 357 rows.
 *
 * Scores three projections against them:
 *   - as-shipped   `boardCardsWireProjection(LIST_FIELDS)` — leads with `board`
 *   - hash-dropped the same list minus `board`, led by `slug`
 *   - `["slug"]`   the module's own narrowest read (BOARD_CARDS_ADDRESS_FIELDS)
 *
 * ## Why this is inert on the primary
 *
 * Same argument as `probe-projection-rule-constructed.ts`. The rows live under
 * a `HashKey` no product read addresses: every BoardCards read is keyed by a
 * board slug taken from the live Board record list (`listAllBoardCards`,
 * `board-cards heal`, doctor parity), and no Board record names this partition.
 * The rows are deleted at the end; a leaked one is inert and addressable, and
 * this script re-cleans on the next run.
 *
 *   bun scripts/probe-boardcards-hash-gate-constructed.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { boardCardsWireProjection, BOARD_CARDS_LIST_FIELDS } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";

const PROBE_PARTITION = "zzz-probe-boardcards-hash-gate-do-not-use";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const bcHash = cfg.schemaHashes!.board_cards!;

/**
 * Witnesses named by the atoms they carry.
 *  - `full`    — every field. No rule can drop it; proves the read ran at all.
 *  - `noBoard` — every field except the hash field's payload copy.
 *  - `sparse`  — the shape measured live on 2026-08-01: display fields, no key
 *                copies. This is the row a partial write actually leaves.
 *  - `boardNoSlug` — carries `board` but not `slug`, so the two candidate gates
 *                disagree about it in the opposite direction. Without this the
 *                probe could not tell "slug is a better gate" from "slug is a
 *                gate at all".
 */
const WITNESSES: Record<string, string[]> = {
  full: [...BOARD_CARDS_FIELDS],
  noBoard: BOARD_CARDS_FIELDS.filter((f) => f !== "board"),
  sparse: ["slug", "title", "column", "position"],
  boardNoSlug: ["board", "sk", "title", "column", "position"],
};
const sk = (name: string) => `probe#00000000#${name}`;

async function ranges(fields: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await node.queryAll({
    schemaHash: bcHash,
    fields,
    filter: { HashKey: PROBE_PARTITION },
  });
  for (const r of res.results ?? []) {
    if (typeof r.key?.range === "string" && r.key.range) out.add(r.key.range);
  }
  return out;
}

/**
 * Reads behind a write serve a pre-write tip for several seconds, so anything
 * measured inside that window is fiction — see the write-up on
 * `probe-projection-rule-constructed.ts`, where a 4s settle was still sometimes
 * short and 9s held.
 */
const settle = (ms = 9000) => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  for (const name of Object.keys(WITNESSES)) {
    try {
      await node.deleteRecord({ schemaHash: bcHash, keyHash: PROBE_PARTITION, rangeKey: sk(name) });
    } catch {
      /* already gone */
    }
  }
}

const label = (s: Set<string>) =>
  [...s].map((r) => r.split("#").pop()).sort().join(",") || "(none)";

try {
  await cleanup(); // in case a prior run leaked
  for (const [name, fields] of Object.entries(WITNESSES)) {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      payload[f] = f === "board"
        ? PROBE_PARTITION
        : f === "sk"
          ? sk(name)
          : f === "slug"
            ? `probe-${name}`
            : ["tags", "deps", "surfaces"].includes(f)
              ? []
              : `v-${f}`;
    }
    await node.updateRecord({
      schemaHash: bcHash,
      keyHash: PROBE_PARTITION,
      rangeKey: sk(name),
      fields: payload,
    });
  }
  await settle();

  // Atom map first, learned TWICE — the scoring below is worthless if the map
  // is read through the write window, and a single pass cannot tell a settled
  // answer from a transient one.
  const atomMap = async () => {
    const m: Record<string, string> = {};
    for (const f of ["board", "milestone", "slug", "sk", "title", "column", "position"]) {
      m[f] = label(await ranges([f]));
    }
    return m;
  };
  const m1 = await atomMap();
  await settle(9000);
  const m2 = await atomMap();
  const agree = JSON.stringify(m1) === JSON.stringify(m2);
  console.log(`BoardCards HashKey=${PROBE_PARTITION} — 4 constructed rows`);
  console.log(`\n## Atom map (single-field reads, two passes ${agree ? "AGREE" : "DISAGREE"})`);
  for (const [f, v] of Object.entries(m2)) console.log(`  ["${f}"] → ${v}`);
  if (!agree) {
    console.log("\nABORT: the two passes disagree — still inside the write window, do not score.");
    console.log(JSON.stringify(m1));
  } else {
    // Discriminating pairs: `board` and `milestone` are both HASH fields of a
    // layout this schema serves (BoardCards hash=board; the 2026-07-23 multi-key
    // expand added MilestoneCards hash=milestone to the same field set). If the
    // gate is "the hash field", which of the two wins is not a detail.
    console.log("\n## Discriminating projections");
    for (
      const p of [
        ["board", "title"],
        ["title", "board"],
        ["milestone", "title"],
        ["title", "milestone"],
        ["board", "milestone"],
        ["slug", "title"],
        ["title", "slug"],
      ]
    ) {
      console.log(`  [${p.join(",")}] → ${label(await ranges(p))}`);
    }

    const shipped = boardCardsWireProjection([...BOARD_CARDS_LIST_FIELDS]);
    const noHash = ["slug", ...shipped.filter((f) => f !== "slug" && f !== "board")];
    const noMilestone = ["slug", ...shipped.filter((f) => f !== "slug" && f !== "milestone")];
    const neither = [
      "slug",
      ...shipped.filter((f) => f !== "slug" && f !== "board" && f !== "milestone"),
    ];
    console.log("\n## Product projections");
    for (
      const [name, p] of [
        ["as-shipped", shipped],
        ["minus board", noHash],
        ["minus milestone", noMilestone],
        ["minus both", neither],
        ["[slug]", ["slug"]],
      ] as const
    ) {
      const got = await ranges([...p]);
      console.log(`  ${name.padEnd(16)} lead=${p[0]!.padEnd(9)} ${got.size}/4  ${label(got)}`);
    }
  }
} finally {
  await cleanup();
}
