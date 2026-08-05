#!/usr/bin/env bun
/**
 * Probe: is `upsertBoardCard`'s pre-write read worth its round trip?
 *
 * The non-move path in `upsertBoardCard` reads the stored row first
 * (`readWholeBoardCardRow`) so it can send only the fields that changed. This
 * measures that STRATEGY end to end against the alternative — write all 24
 * fields blind — on a partition sized like the real `default` board, rather
 * than measuring the pieces and adding them up.
 *
 * ## Why it is being asked now
 *
 * The narrowing was justified by `probe-partial-write-cost.ts`, whose fixed
 * arm order made it unable to separate an arm from its slot. Re-run with the
 * arms shuffled on the post-2026-08-05T15:40Z binary, 10 samples per arm:
 *
 *     24 fields, all 24 changed   1983ms
 *     24 fields,  2 changed       1768ms
 *      4 fields,  2 changed       1806ms   <- what narrowing sends
 *     24 fields,  0 changed         48ms
 *     noise floor                   229ms
 *
 * The first three are one number. Payload width and changed-field count do not
 * drive write cost. The only cliff is the last row: the node skips a write
 * whose values are ALL byte-identical, and that skip is free to reach — you get
 * it by sending the unchanged row, not by reading it first.
 *
 * So the read buys narrowing that is worth ~0, and the no-op case it also
 * catches is one the node already handles more cheaply on its own. Both arms
 * below are what the product would actually execute:
 *
 *   READ+NARROW  read the row; if nothing changed skip the write, else send
 *                only the changed fields   <- today
 *   BLIND WIDE   send all 24 fields, always; let the node no-op it if they
 *                match                     <- proposed
 *
 * measured in both states a metadata write lands in:
 *
 *   NOOP     the row already holds what we are about to write (a re-tag, a
 *            re-claim, a heal that finds nothing wrong — common on this board)
 *   CHANGED  two fields differ (the ordinary tag / claim / pr_url write)
 *
 * ## What this probe does NOT decide
 *
 * Correctness. The read also refuses to narrow against a row that is missing or
 * missing an atom, because a narrow `updateRecord` against a missing row
 * silently stores the subset and creates a row every wide reader drops. That
 * hazard belongs to NARROW writes specifically — a wide write creates the row
 * whole and heals a holed one — so dropping the read does not inherit it. The
 * argument is in `readWholeBoardCardRow`'s docstring; read it before acting on
 * any number here.
 *
 * Writes land on a scratch board key that no Board record points at, and the
 * partition is deleted at the end. Labelled `kanban-probe`.
 *
 * Run: bun scripts/probe-prewrite-read-vs-blind-wide.ts [reps] [partitionRows]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardsHash } from "../src/board-cards.ts";
import type { QueryFilter } from "../src/client.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.error("board_cards schema not bound");
  process.exit(1);
}

const REPS = Math.max(3, Number(process.argv[2] ?? 8) || 8);
const ROWS = Math.max(1, Number(process.argv[3] ?? 180) || 180);
/** ms to wait after the setup write before the arm runs. See the loop below. */
const SETTLE = Math.max(0, Number(process.argv[4] ?? 0) || 0);
const BOARD = `zz-probe-prewrite-${Date.now()}`;
/** The row every timed sample writes to. Its neighbours only size the partition. */
const SLUG = "zz-probe-subject";
const SK = `todo#00000001#${SLUG}`;

function fields(slug: string, sk: string, gen: number): Record<string, unknown> {
  return {
    board: BOARD,
    sk,
    slug,
    title: `probe card gen ${gen}`,
    column: "todo",
    position: sk.split("#")[1] ?? "1",
    assignee: `agent-${gen}`,
    tags: [`gen-${gen}`],
    deps: [],
    surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z",
    created_by: "probe",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    db: `db-${gen}`,
    repo: `EdgeVector/probe-${gen}`,
    base: `main-${gen}`,
    kind: "task",
    block_status: "clear",
    block_reason: `reason ${gen}`,
    north_star: `ns-${gen}`,
    milestone: `ms-${gen}`,
    pr_url: `https://example.invalid/${gen}`,
    branch: `branch-${gen}`,
    layout: BOARD_CARDS_LAYOUT,
  };
}

