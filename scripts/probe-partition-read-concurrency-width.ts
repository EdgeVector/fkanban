#!/usr/bin/env bun
/**
 * READ-ONLY probe: what fan-out width should `PARTITION_READ_CONCURRENCY` be?
 *
 * This is the measurement run (j) split the constant apart in order to make
 * possible, and then explicitly did not take. Its note:
 *
 *   > The partition fan-out width is now honestly labelled but still unmeasured
 *   > past 2-wide. Measuring THAT path is the natural next run: it is the read
 *   > that would find a shed threshold first, and it is the one that matters
 *   > most.
 *
 * ## What is actually being measured
 *
 * `PARTITION_READ_CONCURRENCY` governs two call sites, and only ONE of them has
 * a fan-out wide enough to care:
 *
 *   - `listAllBoardCards` — one partition read per BOARD. This node has two
 *     boards, so it runs 2-wide no matter what the constant says. Inert today.
 *   - `sweepBoardCardsPartition` — 24 single-field partition queries over ONE
 *     partition, the completeness enumeration behind `doctor` and the HOURLY
 *     `groom board-cards-heal`. At width 6 that is 4 serial waves, every hour,
 *     per board.
 *
 * So the sweep is the live fan-out, and it is the one this probe drives.
 *
 * ## Why a second, harder question is asked too
 *
 * Both concurrency constants document the same unmeasured risk. From
 * `POINT_READ_CONCURRENCY`:
 *
 *   > the probe measured THIS client's latency and shed rate, not the effect of
 *   > a wide fan-out on the OTHER clients sharing this primary.
 *
 * A width is not "safe" because the widening client stayed fast. It is safe
 * because the node stayed fair. So a NEIGHBOUR reader runs continuously
 * throughout — a cheap point read, the shape every other kanban/brain/lastgit
 * process on this primary issues — and its latency is reported per width. That
 * turns "is the node shedding?" (a yes/no the node has never once said yes to)
 * into "what does this cost everyone else?", which is the question the bound
 * actually exists to answer.
 *
 * ## Method notes that matter for trusting the answer
 *
 *  - Widths run INTERLEAVED across reps, not blocked, so a busy minute on this
 *    shared node cannot be mistaken for a slow width.
 *  - The SAME 24 leads are used at every width, so per-field variance cancels.
 *  - Shed (503 / "too many concurrent reads" / service_timeout) is counted
 *    explicitly: a width that is fast but sheds is not a usable width.
 *  - The neighbour's baseline is measured with the fan-out IDLE, so its
 *    per-width numbers are a delta against a real control rather than a guess.
 *  - Reads only. Nothing is written, and no synthetic rows are created.
 *
 * Run: bun scripts/probe-partition-read-concurrency-width.ts [board]
 */
import { readConfig } from "../src/config.ts";
import { newNodeClient, type NodeClient } from "../src/client.ts";
import { boardCardsHash } from "../src/board-cards.ts";
import { BOARD_CARDS_FIELDS } from "../src/schemas.ts";
import { mapWithConcurrency } from "../src/concurrency.ts";

const cfg = readConfig();
const node: NodeClient = newNodeClient({
  baseUrl: cfg.nodeUrl,
  userHash: cfg.userHash,
  socketPath: cfg.nodeSocketPath,
});

const BOARD = process.argv[2] ?? "default";
const WIDTHS = [1, 2, 4, 6, 8, 12, 16, 24];
const REPS = 3;

const schemaHash = boardCardsHash(cfg);
if (!schemaHash) {
  console.log("board_cards not bound — nothing to measure.");
  process.exit(0);
}
const cardHash = cfg.schemaHashes?.card;

const isShed = (err: unknown): boolean => {
  const m = err instanceof Error ? err.message : String(err);
  return /too many concurrent|503|service_timeout|busy/i.test(m);
};

/** One lead of the real sweep: a whole-partition query projecting one field. */
async function leadRead(lead: string): Promise<{ rows: number; shed: boolean }> {
  try {
    const res = await node.queryAll({
      schemaHash: schemaHash!,
      fields: [lead],
      filter: { HashKey: BOARD } as never,
    });
    return { rows: res.results.length, shed: false };
  } catch (err) {
    if (isShed(err)) return { rows: 0, shed: true };
    // A lead the node refuses for its own reasons (the known `column` /
    // `corrupt: empty rec` case) is not shed and must not be counted as such.
    return { rows: 0, shed: false };
  }
}

