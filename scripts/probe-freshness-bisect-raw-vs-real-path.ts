#!/usr/bin/env bun
/**
 * Probe: WHY does a BoardCards row read fresh in ~3ms after a real board write
 * and ~1400ms after a raw `node.updateRecord` — when both send the same 24
 * fields, through the same `/api/mutation` route, to the same schema?
 *
 * ## The contradiction this bisects
 *
 * Two probes in this repo reproduce, minutes apart, on the same primary:
 *
 *   probe-write-shape-vs-readback-freshness.ts    3ms fresh   4/4
 *   probe-followon-write-drains-deferred-put.ts   ~1400ms     16/16 (all arms)
 *
 * Already eliminated as the variable, each by direct measurement rather than by
 * argument: payload width (2 vs 24 fields) and partition age (warm
 * `agent-dogfood-scratch` vs a brand-new `zz-` partition) in run (j); and, in
 * the follow-on probe above, both of run (j)'s handoff candidates — issuing one
 * more same-schema write after the subject write (no help; if anything slower)
 * and repeated back-to-back generations into one slot (FASTER to fresh, not
 * slower, which also retires "a probe that hammers one slot measures the
 * hammering" as the explanation for THIS gap).
 *
 * `upsertBoardCard` calls the identical `node.updateRecord` the raw probe calls,
 * so the difference is not the write verb. Three differences remain between the
 * two instruments, and this probe flips them one at a time:
 *
 *   seed  : raw `node.createRecord` | `createCardRecord` (writes a Card row too)
 *   write : raw `node.updateRecord` | `writeCardPatch` (the real path)
 *   field : `milestone`             | `tags`
 *
 * ## Why the field is in the ladder at all
 *
 * It looks like an irrelevance, and it may be. It is here because the two
 * instruments differ on it, and this repo has now been wrong four times by
 * assuming a difference between two probes could not be the one that mattered.
 * A factor that costs one arm to eliminate gets eliminated, not argued away.
 *
 * ## Design
 *
 * A ladder from the stale configuration to the fresh one, one factor per rung,
 * with arms SHUFFLED per rep so arm and position are not the same variable —
 * the defect that made `probe-partial-write-cost.ts`'s first table wrong. Each
 * arm gets its own brand-new `zz-` partition so no arm inherits another's
 * pending state, and every arm settles before the timed write so the write
 * under test always updates a row the index already serves.
 *
 * Reads poll the EXACT query `readWholeBoardCardRow` issues (24 fields,
 * `HashRangePrefix` on the full sk). Labelled `kanban-probe`. Every row it
 * writes is deleted.
 *
 * Run: bun scripts/probe-freshness-bisect-raw-vs-real-path.ts
 *      REPS=6 bun scripts/probe-freshness-bisect-raw-vs-real-path.ts
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient } from "../src/client.ts";
import { BOARD_CARDS_FIELDS, BOARD_CARDS_LAYOUT } from "../src/schemas.ts";
import { boardCardsHash } from "../src/board-cards.ts";
import { createCardRecord, writeCardPatch, emptyStructuredFields } from "../src/record.ts";

const cfg = readConfig();
const node = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
  opsLabel: "kanban-probe",
});
const schemaHash = boardCardsHash(cfg)!;
const cardHash = cfg.schemaHashes?.card;

const REPS = Number(process.env.REPS ?? 3);
const POLL_MS = 50;
const GIVE_UP_MS = 8000;
const SETTLE_MS = 3500;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Seed = "raw" | "card";
type Write = "raw" | "patch";
type Field = "milestone" | "tags";
type Arm = { name: string; seed: Seed; write: Write; field: Field };

/** The ladder: A0 is the stale instrument's config, A4 is the fresh one's. */
const ARMS: Arm[] = [
  { name: "A0 raw/raw/milestone  ", seed: "raw", write: "raw", field: "milestone" },
  { name: "A1 raw/raw/tags       ", seed: "raw", write: "raw", field: "tags" },
  { name: "A2 card/raw/milestone ", seed: "card", write: "raw", field: "milestone" },
  { name: "A3 card/patch/milestone", seed: "card", write: "patch", field: "milestone" },
  { name: "A4 card/patch/tags    ", seed: "card", write: "patch", field: "tags" },
];

function shuffled(rep: number): Arm[] {
  const out = [...ARMS];
  for (let i = 0; i < rep % out.length; i += 1) out.push(out.shift()!);
  if (rep % 2 === 0) [out[0], out[out.length - 1]] = [out[out.length - 1]!, out[0]!];
  return out;
}

function rawRow(board: string, sk: string, slug: string, gen: number) {
  return {
    board, sk, slug, title: `t${gen}`, column: "todo", position: "00000001",
    assignee: `a${gen}`, tags: [`g${gen}`], deps: [], surfaces: [],
    created_at: "2026-07-31T00:00:00.000Z", created_by: "probe",
    updated_at: new Date(1785000000000 + gen * 1000).toISOString(),
    db: `d${gen}`, repo: `r${gen}`, base: `b${gen}`, kind: "task",
    block_status: "clear", block_reason: `br${gen}`, north_star: `ns${gen}`,
    milestone: `ms-${gen}`, pr_url: `https://x.invalid/${gen}`, branch: `br${gen}`,
    layout: BOARD_CARDS_LAYOUT,
  };
}

