#!/usr/bin/env bun
/**
 * Probe: what makes a BoardCards row read STALE after its own ack — and does
 * issuing one more write clear it?
 *
 * ## The question this exists to settle
 *
 * Two probes in this repo disagree by three orders of magnitude about the same
 * schema on the same node in the same hour:
 *
 *   - `probe-boardcard-read-after-write-lag.ts` — ~0.8-2.4s stale after ack, 3/3
 *   - `probe-write-shape-vs-readback-freshness.ts` — fresh in 6ms, 11/11
 *
 * Run (j) eliminated payload width (2 vs 24 fields) and partition age (warm vs
 * brand-new) as the variable, so the gap is somewhere in what else the two
 * probes do differently. It recorded a candidate — the real path does further
 * node work after the BoardCards write (`retireMilestoneCardMembership` runs
 * immediately after `upsertBoardCard` inside `writeCardMembership`), which may
 * carry the pending durable put through — and explicitly did NOT claim it as
 * mechanism.
 *
 * That candidate is worth settling rather than inheriting, because if it holds
 * it is not a probe curiosity: "issue one more write" becomes a freshness lever
 * the whole app can pull, and the read-after-ack conformance bar
 * (`lastdb-read-after-ack-conformance-bar`) needs an arm for it. If it does not
 * hold, the bar must not carry a mechanism nobody measured.
 *
 * ## Design
 *
 * Everything is held fixed at the LOW level — raw `node.updateRecord` to one
 * schema, same 24-field payload builder, same polled query — so the only things
 * that vary are the two candidates, crossed:
 *
 *   followOn  : none | same-partition (unrelated row, same board hash)
 *   slotAge   : fresh (first update of a settled row) | repeated (4th
 *               generation written to the same slot back to back)
 *
 * Arms are SHUFFLED per rep and each arm's precondition is established by an
 * UNTIMED setup, because a fixed arm order makes arm and slot the same variable
 * — the exact defect that made `probe-partial-write-cost.ts`'s first table
 * wrong. Each rep uses a fresh board partition per arm so no arm inherits
 * another's pending state.
 *
 * Reads poll the EXACT query `readWholeBoardCardRow` issues (24 fields,
 * `HashRangePrefix` on the full sk); a lookalike read is not evidence about the
 * real one.
 *
 * Writes to stamped `zz-` board partitions that no Board record points at, and
 * deletes every row it made. Labelled `kanban-probe` so its writes do not land
 * in the `kanban` bucket in `lastdb ops`.
 *
 * ## Result 2026-08-05 — BOTH candidates falsified, 16/16
 *
 * | arm                 | med ack | med time-to-fresh | range        |
 * |---------------------|---------|-------------------|--------------|
 * | plain               |  532ms  | 1379ms            | 1224-1636ms  |
 * | follow-on           | 1356ms  | 1758ms            | 1188-1874ms  |
 * | repeated            | 2092ms  |  897ms            |  649-1839ms  |
 * | repeated+follow-on  | 1977ms  |  942ms            |  683-1484ms  |
 *
 * A follow-on write does not clear the staleness — it is if anything slower.
 * And repetition is not the cause either: the `repeated` arms came back fresh
 * SOONER than the settled ones, which retires "a probe that hammers one slot
 * measures the hammering" as the explanation for this particular gap (it
 * remains the right verdict on the four earlier occasions it was reached).
 *
 * What this probe found instead is that ALL FOUR of its arms are stale ~1.4s
 * while the sibling real-path probe reproduces 3ms freshness in the same hour —
 * so the variable was somewhere neither candidate had looked.
 * `probe-freshness-bisect-raw-vs-real-path.ts` was written to find it and did:
 * the variable is the polled FIELD. This probe polls `milestone`, the one field
 * on the row that lags; its sibling polls `tags`, which is fresh at 5ms like
 * the other sixteen.
 *
 * Kept rather than deleted: it is the evidence that the two named candidates
 * are dead, and re-deriving that costs more than reading it.
 *
 * Run: bun scripts/probe-followon-write-drains-deferred-put.ts
 *      REPS=6 bun scripts/probe-followon-write-drains-deferred-put.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardsHash } from "../src/board-cards.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const schemaHash = boardCardsHash(cfg)!;

const REPS = Number(process.env.REPS ?? 4);
const POLL_MS = 50;
const GIVE_UP_MS = 8000;
/** Long enough that the prior write's deferred put has certainly landed. */
const SETTLE_MS = 3500;
/** Generations written back-to-back in the `repeated` arms, before the timed one. */
const REPEAT_GENS = 3;

const SLUG = "zz-subject";
const SK = `todo#00000001#${SLUG}`;
const OTHER_SK = `todo#00000002#zz-other`;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function row(board: string, sk: string, slug: string, gen: number) {
  return {
    board, sk, slug, title: `t${gen}`, column: "todo", position: sk.split("#")[1]!,
    assignee: `a${gen}`, tags: [`g${gen}`], deps: [], surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z", created_by: "probe",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    db: `d${gen}`, repo: `r${gen}`, base: `b${gen}`, kind: "task",
    block_status: "clear", block_reason: `br${gen}`, north_star: `ns${gen}`,
    milestone: `ms-${gen}`, pr_url: `https://x.invalid/${gen}`, branch: `br${gen}`,
    layout: BOARD_CARDS_LAYOUT,
  };
}

