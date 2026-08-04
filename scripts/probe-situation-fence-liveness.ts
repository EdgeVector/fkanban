#!/usr/bin/env bun
/**
 * READ-ONLY probe: can the Situation fence in `pickup status` fire at all?
 *
 * `probe-pickup-fence-spawn-fanout.ts` measured ZERO preflight calls on a board
 * with 16 pickup-ready cards. Two very different explanations produce that same
 * zero, and a gate is only trustworthy if you can tell them apart:
 *
 *   IDLE    — the fence works, and no card in scope is an `EdgeVector/fold`
 *             card about node work today.
 *   DEAD    — the fence cannot fire for a card that IS in scope, because the
 *             text it matches on is not in the record it is handed.
 *
 * `inferSituationPreflightActions` matches needles against `card.body`, but
 * board lists are body-free by design and `pickup status` hydrates bodies only
 * for the cards `pickupClassificationNeedsBody` selects — a predicate that knows
 * nothing about the fence. So the DEAD case is reachable whenever a fold card is
 * pickup-ready and the classifier did not happen to want its body.
 *
 * This re-reads each in-scope card's body directly and asks the SAME question
 * twice: once against the record `pickup status` actually fences, and once
 * against the full record. A disagreement is the bug.
 *
 * Run: bun scripts/probe-situation-fence-liveness.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { listBoards, listCards, findCard, resolvePickupRepo } from "../src/record.ts";
import { buildPickupStatusReportWithSituations } from "../src/pickup.ts";
import { inferSituationPreflightActions } from "../src/situations.ts";
import { TERMINAL_COLUMN } from "../src/record.ts";
const activeCards = (cs: import("../src/record.ts").Card[]) => cs.filter((c) => c.column !== TERMINAL_COLUMN);

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const boards = await listBoards(node, cfg);
const cards = await listCards(node, cfg, { boards, activeOnly: true });

// The exact report `pickup status` builds, including its selective hydrate.
const report = await buildPickupStatusReportWithSituations(cards, undefined, { cfg, node });
const ready = new Set(
  report.cards.filter((c) => c.category === "pickup-ready").map((c) => c.slug),
);

// The records the fence is actually handed, keyed the same way pickup.ts keys them.
const fenced = activeCards(cards).filter((c) => ready.has(c.slug));

const byRepo = new Map<string, number>();
for (const c of activeCards(cards)) {
  const r = resolvePickupRepo(c);
  const key = r.ok ? r.repo : "<unresolved>";
  byRepo.set(key, (byRepo.get(key) ?? 0) + 1);
}
console.log(`active cards=${activeCards(cards).length}  pickup-ready=${fenced.length}`);
console.log("repos across ALL active cards:");
for (const [repo, n] of [...byRepo.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  ${repo.padEnd(28)} ${n}`);
}

// Does any card in scope carry a body at the moment the fence inspects it?
const withBody = fenced.filter((c) => (c.body ?? "").length > 0).length;
console.log(`\npickup-ready cards carrying a body when fenced: ${withBody}/${fenced.length}`);

// The PROJECTION GAP: what the thin record can infer vs what the full record
// can. This is a property of the board and the schema, not of the fix — it stays
// nonzero forever, because bodies are not on the BoardCards projection and
// should not be. Reported so the next reader does not mistake it for a
// regression, and so the check below has something to be measured against.
console.log("\nprojection gap — thin record vs FULL record (expected nonzero; not a bug by itself):");
let gap = 0;
const gapSlugs = new Set<string>();
for (const card of fenced) {
  const asThin = inferSituationPreflightActions(card);
  const full = await findCard(node, cfg, card.slug);
  const asFull = full ? inferSituationPreflightActions(full) : [];
  const repo = resolvePickupRepo(card);
  if (asThin.length !== asFull.length) {
    gap += 1;
    gapSlugs.add(card.slug);
    console.log(
      `  · ${card.slug}  repo=${repo.ok ? repo.repo : "-"}  ` +
        `thin=[${asThin.join(",")}] full=[${asFull.join(",")}]  bodyLen(thin)=${(card.body ?? "").length} bodyLen(full)=${(full?.body ?? "").length}`,
    );
  }
}
console.log(`  ${gap} pickup-ready card(s) whose fence verdict needs a body the list does not carry`);

// THE REGRESSION ARM: does the shipped path close that gap? The section above
// can be nonzero forever; this one may not. Before the 2026-08-04 fix the real
// report issued ZERO preflight calls on this board.
//
// Counted from the calls the report ACTUALLY makes — the preflight callback is
// the only honest witness here, because it is the thing the fence invokes.
// Deriving "preflighted" from the full records instead would just re-ask the
// question this probe exists to answer, and would print a pass whether or not
// the fix was present.
console.log("\nshipped path — preflight calls issued by the real report:");
const issued: string[] = [];
await buildPickupStatusReportWithSituations(
  cards,
  async ({ action, repo }) => {
    issued.push(`${repo}:${action}`);
    return { ok: true };
  },
  { cfg, node },
);
// Each in-scope card contributes one call per inferred action, and every action
// is checked when none of them block — so a floor of one call per gap card is
// the weakest claim the count can support without knowing which slug made it.
console.log(`  ${issued.length} call(s): ${[...new Set(issued)].join(", ") || "(none)"}`);
console.log(
  issued.length >= gap
    ? `  ✓ at least one preflight per gap card (${issued.length} >= ${gap})`
    : `  ✗ ${gap} card(s) need a fence verdict but only ${issued.length} preflight call(s) were made`,
);

// Widen to ANY active fold card, ready or not, to size the projection gap
// against the fence's whole potential population rather than today's ready set.
//
// These are NOT waived cards. A card that is dependency-blocked, human-gated or
// malformed is not going to be picked up whatever a Situation says, so the fix
// deliberately buys bodies only for the READY set (see the `situationFenceNeedsBody`
// docstring). This number's job is to show how much the ready set can grow into
// — if it climbs far above the ready count, revisit that scoping decision.
const foldCards = activeCards(cards).filter((c) => {
  const r = resolvePickupRepo(c);
  return r.ok && r.repo === "EdgeVector/fold";
});
console.log(`\nactive EdgeVector/fold cards: ${foldCards.length}`);
let wouldFire = 0;
let thinCannotSee = 0;
for (const card of foldCards) {
  const asThin = inferSituationPreflightActions(card);
  const full = await findCard(node, cfg, card.slug);
  const asFull = full ? inferSituationPreflightActions(full) : [];
  if (asFull.length > 0) wouldFire += 1;
  if (asFull.length > 0 && asThin.length === 0) thinCannotSee += 1;
}
console.log(`  would infer an action on the FULL record:      ${wouldFire}`);
console.log(`  of those, invisible to the thin projection:    ${thinCannotSee}`);
console.log(`  (fenced today only if also pickup-ready: ${gap})`);
