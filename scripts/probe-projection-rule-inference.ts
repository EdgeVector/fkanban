#!/usr/bin/env bun
/**
 * Infer the node's projection rule from live rows instead of asserting one.
 *
 * Three rules are in play, and this repo has shipped code on the first:
 *
 *   LEAD        a row returns iff the FIRST projected field has an atom.
 *               Stated by `sweepMilestoneCardsPartition`, relied on by
 *               `boardCardsWireProjection` (which preserves `fields[0]`
 *               verbatim so narrowing "cannot touch the gate").
 *   ANY         a row returns iff EVERY projected field has an atom.
 *               `test/fake-node.ts`'s default, described there as a deliberate
 *               over-approximation of the node.
 *   LEAD+KEY    LEAD, plus every projected KEY field (partition key, range-key
 *               payload copy) must also have an atom.
 *
 * `probe-projection-lead-vs-any-missing.ts` produced one row that refutes LEAD
 * and ANY at once: `[title,kind]` returned it with `kind` absent (not ANY), and
 * `[slug,milestone]` dropped it with `slug` leading (not LEAD).
 *
 * One row cannot settle a rule, so this enumerates a whole partition, learns
 * each row's atom set from single-field projections, then scores every rule
 * against many multi-field projections. A rule is only as good as the cases
 * that could have falsified it, so the case list deliberately mixes
 * present/absent leads with present/absent trailing fields.
 *
 * Read-only.
 *
 *   bun scripts/probe-projection-rule-inference.ts [partition] [schema]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_MILESTONES_FIELDS, MILESTONE_CARDS_FIELDS } from "../src/schemas.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const mcHash = cfg.schemaHashes!.milestone_cards!;
const bmHash = cfg.schemaHashes?.board_milestones;

/** MilestoneCards: hash is `milestone`, range is `sk`. */
const KEY_FIELDS = new Set(["milestone", "sk"]);
const FIELDS = [...MILESTONE_CARDS_FIELDS];

async function rangesFor(fields: string[], part: string): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await node.queryAll({ schemaHash: mcHash, fields, filter: { HashKey: part } });
  for (const r of res.results ?? []) {
    if (typeof r.key?.range === "string" && r.key.range) out.add(r.key.range);
  }
  return out;
}

// Pick the partition with the most partial rows unless one was named.
let partition = process.argv[2] ?? "";
if (!partition) {
  const parts: string[] = [];
  if (bmHash) {
    const res = await node.queryAll({
      schemaHash: bmHash,
      fields: [...BOARD_MILESTONES_FIELDS],
      filter: { HashKey: "default" },
    });
    for (const r of res.results ?? []) {
      const s = String((r.fields ?? {}).slug ?? "");
      if (s) parts.push(s);
    }
  }
  let best = { part: "", partial: -1 };
  for (const p of parts) {
    const all = await rangesFor(["slug"], p);
    if (all.size < 3) continue;
    const layout = await rangesFor(["layout"], p);
    const partial = all.size - layout.size;
    if (partial > best.partial) best = { part: p, partial };
  }
  partition = best.part || parts[0] || "";
}
if (!partition) {
  console.log("no live milestone partition found");
  process.exit(0);
}

// Learn each row's atom set: one single-field projection per field. Under all
// three rules a single-field read returns exactly the rows carrying it.
const atoms = new Map<string, Set<string>>();
for (const f of FIELDS) {
  for (const sk of await rangesFor([f], partition)) {
    let s = atoms.get(sk);
    if (!s) atoms.set(sk, (s = new Set()));
    s.add(f);
  }
}
const rows = [...atoms.keys()].sort();
console.log(`partition ${partition} — ${rows.length} rows reachable by some single field`);
const partialRows = rows.filter((sk) => atoms.get(sk)!.size < FIELDS.length);
console.log(`partial rows (missing >=1 atom): ${partialRows.length}\n`);

// Build test projections. Each is a real question only if some row disagrees
// between the rules — otherwise it scores everything equally and proves nothing.
const cases: string[][] = [];
for (const sk of partialRows.slice(0, 6)) {
  const have = FIELDS.filter((f) => atoms.get(sk)!.has(f));
  const lack = FIELDS.filter((f) => !atoms.get(sk)!.has(f));
  if (have.length === 0 || lack.length === 0) continue;
  const lackKey = lack.filter((f) => KEY_FIELDS.has(f));
  const lackPlain = lack.filter((f) => !KEY_FIELDS.has(f));
  if (lackPlain.length) {
    cases.push([have[0]!, lackPlain[0]!]);            // LEAD:keep ANY:drop
    cases.push([lackPlain[0]!, have[0]!]);            // LEAD:drop ANY:drop
  }
  if (lackKey.length) {
    cases.push([have[0]!, lackKey[0]!]);              // LEAD:keep ANY:drop KEY:drop
  }
  if (have.length > 1) cases.push([have[0]!, have[1]!]); // all rules: keep
  if (lackPlain.length > 1) cases.push([have[0]!, lackPlain[0]!, lackPlain[1]!]);
}
// De-dup while preserving order.
const seen = new Set<string>();
const projections = cases.filter((c) => {
  const k = c.join("|");
  if (seen.has(k)) return false;
  seen.add(k);
  return true;
});

type Rule = { name: string; keeps: (sk: string, p: string[]) => boolean };
const has = (sk: string, f: string) => atoms.get(sk)!.has(f);
const RULES: Rule[] = [
  { name: "LEAD", keeps: (sk, p) => has(sk, p[0]!) },
  { name: "ANY", keeps: (sk, p) => p.every((f) => has(sk, f)) },
  {
    name: "LEAD+KEY",
    keeps: (sk, p) => has(sk, p[0]!) && p.every((f) => !KEY_FIELDS.has(f) || has(sk, f)),
  },
];

const score = new Map(RULES.map((r) => [r.name, { ok: 0, bad: 0, examples: [] as string[] }]));
let decisive = 0;

for (const p of projections) {
  const observed = await rangesFor(p, partition);
  // Only rows this partition actually has can be judged.
  for (const sk of rows) {
    const predictions = RULES.map((r) => r.keeps(sk, p));
    if (new Set(predictions).size > 1) decisive++;
    const actual = observed.has(sk);
    RULES.forEach((r, i) => {
      const s = score.get(r.name)!;
      if (predictions[i] === actual) s.ok++;
      else {
        s.bad++;
        if (s.examples.length < 3) {
          s.examples.push(`[${p.join(",")}] on ${sk.slice(0, 44)} — said ${predictions[i]}, was ${actual}`);
        }
      }
    });
  }
}

console.log(`${projections.length} projections x ${rows.length} rows; ${decisive} rule-discriminating judgements\n`);
for (const r of RULES) {
  const s = score.get(r.name)!;
  console.log(`${r.name.padEnd(10)} ${s.ok} correct / ${s.bad} wrong`);
  for (const e of s.examples) console.log(`    ${e}`);
}
const winner = RULES.map((r) => ({ r, s: score.get(r.name)! })).sort((a, b) => a.s.bad - b.s.bad)[0]!;
console.log(
  `\n${winner.s.bad === 0 ? `CONSISTENT WITH: ${winner.r.name}` : "NO CANDIDATE RULE FITS — the real rule is none of these three."}`,
);
