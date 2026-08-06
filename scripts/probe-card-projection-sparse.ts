#!/usr/bin/env bun
/**
 * Settle whether a genuinely SPARSE live Card row survives a wide projection.
 *
 * `cardExists` and `PROOF_CARD_FIELDS` are both justified in prose by a rule —
 * "LastDB returns a row only when EVERY projected field has an atom on it" —
 * that `test/fake-node.ts` marks superseded and replaces with HASH-ELSE-LEAD.
 * `probe-projection-rule-constructed.ts` settled that on **MilestoneCards**
 * (HashRange, hash field `milestone`). Nothing had settled it on **Card**,
 * which is the schema those guards actually read, and whose hash field `slug`
 * is projected by every card read there is.
 *
 * The gap the papercut named: no product path can MANUFACTURE a sparse Card —
 * `kanban add` writes an atom for every field, empty ones included — so the
 * failure mode the guard defends against had never been observed on this
 * schema, in either direction. A narrow `updateRecord` against a
 * non-existent row stores exactly the subset sent (the documented silent-upsert
 * path), which is the only way to build one.
 *
 * ## Why this is inert on the primary
 *
 * Weaker argument than the MilestoneCards probe's and worth stating plainly:
 * Card is a HASH schema, so every row is its OWN partition and there is no
 * unaddressed partition to hide in. A full Card scan — `writeCardListIndex`,
 * `seedBoardCards` — would see these rows while they exist.
 *
 * So the exposure is bounded three ways instead:
 *   1. Every witness carries a `board` atom naming a board that does not exist
 *      (`PROBE_BOARD`). A concurrent seed lands membership in an inert
 *      partition, not in `default` — the empty-`board`-resolves-to-default path
 *      is never taken.
 *   2. Slugs are `zzz-probe-card-proj-*`, sorted last and self-describing.
 *   3. Rows are deleted at the end and re-cleaned at the start of the next run;
 *      the script prints a post-cleanup census so a leak is loud.
 *
 *   bun scripts/probe-card-projection-sparse.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { CARD_FIELDS } from "../src/schemas.ts";
import { cardExists, findCard } from "../src/record.ts";

const PREFIX = "zzz-probe-card-proj";
/** A board no board record names, so an accidental seed is inert. */
const PROBE_BOARD = `${PREFIX}-board-do-not-use`;
/** Card is a HASH schema keyed on `slug`. That is the only key field. */
const HASH_FIELD = "slug";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});
const cardHash = cfg.schemaHashes!.card!;

const ALL = [...CARD_FIELDS] as string[];

/**
 * Witness rows, each named by the atoms it carries.
 *
 *  - `full`    — all 23. No rule can drop it; proves a read reached at all.
 *  - `sparse`  — THE case the papercut is about: a live row with `slug` and a
 *                handful of payload fields, and no atom at all on the other 18
 *                (including `assignee`, the docstring's own example).
 *  - `noHash`  — every field except `slug`. Isolates whether the hash field is
 *                the gate, independent of sparseness.
 *  - `hashOnly`— `slug` alone: the husk shape `isKeyOnlyRow` now filters.
 */
const WITNESSES: Record<string, string[]> = {
  full: ALL,
  sparse: ["slug", "title", "board", "column", "position"],
  noHash: ALL.filter((f) => f !== HASH_FIELD),
  hashOnly: ["slug"],
};
const slugOf = (name: string) => `${PREFIX}-${name}`;

const LIST_FIELDS = ["tags", "deps", "surfaces"];

function payloadFor(name: string, fields: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of fields) {
    out[f] = f === "slug"
      ? slugOf(name)
      : f === "board"
        ? PROBE_BOARD
        : LIST_FIELDS.includes(f)
          ? []
          : `v-${f}`;
  }
  return out;
}

/** Does a point read on `slug` with this projection return the row? */
async function pointReadReturns(slug: string, fields: string[]): Promise<boolean> {
  const res = await node.queryAll({
    schemaHash: cardHash,
    fields,
    filter: { HashKey: slug },
  });
  return (res.results ?? []).length > 0;
}