/** Exactly what `readWholeBoardCardRow` issues. */
async function readMilestone(board: string): Promise<string> {
  const filter = { HashRangePrefix: { hash: board, prefix: SK } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const fl = r.fields as Record<string, unknown>;
    if (fl.sk !== SK) continue;
    return fl.milestone as string;
  }
  return "<absent>";
}

type Arm = { name: string; followOn: boolean; repeated: boolean };
const ARMS: Arm[] = [
  { name: "plain            ", followOn: false, repeated: false },
  { name: "follow-on        ", followOn: true, repeated: false },
  { name: "repeated         ", followOn: false, repeated: true },
  { name: "repeated+followOn", followOn: true, repeated: true },
];

/** Deterministic per-rep rotation + swap, so arm and position are not the same variable. */
function shuffled(rep: number): Arm[] {
  const out = [...ARMS];
  for (let i = 0; i < rep % out.length; i += 1) out.push(out.shift()!);
  if (rep % 2 === 0) [out[0], out[out.length - 1]] = [out[out.length - 1]!, out[0]!];
  return out;
}

const samples = new Map<string, Array<{ ack: number; fresh: number | null }>>();
for (const a of ARMS) samples.set(a.name, []);
const madeBoards: string[] = [];

console.log(`reps=${REPS}  settle=${SETTLE_MS}ms  repeat-gens=${REPEAT_GENS}  poll=${POLL_MS}ms\n`);

for (let rep = 1; rep <= REPS; rep += 1) {
  for (const arm of shuffled(rep)) {
    const board = `zz-drain-${Date.now()}-${Math.round(performance.now() * 1000) % 100000}`;
    madeBoards.push(board);

    // ---- UNTIMED setup: establish this arm's precondition ----
    await node.createRecord({ schemaHash, fields: row(board, SK, SLUG, 1), keyHash: board, rangeKey: SK });
    if (arm.followOn) {
      await node.createRecord({
        schemaHash, fields: row(board, OTHER_SK, "zz-other", 1), keyHash: board, rangeKey: OTHER_SK,
      });
    }
    await sleep(SETTLE_MS);

    let gen = 1;
    if (arm.repeated) {
      // Back-to-back generations into the SAME slot, no settle between them.
      for (let g = 0; g < REPEAT_GENS; g += 1) {
        gen += 1;
        await node.updateRecord({ schemaHash, fields: row(board, SK, SLUG, gen), keyHash: board, rangeKey: SK });
      }
    }

    // ---- TIMED: the write under test, then optionally one more write ----
    gen += 1;
    const target = `ms-${gen}`;
    const t0 = performance.now();
    await node.updateRecord({ schemaHash, fields: row(board, SK, SLUG, gen), keyHash: board, rangeKey: SK });
    const ack = performance.now() - t0;
    if (arm.followOn) {
      // An unrelated row in the same partition — the shape of the extra node
      // work the real path does after `upsertBoardCard`.
      await node.updateRecord({
        schemaHash, fields: row(board, OTHER_SK, "zz-other", gen), keyHash: board, rangeKey: OTHER_SK,
      });
    }

    let fresh: number | null = null;
    const deadline = performance.now() + GIVE_UP_MS;
    for (;;) {
      if ((await readMilestone(board)) === target) {
        fresh = Math.max(0, performance.now() - t0 - ack);
        break;
      }
      if (performance.now() > deadline) break;
      await sleep(POLL_MS);
    }

    samples.get(arm.name)!.push({ ack, fresh });
    console.log(
      `rep ${rep}  ${arm.name}  ack ${ack.toFixed(0).padStart(5)}ms  ` +
        `fresh ${fresh === null ? `NOT within ${GIVE_UP_MS}ms` : `${fresh.toFixed(0).padStart(5)}ms after ack`}`,
    );

    await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: SK });
    if (arm.followOn) await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: OTHER_SK });
  }
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${"arm".padEnd(19)} ${"n".padStart(3)} ${"med ack".padStart(9)} ${"med fresh".padStart(11)}  fresh-within-${GIVE_UP_MS}ms`);
for (const a of ARMS) {
  const xs = samples.get(a.name)!;
  const ok = xs.map((x) => x.fresh).filter((x): x is number => x !== null);
  console.log(
    `${a.name.padEnd(19)} ${String(xs.length).padStart(3)} ` +
      `${med(xs.map((x) => x.ack)).toFixed(0).padStart(7)}ms ` +
      `${(ok.length ? med(ok).toFixed(0) : "-").padStart(9)}ms  ${ok.length}/${xs.length}` +
      `${ok.length ? `   range ${Math.min(...ok).toFixed(0)}-${Math.max(...ok).toFixed(0)}ms` : ""}`,
  );
}
console.log(`\nboards touched: ${madeBoards.length} (rows deleted; empty zz- partitions left behind)`);
