#!/usr/bin/env bun
/**
 * Settle the projection rule with CONSTRUCTED witnesses instead of found ones.
 *
 * `probe-projection-rule-inference.ts` scored three candidate rules against the
 * one live partial row left on the primary and got LEAD 4/1, ANY 3/2,
 * LEAD+KEY 5/0 — enough to falsify the two rules this repo's code is built on,
 * not enough to assert the third. Partial rows are rare and heal away, so
 * waiting to find more is waiting on a shrinking population.
 *
 * So build them. Each witness row is written with a KNOWN atom set (a narrow
 * `updateRecord` against a non-existent row stores exactly the subset sent —
 * the documented silent-upsert path), then every rule is scored against a full
 * projection matrix over those rows.
 *
 * ## Why this is inert on the primary
 *
 * Same argument `probeSchemaWritable` shipped on. The rows live under
 * `HashKey = PROBE_PARTITION`, a partition no product read addresses: every
 * MilestoneCards read is keyed by a live milestone slug (`HashKey: milestone`),
 * doctor's parity check enumerates milestones NAMED BY CARDS, and heal
 * enumerates the live board list. No card names this partition and no board
 * lists it. The rows are deleted at the end; a leaked one is inert and
 * addressable, and this script re-cleans on the next run.
 *
 *   bun scripts/probe-projection-rule-constructed.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { MILESTONE_CARDS_FIELDS } from "../src/schemas.ts";

const PROBE_PARTITION = "zzz-probe-projection-rule-do-not-use";
/** MilestoneCards: hash field `milestone`, range-key payload copy `sk`. */
const KEY_FIELDS = new Set(["milestone", "sk"]);

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const mcHash = cfg.schemaHashes!.milestone_cards!;

/**
 * Witness rows, each named by the atoms it carries. Chosen so that for every
 * rule pair there is a projection the two disagree about:
 *  - `full` — everything; no rule can drop it. Proves a read reached at all.
 *  - `noKey` — payload but neither key field.
 *  - `keyOnly` — both key fields and one payload field.
 *  - `sparse` — the shape of the live witness: a few payload fields, no keys.
 */
const WITNESSES: Record<string, string[]> = {
  full: [...MILESTONE_CARDS_FIELDS],
  noKey: MILESTONE_CARDS_FIELDS.filter((f) => !KEY_FIELDS.has(f)),
  keyOnly: ["milestone", "sk", "slug"],
  sparse: ["slug", "title", "column", "position"],
};
const sk = (name: string) => `probe#00000000#${name}`;

async function ranges(fields: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  const res = await node.queryAll({
    schemaHash: mcHash,
    fields,
    filter: { HashKey: PROBE_PARTITION },
  });
  for (const r of res.results ?? []) {
    if (typeof r.key?.range === "string" && r.key.range) out.add(r.key.range);
  }
  return out;
}

/**
 * Let a write settle before reading it back.
 *
 * The first cut of this probe learned each row's atoms immediately after
 * writing it and got a self-contradiction inside one run: the `["slug"]` read
 * in the learning pass denied rows that the `["slug"]` read in the matrix pass
 * returned seconds later. Same query, same rows, two answers — so the
 * disagreement was the read serving a pre-write tip, not a projection rule.
 * That is the write-side twin of the post-delete window recorded in
 * `lastdb-a-read-behind-a-delete-still-serves-the-pre-delete-tip`.
 *
 * Nothing here may be measured through that window, or the atom map the whole
 * scoring rests on is fiction.
 */
const settle = (ms = 9000) => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  for (const name of Object.keys(WITNESSES)) {
    try {
      await node.deleteRecord({ schemaHash: mcHash, keyHash: PROBE_PARTITION, rangeKey: sk(name) });
    } catch {
      /* already gone */
    }
  }
}