/**
 * A neighbour process's read, issued continuously while the fan-out runs.
 * Deliberately the CHEAPEST shape on the node so that any latency it gains is
 * queueing caused by the fan-out, not work of its own.
 */
class Neighbour {
  samples: number[] = [];
  private stop = false;
  private done: Promise<void> | null = null;

  start(): void {
    if (!cardHash) return;
    this.stop = false;
    this.samples = [];
    this.done = (async () => {
      while (!this.stop) {
        const t0 = performance.now();
        try {
          await node.queryAll({
            schemaHash: cardHash,
            fields: ["slug"],
            filter: { HashKey: "__probe_neighbour_absent__" } as never,
          });
        } catch {
          // A neighbour that errors still waited; its latency is the signal.
        }
        this.samples.push(performance.now() - t0);
      }
    })();
  }

  async finish(): Promise<{ n: number; median: number; p95: number } | null> {
    if (!this.done) return null;
    this.stop = true;
    await this.done;
    this.done = null;
    const s = [...this.samples].sort((a, b) => a - b);
    if (s.length === 0) return null;
    return {
      n: s.length,
      median: s[Math.floor(s.length / 2)] as number,
      p95: s[Math.min(s.length - 1, Math.floor(s.length * 0.95))] as number,
    };
  }
}

const leads = [...BOARD_CARDS_FIELDS];
console.log(
  `board=${BOARD} leads=${leads.length} reps=${REPS} widths=${WIDTHS.join(",")}\n`,
);

// Control: what does the neighbour cost when the fan-out is IDLE?
//
// WARMED FIRST, and the first version of this probe was wrong for want of it:
// a cold control reported 192ms idle against 72ms under a 1-wide fan-out, i.e.
// the node apparently got FASTER under load. That is not a load effect, it is
// schema resolve and socket setup being paid by whoever reads first. A control
// that is slower than the treatment is a broken control, not a discovery — so
// the first second of neighbour traffic is discarded before the baseline is
// taken, and the same warm client is reused for every width below.
const warm = new Neighbour();
warm.start();
await new Promise((r) => setTimeout(r, 1000));
await warm.finish();

const control = new Neighbour();
control.start();
await new Promise((r) => setTimeout(r, 3000));
const baseline = await control.finish();
console.log(
  baseline
    ? `neighbour baseline (fan-out idle): n=${baseline.n} median=${
      baseline.median.toFixed(0)
    }ms p95=${baseline.p95.toFixed(0)}ms\n`
    : "neighbour baseline unavailable (card schema unbound)\n",
);

type Row = { ms: number[]; shed: number; rows: number; nb: number[] };
const results = new Map<number, Row>();
for (const w of WIDTHS) results.set(w, { ms: [], shed: 0, rows: 0, nb: [] });

for (let rep = 0; rep < REPS; rep++) {
  for (const width of WIDTHS) {
    const nb = new Neighbour();
    nb.start();
    const t0 = performance.now();
    const out = await mapWithConcurrency(leads, (lead) => leadRead(lead), width);
    const ms = performance.now() - t0;
    const stats = await nb.finish();

    const r = results.get(width)!;
    r.ms.push(ms);
    r.shed += out.filter((o) => o.shed).length;
    r.rows = Math.max(r.rows, ...out.map((o) => o.rows));
    if (stats) r.nb.push(stats.median);
  }
}

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[Math.floor(s.length / 2)] as number);
};

console.log("width  median ms  waves  ms/wave  shed  neighbour median ms");
for (const w of WIDTHS) {
  const r = results.get(w)!;
  const m = median(r.ms);
  const waves = Math.ceil(leads.length / w);
  const nb = r.nb.length > 0 ? `${median(r.nb).toFixed(0)}` : "—";
  console.log(
    `${String(w).padStart(5)}  ${m.toFixed(0).padStart(9)}  ${String(waves).padStart(5)}  ${
      (m / waves).toFixed(0).padStart(7)
    }  ${String(r.shed).padStart(4)}  ${nb.padStart(19)}`,
  );
}
console.log(
  `\npartition rows returned by the widest lead: ${results.get(WIDTHS[0] as number)!.rows}`,
);
console.log(
  baseline
    ? `neighbour control (idle): median=${baseline.median.toFixed(0)}ms — ` +
      `compare against the per-width column above.`
    : "",
);