/**
 * Let a write settle before reading it back.
 *
 * Lifted verbatim in spirit from `probe-projection-rule-constructed.ts`: a read
 * issued inside the write window serves the pre-write tip, and an atom map
 * learned through that window is fiction — which would silently corrupt every
 * rule judgement downstream of it.
 */
const settle = (ms = 9000) => new Promise((r) => setTimeout(r, ms));

async function cleanup(): Promise<void> {
  for (const name of Object.keys(WITNESSES)) {
    try {
      await node.deleteRecord({ schemaHash: cardHash, keyHash: slugOf(name) });
    } catch {
      /* already gone */
    }
  }
}

/** Single-field point reads: exactly the rows carrying that atom, under every candidate rule. */
async function learnAtoms(): Promise<Map<string, Set<string>>> {
  const m = new Map<string, Set<string>>();
  for (const name of Object.keys(WITNESSES)) {
    const slug = slugOf(name);
    const s = new Set<string>();
    for (const f of ALL) {
      if (await pointReadReturns(slug, [f])) s.add(f);
    }
    if (s.size > 0) m.set(name, s);
  }
  return m;
}

const fingerprint = (m: Map<string, Set<string>>) =>
  [...m.entries()].map(([k, v]) => `${k}:${[...v].sort().join(",")}`).sort().join("|");