let wrote = false;
try {
  await cleanup(); // in case a prior run leaked
  for (const [name, fields] of Object.entries(WITNESSES)) {
    const payload: Record<string, unknown> = {};
    for (const f of fields) {
      payload[f] = f === "milestone"
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
      schemaHash: mcHash,
      keyHash: PROBE_PARTITION,
      rangeKey: sk(name),
      fields: payload,
    });
    wrote = true;
  }
  await settle();

  // Verify the constructed atom sets rather than trusting the write: a single
  // field read returns exactly the rows carrying it under every candidate rule.
  const learnAtoms = async () => {
    const m = new Map<string, Set<string>>();
    for (const f of MILESTONE_CARDS_FIELDS) {
      for (const r of await ranges([f])) {
        let s = m.get(r);
        if (!s) m.set(r, (s = new Set()));
        s.add(f);
      }
    }
    return m;
  };
  const fingerprint = (m: Map<string, Set<string>>) =>
    [...m.entries()].map(([k, v]) => `${k}:${[...v].sort().join(",")}`).sort().join("|");

  // Learn twice, with a settle in between, and refuse to score unless the two
  // agree. This is the only thing standing between "the node applies rule X"
  // and "I measured a row mid-flight and wrote down the transient".
  const first = await learnAtoms();
  await settle();
  const atoms = await learnAtoms();
  if (fingerprint(first) !== fingerprint(atoms)) {
    console.log("UNSTABLE: two atom-learning passes disagreed — still inside the write window.");
    console.log(`  pass 1: ${[...first].map(([k, v]) => `${k.split("#").pop()}=${v.size}`).join(" ")}`);
    console.log(`  pass 2: ${[...atoms].map(([k, v]) => `${k.split("#").pop()}=${v.size}`).join(" ")}`);
    throw new Error("atom map not stable; not scoring");
  }

  console.log("constructed rows (atoms confirmed by two agreeing single-field passes):");
  for (const name of Object.keys(WITNESSES)) {
    const got = atoms.get(sk(name));
    const want = WITNESSES[name]!.length;
    console.log(`  ${name.padEnd(8)} wanted ${String(want).padStart(2)} atoms, reads back ${String(got?.size ?? 0).padStart(2)}`);
  }
  console.log();

  const rows = Object.keys(WITNESSES).map(sk).filter((r) => atoms.has(r));
  const hasAtom = (r: string, f: string) => atoms.get(r)?.has(f) ?? false;

  const RULES = [
    { name: "LEAD", keeps: (r: string, p: string[]) => hasAtom(r, p[0]!) },
    { name: "ANY", keeps: (r: string, p: string[]) => p.every((f) => hasAtom(r, f)) },
    {
      name: "LEAD+KEY",
      keeps: (r: string, p: string[]) =>
        hasAtom(r, p[0]!) && p.every((f) => !KEY_FIELDS.has(f) || hasAtom(r, f)),
    },
    { name: "KEY-ONLY", keeps: (r: string, p: string[]) => p.every((f) => !KEY_FIELDS.has(f) || hasAtom(r, f)) },
    // The three above are the rules the repo has believed. The three below are
    // what the first constructed matrix's counterexamples actually imply:
    //   - `[slug,milestone]` dropped `noKey`  -> the HASH field gates wherever
    //     it sits in the projection, not just when it leads.
    //   - `[slug,sk]` kept `noKey`            -> the RANGE-key payload copy
    //     does not gate at all, so "key fields" was too broad.
    //   - `[title,milestone]` kept `keyOnly`  -> an absent LEAD does not drop a
    //     row on its own, so the lead is not the gate either.
    { name: "SOME", keeps: (r: string, p: string[]) => p.some((f) => hasAtom(r, f)) },
    {
      name: "HASH+SOME",
      keeps: (r: string, p: string[]) =>
        (!p.includes("milestone") || hasAtom(r, "milestone")) && p.some((f) => hasAtom(r, f)),
    },
    {
      name: "HASH+LEAD",
      keeps: (r: string, p: string[]) =>
        (!p.includes("milestone") || hasAtom(r, "milestone")) && hasAtom(r, p[0]!),
    },
    // HASH+LEAD's only misses were all `[<absent field>, milestone]` on a row
    // that HAS `milestone` — returned, though the lead was absent. So the hash
    // field does not ADD a condition to the lead; when it is projected it
    // REPLACES the lead as the gate. One gate, chosen by whether the hash field
    // is in the projection at all.
    {
      name: "HASH-ELSE-LEAD",
      keeps: (r: string, p: string[]) =>
        p.includes("milestone") ? hasAtom(r, "milestone") : hasAtom(r, p[0]!),
    },
  ];

  // Projection matrix: every ordered pair drawn from a spread of field roles,
  // plus the two full-width reads the product actually issues.
  const SAMPLE = ["slug", "title", "milestone", "sk", "kind", "layout", "board"];
  const projections: string[][] = [];
  for (const a of SAMPLE) {
    projections.push([a]);
    for (const b of SAMPLE) if (a !== b) projections.push([a, b]);
  }
  projections.push([...MILESTONE_CARDS_FIELDS]);
  projections.push(["slug", ...MILESTONE_CARDS_FIELDS.filter((f) => f !== "slug")]);

  const score = new Map(RULES.map((r) => [r.name, { ok: 0, bad: 0, ex: [] as string[] }]));
  let decisive = 0;
  for (const p of projections) {
    const observed = await ranges(p);
    for (const r of rows) {
      const preds = RULES.map((rule) => rule.keeps(r, p));
      if (new Set(preds).size > 1) decisive++;
      const actual = observed.has(r);
      RULES.forEach((rule, i) => {
        const s = score.get(rule.name)!;
        if (preds[i] === actual) s.ok++;
        else {
          s.bad++;
          if (s.ex.length < 3) {
            s.ex.push(`[${p.slice(0, 4).join(",")}${p.length > 4 ? ",…" : ""}] on ${r.split("#").pop()} — said ${preds[i]}, was ${actual}`);
          }
        }
      });
    }
  }

  console.log(`${projections.length} projections x ${rows.length} rows; ${decisive} rule-discriminating judgements\n`);
  for (const rule of RULES) {
    const s = score.get(rule.name)!;
    console.log(`${rule.name.padEnd(10)} ${String(s.ok).padStart(3)} correct / ${s.bad} wrong`);
    for (const e of s.ex) console.log(`    ${e}`);
  }
  const clean = RULES.filter((r) => score.get(r.name)!.bad === 0).map((r) => r.name);
  console.log(
    `\n${clean.length ? `CONSISTENT WITH: ${clean.join(", ")}` : "NO CANDIDATE RULE FITS"}`,
  );
} finally {
  if (wrote) {
    await cleanup();
    // Same window on the delete side — a read behind a delete serves the
    // pre-delete tip, so an immediate check reports a leak that is not there.
    await settle();
    const left = await ranges(["slug"]);
    console.log(`\ncleanup: ${left.size === 0 ? "partition empty" : `LEAKED ${left.size} row(s) — inert, re-cleaned next run`}`);
  }
}
