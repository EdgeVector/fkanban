#!/usr/bin/env bun
/**
 * How long after `add` returns can `search` first find the card?
 *
 * Sizes the visibility wait against the lag it has to cover instead of guessing.
 * Polls the two sources `indexedSearchCards` reads until whichever comes first
 * can see the slug, with no cap short enough to hide the tail.
 *
 * Writes ONLY to a scratch board and removes each card it creates.
 * NO CATCH AROUND THE READS.
 *
 * Run: bun scripts/probe-search-lag-distribution.ts
 */
import { readConfig, schemaHashFor } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoardCardsPartition, BOARD_CARDS_SEARCH_FIELDS } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const BOARD = process.env.PROBE_BOARD || "agent-dogfood-scratch";
const CLI = process.env.PROBE_CLI || "kanban";
const ROUNDS = Number(process.env.PROBE_ROUNDS || "6");
const CAP_MS = Number(process.env.PROBE_CAP_MS || "60000");
const cardSchema = schemaHashFor("card", cfg);

async function keyListHas(slug: string): Promise<boolean> {
  let cursor: string | null = null;
  for (;;) {
    const page = await node.listRecordKeys!(cardSchema, { limit: 1000, cursor });
    if (page.keys.some((k) => k.hash === slug)) return true;
    if (!page.has_more || !page.next_cursor || page.next_cursor === cursor) return false;
    cursor = page.next_cursor;
  }
}

const partitionAt: number[] = [];
const eitherAt: number[] = [];

for (let round = 1; round <= ROUNDS; round++) {
  const stamp = Date.now();
  const slug = `probe-lagdist-${stamp}`;
  const proc = Bun.spawn(
    [CLI, "add", slug, "--title", `find me probetok${stamp}`, "--board", BOARD,
      "--column", "todo", "--force", "--tags", "kstress", "--repo", "EdgeVector/fold"],
    { stdout: "pipe", stderr: "pipe" },
  );
  if ((await proc.exited) !== 0) {
    console.log(`round ${round}: add failed`);
    continue;
  }

  const t0 = performance.now();
  let partition = -1;
  let either = -1;
  while (performance.now() - t0 < CAP_MS && (partition < 0 || either < 0)) {
    const rows = await listBoardCardsPartition(node, cfg, BOARD, {
      fields: BOARD_CARDS_SEARCH_FIELDS,
    });
    const inPartition = rows?.some((row) => row.slug === slug) ?? false;
    const el = Math.round(performance.now() - t0);
    if (partition < 0 && inPartition) partition = el;
    if (either < 0 && (inPartition || (await keyListHas(slug)))) {
      either = Math.round(performance.now() - t0);
    }
    if (partition < 0 || either < 0) await new Promise((r) => setTimeout(r, 100));
  }
  partitionAt.push(partition);
  eitherAt.push(either);
  console.log(`round ${round}: either=${either}ms partition=${partition}ms (-1 = never in ${CAP_MS}ms)`);
  Bun.spawnSync([CLI, "rm", slug], { stdout: "ignore", stderr: "ignore" });
}

const summarize = (label: string, xs: number[]) => {
  const ok = xs.filter((x) => x >= 0).sort((a, b) => a - b);
  const never = xs.length - ok.length;
  if (ok.length === 0) {
    console.log(`${label}: never visible in ${xs.length} rounds`);
    return;
  }
  console.log(
    `${label}: min=${ok[0]}ms median=${ok[Math.floor(ok.length / 2)]}ms max=${ok[ok.length - 1]}ms never=${never}`,
  );
};
console.log("");
summarize("either source", eitherAt);
summarize("partition    ", partitionAt);