let wrote = false;
try {
  await cleanup(); // in case a prior run leaked
  for (const [name, fields] of Object.entries(WITNESSES)) {
    await node.updateRecord({
      schemaHash: cardHash,
      keyHash: slugOf(name),
      fields: payloadFor(name, fields),
    });
    wrote = true;
  }
  await settle();

  // Two agreeing passes, or refuse to score. One pass cannot tell "the node
  // applies rule X" from "I read a row mid-flight".
  const first = await learnAtoms();
  await settle();
  const atoms = await learnAtoms();
  if (fingerprint(first) !== fingerprint(atoms)) {
    console.log("UNSTABLE: two atom-learning passes disagreed — still inside the write window.");
    console.log(`  pass 1: ${[...first].map(([k, v]) => `${k}=${v.size}`).join(" ")}`);
    console.log(`  pass 2: ${[...atoms].map(([k, v]) => `${k}=${v.size}`).join(" ")}`);
    throw new Error("atom map not stable; not scoring");
  }

  console.log("constructed rows (atoms confirmed by two agreeing single-field passes):");
  for (const name of Object.keys(WITNESSES)) {
    const got = atoms.get(name);
    const want = WITNESSES[name]!.length;
    const mark = got?.size === want ? " " : "!";
    console.log(
      `${mark} ${name.padEnd(9)} wanted ${String(want).padStart(2)} atoms, reads back ${String(got?.size ?? 0).padStart(2)}`,
    );
  }
  console.log();

  const names = Object.keys(WITNESSES).filter((n) => atoms.has(n));
  const hasAtom = (n: string, f: string) => atoms.get(n)?.has(f) ?? false;

  // ── The decisive read ────────────────────────────────────────────────────
  // This is the whole question. `findCard` projects all 23 fields; if `sparse`
  // comes back, a wide Card read cannot false-negative on a sparse row and the
  // rule the prose asserts is dead for this schema too.
  console.log(`decisive: full ${ALL.length}-field point read (what \`findCard\` projects)`);
  for (const name of names) {
    const raw = await pointReadReturns(slugOf(name), ALL);
    const card = await findCard(node, cfg, slugOf(name));
    const exists = await cardExists(node, cfg, slugOf(name));
    console.log(
      `  ${name.padEnd(9)} atoms=${String(atoms.get(name)!.size).padStart(2)}/23` +
        `  raw wide read: ${raw ? "RETURNED" : "dropped  "}` +
        `  findCard: ${card ? "found" : "null "}` +
        `  cardExists: ${exists}`,
    );
  }
  console.log();

  // ── Rule scoring ─────────────────────────────────────────────────────────
  // Same rule set as `probe-projection-rule-constructed.ts` so the two probes'
  // verdicts are directly comparable across schemas. On Card the hash field is
  // `slug`, and there is no range-key payload copy, so LEAD+KEY and KEY-ONLY
  // collapse onto the `slug` gate.
  const RULES = [
    { name: "LEAD", keeps: (n: string, p: string[]) => hasAtom(n, p[0]!) },
    { name: "ANY", keeps: (n: string, p: string[]) => p.every((f) => hasAtom(n, f)) },
    { name: "SOME", keeps: (n: string, p: string[]) => p.some((f) => hasAtom(n, f)) },
    {
      name: "HASH-ELSE-LEAD",
      keeps: (n: string, p: string[]) =>
        p.includes(HASH_FIELD) ? hasAtom(n, HASH_FIELD) : hasAtom(n, p[0]!),
    },
  ];

  // Projections chosen so every rule pair disagrees somewhere: the hash field
  // leading, trailing, and absent; present and absent payload fields; and the
  // two widths the product actually uses (1 = `cardExists`, 23 = `findCard`).
  const PROJECTIONS: string[][] = [
    ["slug"],
    ["title"],
    ["assignee"],
    ["slug", "title"],
    ["title", "slug"],
    ["slug", "assignee"],
    ["assignee", "slug"],
    ["title", "assignee"],
    ["assignee", "title"],
    ["title", "board", "column"],
    ["assignee", "board", "column"],
    ["slug", "board", "column", "milestone", "tags", "body"], // PROOF_CARD_FIELDS
    ALL,
  ];

  const scores = new Map(RULES.map((r) => [r.name, { hit: 0, miss: 0 }]));
  const disagreements: string[] = [];
  for (const proj of PROJECTIONS) {
    for (const name of names) {
      const observed = await pointReadReturns(slugOf(name), proj);
      for (const rule of RULES) {
        const s = scores.get(rule.name)!;
        if (rule.keeps(name, proj) === observed) s.hit++;
        else {
          s.miss++;
          if (rule.name === "ANY" || rule.name === "HASH-ELSE-LEAD") {
            disagreements.push(
              `    ${rule.name.padEnd(14)} ${name.padEnd(9)} [${proj.length > 6 ? `${proj.length} fields` : proj.join(",")}]` +
                ` predicted ${rule.keeps(name, proj) ? "kept" : "dropped"}, node ${observed ? "kept" : "dropped"}`,
            );
          }
        }
      }
    }
  }

  const total = PROJECTIONS.length * names.length;
  console.log(`rule scores over ${PROJECTIONS.length} projections x ${names.length} rows = ${total} judgements:`);
  for (const rule of RULES) {
    const s = scores.get(rule.name)!;
    console.log(`  ${rule.name.padEnd(14)} ${String(s.hit).padStart(3)}/${total}  (${s.miss} miss)`);
  }
  if (disagreements.length > 0) {
    console.log("\n  counterexamples (ANY / HASH-ELSE-LEAD only):");
    for (const d of disagreements.slice(0, 20)) console.log(d);
    if (disagreements.length > 20) console.log(`    … ${disagreements.length - 20} more`);
  }
} finally {
  if (wrote) {
    await cleanup();
    // The verifier has to outlast the delete window it is reading through, or
    // it reports its own husks as a leak. The first run of this probe did
    // exactly that: `LEAKED 1 row(s)` after a 2s settle, and a re-read seconds
    // later found 0. The window was measured at 113–1072ms
    // (`probe-card-exists-after-delete.ts`), so poll past it rather than
    // picking one sleep and believing the answer.
    let leaked = Object.keys(WITNESSES).length;
    for (let attempt = 0; attempt < 6 && leaked > 0; attempt++) {
      await settle(2000);
      leaked = 0;
      for (const name of Object.keys(WITNESSES)) {
        if (await pointReadReturns(slugOf(name), ["slug"])) leaked++;
      }
    }
    console.log(
      `\ncleanup: ${leaked === 0 ? "clean — 0 probe rows remain" : `LEAKED ${leaked} row(s) after 12s, re-run to re-clean`}`,
    );
  }
}
