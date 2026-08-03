#!/usr/bin/env bun
/**
 * READ-ONLY probe: can a deletion path destroy a milestone's proof card?
 *
 * A milestone's `proof_card` is a live reference to a Card slug, and the write
 * side already treats it as one — `milestone state` refuses to advance a
 * milestone whose proof card is not found (`milestone_proof_card_not_found`),
 * and `milestone show` renders "Linked proof card X is missing" as a blocker.
 *
 * The DELETE side has no such guard:
 *
 *   rm <slug>            refuses when the card is a live DEPENDENCY, and only then
 *   groom archive-done   holds a live dependency back, and only that
 *
 * Neither knows what a proof card is. So the evidence a milestone's stored
 * `proof_status=passing` asserts can be deleted by a sweep that has no idea it
 * is deleting evidence, leaving a milestone that reads `complete`/`passing`
 * with a blocker column saying its proof is gone. That is exactly the shape of
 * [[papercut-kanban-milestone-proof-passing-with-no-proof-card]] — 18 of 42
 * milestones on the live primary.
 *
 * This probe does NOT claim deletion caused those 18. It measures the LIVE,
 * ONGOING exposure, which stands on its own regardless of history:
 *
 *   1. REFERENCES — how many milestones name a proof card, and how many
 *      distinct card slugs are named.
 *   2. RESOLVABLE — of those slugs, how many have a Card record today. A slug
 *      with no card is already-lost evidence.
 *   3. ARCHIVE EXPOSURE — proof cards sitting in a board's TERMINAL column,
 *      split by whether they are already past the archive cutoff. The ones past
 *      cutoff are what the next `groom archive-done --apply` would delete.
 *   4. RM EXPOSURE — of the proof cards that exist, how many would `rm` today
 *      let through, i.e. are not protected by the incidental dependency hold.
 *
 * Section 3 is the number that matters, and it is a MOVING one: a proof card in
 * `done` crosses the cutoff by doing nothing at all. A zero here is a statement
 * about this hour, not about the design.
 *
 * Writes nothing, deletes nothing.
 *
 *   bun scripts/probe-proof-card-delete-exposure.ts
 *   bun scripts/probe-proof-card-delete-exposure.ts 24   # cutoff hours
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import {
  boardTerminalMap,
  cardExists,
  listBoards,
  listCardStatuses,
  listCardsByColumn,
  listMilestones,
  FALLBACK_TERMINAL_COLUMN,
} from "../src/record.ts";
import { ARCHIVE_AGE_FIELDS, DEFAULT_ARCHIVE_CUTOFF_HOURS } from "../src/commands/archive_done.ts";

const cutoffHours = Number(process.argv[2] ?? DEFAULT_ARCHIVE_CUTOFF_HOURS);
const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const ageHours = (updatedAt: string, now: number): number | null => {
  const t = Date.parse(updatedAt);
  return Number.isFinite(t) ? (now - t) / 3_600_000 : null;
};

const boards = await listBoards(node, cfg);
const terminals = boardTerminalMap(boards);
const milestones = await listMilestones(node, cfg, { boards });

// ---- 1. references -------------------------------------------------------
const byProofSlug = new Map<string, string[]>();
for (const m of milestones) {
  const p = (m.proof_card ?? "").trim();
  if (!p) continue;
  byProofSlug.set(p, [...(byProofSlug.get(p) ?? []), m.slug]);
}
console.log(`\n=== 1. references ===`);
console.log(`  milestones total            ${milestones.length}`);
console.log(`  milestones naming a proof   ${milestones.filter((m) => (m.proof_card ?? "").trim()).length}`);
console.log(`  distinct proof card slugs   ${byProofSlug.size}`);

// ---- 2. resolvable -------------------------------------------------------
const exists = new Map<string, boolean>();
for (const slug of byProofSlug.keys()) {
  exists.set(slug, await cardExists(node, cfg, slug));
}
const present = [...exists.entries()].filter(([, v]) => v).map(([k]) => k);
const absent = [...exists.entries()].filter(([, v]) => !v).map(([k]) => k);
console.log(`\n=== 2. resolvable today ===`);
console.log(`  proof cards that EXIST      ${present.length}`);
console.log(`  proof cards ALREADY GONE    ${absent.length}   <- evidence a milestone still claims`);
for (const s of absent.slice(0, 8)) {
  console.log(`      missing: ${s}  (claimed by ${(byProofSlug.get(s) ?? []).join(", ")})`);
}
if (absent.length > 8) console.log(`      … and ${absent.length - 8} more`);

// ---- 3. archive exposure -------------------------------------------------
console.log(`\n=== 3. archive-done exposure (cutoff ${cutoffHours}h) ===`);
const now = Date.now();
let inTerminal = 0;
let pastCutoff = 0;
const pastList: string[] = [];
const beforeList: Array<{ slug: string; age: number }> = [];
for (const b of boards) {
  const terminal = terminals.get(b.slug) ?? FALLBACK_TERMINAL_COLUMN;
  const rows = await listCardsByColumn(node, cfg, terminal, ARCHIVE_AGE_FIELDS, b.slug);
  for (const card of rows) {
    if (!byProofSlug.has(card.slug)) continue;
    inTerminal += 1;
    const age = ageHours(card.updated_at ?? "", now);
    if (age !== null && age >= cutoffHours) {
      pastCutoff += 1;
      pastList.push(`${card.slug} (${Math.round(age)}h, board ${b.slug})`);
    } else if (age !== null) {
      beforeList.push({ slug: card.slug, age });
    }
  }
}
console.log(`  proof cards in a TERMINAL column      ${inTerminal}`);
console.log(`  …of those, already PAST the cutoff    ${pastCutoff}   <- next --apply deletes these`);
for (const s of pastList.slice(0, 10)) console.log(`      would delete: ${s}`);
if (beforeList.length > 0) {
  beforeList.sort((a, b) => b.age - a.age);
  const soonest = beforeList[0]!;
  console.log(
    `  nearest future exposure              ${soonest.slug} at ${Math.round(soonest.age)}h ` +
      `— crosses in ${Math.max(0, Math.round(cutoffHours - soonest.age))}h`,
  );
}

// ---- 4. rm exposure ------------------------------------------------------
const all = await listCardStatuses(node, cfg);
const depTargets = new Set<string>();
for (const c of all) for (const d of c.deps ?? []) depTargets.add(d);
const rmUnprotected = present.filter((s) => !depTargets.has(s));
console.log(`\n=== 4. rm exposure ===`);
console.log(`  existing proof cards                 ${present.length}`);
console.log(`  protected only incidentally (is a dep) ${present.length - rmUnprotected.length}`);
console.log(`  \`rm\` would delete without complaint  ${rmUnprotected.length}`);

console.log(
  `\nverdict: ${pastCutoff > 0 || rmUnprotected.length > 0 ? "EXPOSED" : "not exposed THIS HOUR"} — ` +
    `${rmUnprotected.length} proof card(s) deletable by \`rm\`, ${pastCutoff} sweepable by archive-done now.`,
);