const update = (f: Record<string, unknown>, sk = SK) =>
  node.updateRecord({ schemaHash, fields: f, keyHash: BOARD, rangeKey: sk });

/** Exactly what `readWholeBoardCardRow` issues, including its wholeness re-check. */
async function readWhole(): Promise<Record<string, unknown> | null> {
  const filter = { HashRangePrefix: { hash: BOARD, prefix: SK } } as unknown as QueryFilter;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const f = r.fields as Record<string, unknown>;
    if (f.sk !== SK) continue;
    if (BOARD_CARDS_FIELDS.some((k) => f[k] === undefined || f[k] === null)) return null;
    return f;
  }
  return null;
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Today's path: read, diff, then skip or send only what changed.
 *
 * Reports its two phases separately. The first end-to-end run of this probe
 * could not be interpreted without them: `read+narrow` on a no-op measured
 * 1671ms against 51ms for a blind wide write, but on a CHANGED row the same
 * path measured 1697ms — only 26ms more, which is impossible if the read costs
 * 1.6s AND a write follows it. One of those two numbers is not what it looks
 * like, and summing phases cannot say which.
 *
 * `fellBack` records whether the wholeness gate sent us down the wide path
 * anyway; if that is always true the "narrow" arm never narrowed and the whole
 * comparison is measuring something else.
 */
type Phases = {
  readMs: number;
  writeMs: number;
  wrote: "none" | "narrow" | "wide";
  fellBack: boolean;
  /** Which fields the diff called changed, and what it saw. Empty = a real skip. */
  diff: string[];
};
async function readNarrow(next: Record<string, unknown>): Promise<Phases> {
  const t0 = performance.now();
  const stored = await readWhole();
  const readMs = performance.now() - t0;
  if (stored) {
    const changed: Record<string, unknown> = {};
    const diff: string[] = [];
    for (const k of BOARD_CARDS_FIELDS) {
      if (k === "board" || k === "sk") continue;
      if (!(k in next)) continue;
      if (same(stored[k], next[k])) continue;
      changed[k] = next[k];
      diff.push(`${k}(${JSON.stringify(stored[k])}→${JSON.stringify(next[k])})`);
    }
    if (Object.keys(changed).length === 0) {
      return { readMs, writeMs: 0, wrote: "none", fellBack: false, diff };
    }
    const t1 = performance.now();
    await update({ board: BOARD, sk: SK, ...changed });
    return { readMs, writeMs: performance.now() - t1, wrote: "narrow", fellBack: false, diff };
  }
  const t1 = performance.now();
  await update(next);
  return { readMs, writeMs: performance.now() - t1, wrote: "wide", fellBack: true, diff: ["<row not whole>"] };
}

/** Proposed path: send the whole row and let the node decide if it is a no-op. */
async function blindWide(next: Record<string, unknown>): Promise<void> {
  await update(next);
}

type Arm = "read+narrow/noop" | "blind-wide/noop" | "read+narrow/changed" | "blind-wide/changed";
const ARMS: Arm[] = [
  "read+narrow/noop",
  "blind-wide/noop",
  "read+narrow/changed",
  "blind-wide/changed",
];

const median = (xs: readonly number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
};
const quantile = (xs: readonly number[], q: number) => {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.round(q * (s.length - 1))))]!;
};
const iqr = (xs: readonly number[]) => quantile(xs, 0.75) - quantile(xs, 0.25);

console.log(`schema ${schemaHash.slice(0, 12)}…  board ${BOARD}`);
console.log(`reps=${REPS} partitionRows=${ROWS}  client=kanban-probe\n`);

