#!/usr/bin/env bun
/**
 * READ-ONLY probe: WHY does each card force a body hydration on `pickup status`?
 *
 * `pickupClassificationNeedsBody` has two independent triggers, and they call
 * for opposite fixes:
 *
 *   missing-structured-repo-base — a `pr` card whose `repo`/`base` columns are
 *       empty, so the classifier has to parse the body's `Repo:`/`Base:`
 *       headers. This is DATA DRIFT: the structured fields exist on BoardCards
 *       and a backfill removes the read entirely.
 *   done-when-kind — a validation-ish kind whose DONE-WHEN lives only in prose.
 *       No backfill fixes this; the body genuinely is the source of truth.
 *
 * Reporting the mix is the point: a hydration count alone cannot tell you
 * whether to backfill data or to change the code.
 *
 * Run: bun scripts/probe-hydrate-reason.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards } from "../src/record.ts";
import { pickupClassificationNeedsBody } from "../src/pickup.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards });
const terminalByBoard = new Map(boards.map((b) => [b.slug, b.columns[b.columns.length - 1] ?? "done"]));
const active = cards.filter((c) => c.column !== (terminalByBoard.get(c.board) ?? "done"));
const needy = active.filter(pickupClassificationNeedsBody);

console.log(`active=${active.length}  needing hydration=${needy.length}\n`);

const missingRepoBase = needy.filter((c) => c.repo.trim() === "" || c.base.trim() === "");
const doneWhenKind = needy.filter((c) => !(c.repo.trim() === "" || c.base.trim() === ""));

const tally = (xs: typeof needy) => {
  const t: Record<string, number> = {};
  for (const c of xs) t[`${c.board}/${c.column} kind=${c.kind || "(empty)"}`] = (t[`${c.board}/${c.column} kind=${c.kind || "(empty)"}`] ?? 0) + 1;
  return t;
};

console.log(`missing structured repo/base (backfillable): ${missingRepoBase.length}`);
console.log(tally(missingRepoBase));
for (const c of missingRepoBase.slice(0, 12)) {
  console.log(`   ${c.slug}  repo="${c.repo}" base="${c.base}" kind="${c.kind}"`);
}

console.log(`\nDONE-WHEN kinds (body is genuinely the truth): ${doneWhenKind.length}`);
console.log(tally(doneWhenKind));
for (const c of doneWhenKind.slice(0, 12)) {
  console.log(`   ${c.slug}  kind="${c.kind}"`);
}