function baseCard(board: string, slug: string, stamp: number) {
  return {
    slug, title: "probe: freshness bisect", body: "", board, column: "todo",
    position: "00000001", assignee: "", tags: [] as string[], deps: [] as string[],
    created_at: new Date(stamp).toISOString(), updated_at: new Date(stamp).toISOString(),
    ...emptyStructuredFields(), surfaces: [] as string[],
  };
}

/** Exactly what `readWholeBoardCardRow` issues; returns the arm's witness field. */
async function readWitness(board: string, sk: string, field: Field): Promise<string> {
  const filter = { HashRangePrefix: { hash: board, prefix: sk } } as never;
  const res = await node.queryAll({ schemaHash, fields: [...BOARD_CARDS_FIELDS], filter });
  for (const r of res.results) {
    const fl = r.fields as Record<string, unknown>;
    if (fl.sk !== sk) continue;
    if (field === "milestone") return (fl.milestone as string) ?? "";
    return ((fl.tags as string[]) ?? []).join(",");
  }
  return "<absent>";
}

const samples = new Map<string, Array<{ ack: number; fresh: number | null }>>();
for (const a of ARMS) samples.set(a.name, []);

console.log(`reps=${REPS}  settle=${SETTLE_MS}ms  poll=${POLL_MS}ms  give-up=${GIVE_UP_MS}ms\n`);

for (let rep = 1; rep <= REPS; rep += 1) {
  for (const arm of shuffled(rep)) {
    const stamp = Date.now();
    const board = `zz-bisect-${stamp}-${Math.round(performance.now() * 1000) % 100000}`;
    const slug = arm.seed === "card" ? `zz-bis-${stamp}` : "zz-subject";
    const sk = `todo#00000001#${slug}`;

    // ---- UNTIMED setup ----
    let card: ReturnType<typeof baseCard> | null = null;
    if (arm.seed === "card") {
      card = baseCard(board, slug, stamp);
      await createCardRecord({ cfg, node }, card as never);
    } else {
      await node.createRecord({ schemaHash, fields: rawRow(board, sk, slug, 1), keyHash: board, rangeKey: sk });
    }
    await sleep(SETTLE_MS);

    // ---- TIMED: one write, then poll the real query ----
    const gen = 2;
    const witness = arm.field === "milestone" ? `ms-${gen}` : `zz-w${rep}`;
    const t0 = performance.now();
    if (arm.write === "patch") {
      const patch = arm.field === "milestone" ? { milestone: witness } : { tags: [witness] };
      await writeCardPatch({ cfg, node }, card as never, patch as never);
    } else {
      const fields = rawRow(board, sk, slug, gen);
      if (arm.field === "tags") fields.tags = [witness];
      await node.updateRecord({ schemaHash, fields, keyHash: board, rangeKey: sk });
    }
    const ack = performance.now() - t0;

    let fresh: number | null = null;
    const deadline = performance.now() + GIVE_UP_MS;
    for (;;) {
      const seen = await readWitness(board, sk, arm.field);
      if (arm.field === "milestone" ? seen === witness : seen.split(",").includes(witness)) {
        fresh = Math.max(0, performance.now() - t0 - ack);
        break;
      }
      if (performance.now() > deadline) break;
      await sleep(POLL_MS);
    }

    samples.get(arm.name)!.push({ ack, fresh });
    console.log(
      `rep ${rep}  ${arm.name}  ack ${ack.toFixed(0).padStart(5)}ms  ` +
        `fresh ${fresh === null ? `NOT within ${GIVE_UP_MS}ms` : `${fresh.toFixed(0).padStart(5)}ms`}`,
    );

    await node.deleteRecord({ schemaHash, keyHash: board, rangeKey: sk });
    if (arm.seed === "card" && cardHash) await node.deleteRecord({ schemaHash: cardHash, keyHash: slug });
  }
}

const med = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  if (!s.length) return NaN;
  return s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2;
};

console.log(`\n${"arm".padEnd(24)} ${"n".padStart(2)} ${"med ack".padStart(9)} ${"med fresh".padStart(11)}   range`);
for (const a of ARMS) {
  const xs = samples.get(a.name)!;
  const ok = xs.map((x) => x.fresh).filter((x): x is number => x !== null);
  console.log(
    `${a.name.padEnd(24)} ${String(xs.length).padStart(2)} ` +
      `${med(xs.map((x) => x.ack)).toFixed(0).padStart(7)}ms ` +
      `${(ok.length ? med(ok).toFixed(0) : "-").padStart(9)}ms   ` +
      `${ok.length ? `${Math.min(...ok).toFixed(0)}-${Math.max(...ok).toFixed(0)}ms (${ok.length}/${xs.length})` : `0/${xs.length} fresh`}`,
  );
}