console.log("== seed partition ==");
let gen = 1;
const t0 = performance.now();
await node.createRecord({ schemaHash, fields: fields(SLUG, SK, gen), keyHash: BOARD, rangeKey: SK });
const filler = [];
for (let i = 1; i < ROWS; i += 1) {
  const slug = `zz-filler-${String(i).padStart(4, "0")}`;
  const sk = `todo#${String(i + 1).padStart(8, "0")}#${slug}`;
  filler.push({ keyHash: BOARD, rangeKey: sk, fields: fields(slug, sk, i) });
}
if (!node.updateRecords || !node.deleteRecords) {
  console.error("this node client has no batch verbs; cannot seed cheaply");
  process.exit(1);
}
for (let i = 0; i < filler.length; i += 48) {
  await node.updateRecords(
    filler.slice(i, i + 48).map((c) => ({
      schemaHash,
      keyHash: c.keyHash,
      rangeKey: c.rangeKey,
      fields: c.fields,
    })),
  );
}
console.log(`  ${ROWS} rows in ${((performance.now() - t0) / 1000).toFixed(1)}s`);

const samples: Record<Arm, number[]> = {
  "read+narrow/noop": [],
  "blind-wide/noop": [],
  "read+narrow/changed": [],
  "blind-wide/changed": [],
};
const phaseLog: Record<"read+narrow/noop" | "read+narrow/changed", Phases[]> = {
  "read+narrow/noop": [],
  "read+narrow/changed": [],
};

console.log(`\n== ${REPS} reps, arm order shuffled per rep ==`);
for (let r = 0; r < REPS; r += 1) {
  const order = [...ARMS];
  for (let i = order.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [order[i], order[j]] = [order[j]!, order[i]!];
  }
  const shown: string[] = [];
  for (const arm of order) {
    // Untimed setup: put the row into a known state, identical for every arm.
    gen += 1;
    const base = gen;
    await update(fields(SLUG, SK, base));
    // SETTLE is the control for the BoardCards index lag. At 0 the no-op arm's
    // diff runs against a row two generations stale and "finds" a change that
    // is not one; raising it past the lag makes the same arm skip. That is the
    // hazard being measured, not a wart in the harness.
    if (SETTLE > 0) await new Promise((r) => setTimeout(r, SETTLE));

    const noop = arm.endsWith("/noop");
    let next: Record<string, unknown>;
    if (noop) {
      next = fields(SLUG, SK, base); // byte-identical to stored
    } else {
      gen += 1;
      next = { ...fields(SLUG, SK, base), tags: [`gen-${gen}`], updated_at: new Date(1785000000000 + gen * 1000).toISOString() };
    }

    const t = performance.now();
    let phases: Phases | null = null;
    if (arm.startsWith("read+narrow")) phases = await readNarrow(next);
    else await blindWide(next);
    const dt = performance.now() - t;
    samples[arm].push(dt);
    if (phases) {
      phaseLog[arm as "read+narrow/noop" | "read+narrow/changed"].push(phases);
      shown.push(
        `${arm.replace("read+narrow", "RN")}=${dt.toFixed(0)}` +
          `[rd=${phases.readMs.toFixed(0)} wr=${phases.writeMs.toFixed(0)}:${phases.wrote}]`,
      );
    } else {
      shown.push(`${arm.replace("blind-wide", "BW")}=${dt.toFixed(0)}`);
    }
  }
  console.log(`  rep ${String(r + 1).padStart(2)}  ${shown.join("  ")}`);
}

const floor = median(ARMS.map((a) => iqr(samples[a])));

console.log(`\n== per-arm distribution (${REPS} samples each) ==`);
for (const arm of ARMS) {
  const xs = samples[arm];
  console.log(
    `  ${arm.padEnd(22)} med=${median(xs).toFixed(0).padStart(6)}ms  p25=${quantile(xs, 0.25).toFixed(0).padStart(6)}` +
      `  p75=${quantile(xs, 0.75).toFixed(0).padStart(6)}  min=${Math.min(...xs).toFixed(0).padStart(6)}  max=${Math.max(...xs).toFixed(0).padStart(6)}`,
  );
}
console.log(`\n  noise floor (median within-arm IQR): ${floor.toFixed(0)}ms`);

console.log("\n== where read+narrow's time actually goes ==");
for (const arm of ["read+narrow/noop", "read+narrow/changed"] as const) {
  const ph = phaseLog[arm];
  const fellBack = ph.filter((p) => p.fellBack).length;
  const shapes = [...new Set(ph.map((p) => p.wrote))].join("/");
  console.log(
    `  ${arm.padEnd(22)} read med=${median(ph.map((p) => p.readMs)).toFixed(0).padStart(5)}ms` +
      `  write med=${median(ph.map((p) => p.writeMs)).toFixed(0).padStart(5)}ms` +
      `  wrote=${shapes}  fell back to wide: ${fellBack}/${ph.length}`,
  );
}
{
  const noop = phaseLog["read+narrow/noop"];
  const skipped = noop.filter((p) => p.wrote === "none").length;
  console.log(`\n  no-op arm: the diff found nothing and skipped the write ${skipped}/${noop.length} times`);
  if (skipped < noop.length) {
    console.log("  It was handed a byte-identical row, so anything it calls changed is a");
    console.log("  comparator artefact. What it claimed differed:");
    for (const d of [...new Set(noop.filter((p) => p.wrote !== "none").map((p) => p.diff.join(" ")))]) {
      console.log(`    ${d}`);
    }
  }
}
if (phaseLog["read+narrow/changed"].every((p) => p.fellBack)) {
  console.log("  WARNING: the narrow arm NEVER narrowed — the wholeness gate rejected every");
  console.log("  row, so this run compared two wide writes and says nothing about narrowing.");
}

function compare(a: Arm, b: Arm, label: string) {
  const delta = median(samples[a]) - median(samples[b]);
  const disjoint =
    quantile(samples[a], 0.25) > quantile(samples[b], 0.75) ||
    quantile(samples[b], 0.25) > quantile(samples[a], 0.75);
  const clears = Math.abs(delta) >= floor && disjoint;
  console.log(
    `  ${label.padEnd(30)} ${clears ? `${delta > 0 ? "+" : ""}${delta.toFixed(0)}ms` : "~noise"}` +
      `${clears ? "" : `  (|Δ|=${Math.abs(delta).toFixed(0)}ms vs floor ${floor.toFixed(0)}ms)`}`,
  );
  return clears ? delta : 0;
}

console.log("\n== verdict (positive = today's read+narrow costs MORE) ==");
const dNoop = compare("read+narrow/noop", "blind-wide/noop", "no-op write");
const dChanged = compare("read+narrow/changed", "blind-wide/changed", "2-field change");
console.log("");
if (dNoop > 0 && dChanged > 0) {
  console.log("  The pre-write read costs more than it saves in BOTH states. It exists to");
  console.log("  enable narrowing, and narrowing is worth nothing this binary can show.");
} else if (dNoop <= 0 && dChanged <= 0) {
  console.log("  The pre-write read pays for itself. Leave upsertBoardCard alone.");
} else {
  console.log("  Split result — the read wins one state and loses the other. Weigh it by");
  console.log("  how often real traffic is a no-op before changing anything.");
}

console.log("\n== cleanup ==");
const tC = performance.now();
const allSks = [SK, ...filler.map((f) => f.rangeKey)];
for (let i = 0; i < allSks.length; i += 48) {
  await node.deleteRecords(
    allSks.slice(i, i + 48).map((sk) => ({ schemaHash, keyHash: BOARD, rangeKey: sk })),
  );
}
// The BoardCards index lags its own delete ack (see `deleteRecords`' docstring
// — a caller that re-reads its own reap sees phantom survivors). An immediate
// read-back reported all 180 rows still present on the first run of this probe,
// and a full-store sweep minutes later found the partition gone. So settle
// before reading, and say plainly that a nonzero count here is not lost rows.
await new Promise((r) => setTimeout(r, 5000));
const left = await node.queryAll({
  schemaHash,
  fields: ["board", "sk"],
  filter: { HashKey: BOARD } as unknown as QueryFilter,
});
console.log(`  deleted ${allSks.length} rows in ${((performance.now() - tC) / 1000).toFixed(1)}s`);
console.log(`  rows visible after 5s settle: ${left.results.length}`);
if (left.results.length > 0) {
  console.log("  (index lag, not a failed delete — confirm with sweep-probe-boardcards-litter.ts)");
}
