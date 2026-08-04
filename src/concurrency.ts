// Bounded-parallel map for point-read fan-outs.
//
// Why this exists: LastDB Mini sheds load with "too many concurrent reads", so
// an unbounded `Promise.all` over N card slugs is a load hazard, not a speedup
// — it opens N sockets at once and the node rejects the excess. It is also
// slower in the case that matters: a rejected read has to be retried.
//
// `board_cards_heal` learned this first and reads 6-at-a-time, but it kept the
// worker pool inline, so every OTHER N-read path in the codebase went on
// fanning out unbounded. This is that pool, extracted, so the lesson applies
// once rather than per call site.
//
// Ordering is preserved: results land at their input index, so callers can zip
// them back against the input without tracking slugs.

/**
 * Fan-out width for POINT-read pools (one row, by key).
 *
 * ## READ THIS FIRST: the cost model below no longer holds (2026-08-04)
 *
 * Everything from "The cost model this number is derived from" down to the end
 * of this docstring was derived from a **~190ms per-request floor that does not
 * reproduce on the current stack**. Re-measured 2026-08-04 on lastdbd
 * `0.23.2-409-gee967a073`, by re-running the very probes that produced the
 * tables below, unmodified:
 *
 * | probe | documented 2026-08-03 | measured 2026-08-04 |
 * |---|---|---|
 * | `probe-point-read-concurrency-width.ts`, 18 slugs, width 1 | 3251ms | **8ms** |
 * | same, width 24 | 214ms | **2ms** |
 * | `probe-where-the-194ms-goes.ts`, bare `fetch` POST /api/query | ~194ms | **0.6ms** |
 *
 * Confirmed served, not short-circuited: an `lastdb ops` count delta across one
 * probe run shows the node accepting **440 real queries in 52ms** of node time
 * (0.12ms each), and the reads return rows.
 *
 * The ~190ms was per-PROCESS, not per-request — connection setup and the first
 * attestation, amortized to nothing by any client that reuses its socket. A
 * fresh in-process read now costs ~15ms and every subsequent one ~0.5-1.0ms.
 * That is why a per-request floor showed up in probes that spawn a CLI (a
 * `brain get` still costs ~180ms wall) and vanishes inside a long-lived one.
 *
 * The upgrade at 18:16Z the same day is the obvious suspect; that is a
 * correlation and nobody has A/B'd the old binary, so treat the CAUSE as
 * unproven and the MEASUREMENT as solid.
 *
 * ### What that means for this constant
 *
 * Sixteen is now nearly inert: it saves ~6ms on the 18-slug `pickup status`
 * fan-out (8ms serial vs 2ms at width 24). It is kept because it costs nothing
 * and the politeness bound is still worth having, NOT because the wave model
 * justifies it. **Do not derive any new design from "the unit of cost is the
 * serial wave"** — that rule is retired for point reads. A round trip is no
 * longer expensive enough to reshape a read path around, which also makes the
 * N+1 fan-out findings recorded against this repo far less severe than they
 * were when filed.
 *
 * The historical derivation is kept below because several decisions elsewhere
 * cite it, and a reader needs to see what those decisions were reasoning from.
 *
 * ## SUPERSEDED — the cost model this number was derived from
 *
 * A point read costs the node ~1.9ms and the caller ~190ms; a bare `fetch` over
 * the same socket costs the same ~190ms. So a read is almost entirely
 * per-request latency, and **the unit of cost is the serial wave**, not the
 * request, the row, or the field (`pickup.ts` states the same rule). Total cost
 * is therefore `ceil(N / width) x ~190ms` — width buys waves, and nothing else.
 *
 * ## Measured, live primary, 2026-08-03 (superseded — see the table above)
 *
 * `scripts/probe-point-read-concurrency-width.ts` — 18 slugs (what
 * `pickup status` actually fans out over), 3 interleaved reps:
 *
 * | width | median ms | waves | ms/wave | shed |
 * |---|---|---|---|---|
 * | 1 | 3251 | 18 | 181 | 0 |
 * | 4 | 947 | 5 | 189 | 0 |
 * | **6** (the old default) | **582** | **3** | 194 | 0 |
 * | 12 | 388 | 2 | 194 | 0 |
 * | 16 | 383 | 2 | 192 | 0 |
 * | 24 | 214 | 1 | 214 | 0 |
 *
 * ms/wave is FLAT across a 24x range of width. That is the wave model holding
 * exactly, and it means the old width was buying two extra waves (~370ms on
 * every `pickup status`) for no measured benefit.
 *
 * ## Why sixteen and not ninety-six
 *
 * Six justified itself twice, and both justifications failed measurement. The
 * first was "a point read averages ~2s" — retired 2026-08-02 when the same read
 * measured 21-34ms, two orders of magnitude off. The second was this one: that
 * a wider fan-out crosses Mini's "too many concurrent reads" shed threshold.
 * `scripts/probe-point-read-shed-threshold.ts` escalated to **96 concurrent
 * point reads and the node shed nothing** — no 503, no `service_timeout`, and
 * no per-wave latency growth. The load guard does not reproduce at any width
 * this product would plausibly use.
 *
 * So the ceiling is real but far away, and sixteen sits a measured 6x under it.
 * The remaining bound is deliberate rather than vestigial, and it is honest
 * about what was NOT measured: the probe measured **this** client's latency and
 * shed rate, not the effect of a wide fan-out on the OTHER clients sharing this
 * primary (lastgit and brain are both heavier users of it than kanban). A fleet
 * of kanban processes each opening 96 sockets is a different experiment from
 * one process doing it, and nobody has run it. Sixteen collapses every fan-out
 * this product actually issues into one or two waves while leaving that
 * unmeasured risk untaken.
 *
 * Do not raise this to "unbounded". The bound's job is politeness to a shared
 * node, and that job survives the shed threshold being further away than the
 * folklore claimed.
 */
export const POINT_READ_CONCURRENCY = 16;

/**
 * Fan-out width for PARTITION-read pools (a whole board's rows, per board).
 *
 * Twelve, and separate from {@link POINT_READ_CONCURRENCY} on purpose. The
 * separation came first (the two used to be one constant, so tuning the cheap
 * class silently re-tuned the expensive one); this number is what measuring the
 * expensive class on its own terms produced.
 *
 * ## Which call site this number is actually for
 *
 * Two paths pass it, and only one has a fan-out wide enough to care:
 *
 *   - `listAllBoardCards` — one partition read per BOARD. This node carries two
 *     boards, so it runs 2-wide whatever the constant says. Inert today, and it
 *     is the width's job to still be right if that grows.
 *   - `sweepBoardCardsPartition` — 24 single-field partition queries over ONE
 *     partition: the completeness enumeration behind `doctor` and the HOURLY
 *     `groom board-cards-heal`. This is the live fan-out, and the width decides
 *     how many serial waves it costs, every hour, per board.
 *
 * ## Re-measured 2026-08-04: the shape holds, the numbers fell ~5x
 *
 * Unlike the point-read class, this one did NOT collapse — re-running
 * `scripts/probe-partition-read-concurrency-width.ts` unmodified on lastdbd
 * `0.23.2-409-gee967a073`, same board, same 24 leads:
 *
 * | width | 2026-08-03 | 2026-08-04 | ms/wave now |
 * |---|---|---|---|
 * | 1 | 3923ms | **780ms** | 33 |
 * | 6 | 780ms | **147ms** | 37 |
 * | **12** | 437ms | **98ms** | 49 |
 * | 16 | 458ms | **93ms** | 47 |
 * | 24 | 373ms | **139ms** | 139 |
 *
 * Every conclusion below survives: ms/wave still GROWS with width (33 -> 139),
 * twelve is still the elbow, and twenty-four is still measurably worse than
 * twelve rather than better. A partition read is real work, not just latency,
 * which is exactly why this class kept its shape while the point-read class
 * lost its. Splitting the constant was not tidiness — and this is the run that
 * proves it, because the two classes moved by 5x and 400x respectively.
 *
 * Shed is still zero at every width to 24, and the neighbour is still flat.
 *
 * ## Measured, live primary, 2026-08-03 (absolute values superseded above)
 *
 * `scripts/probe-partition-read-concurrency-width.ts` — the real 24-lead sweep
 * of the live `default` partition, 3 interleaved reps, same leads at every
 * width. A NEIGHBOUR reader (a cheap point read, the shape every other
 * kanban/brain/lastgit process on this primary issues) ran continuously
 * throughout, against a warm 197ms idle control:
 *
 * | width | median ms | waves | ms/wave | shed | neighbour median |
 * |---|---|---|---|---|---|
 * | 1 | 3923 | 24 | 163 | 0 | 166ms |
 * | 2 | 2010 | 12 | 167 | 0 | 171ms |
 * | 4 | 1168 | 6 | 195 | 0 | 182ms |
 * | **6** (the old width) | **780** | **4** | 195 | 0 | 193ms |
 * | 8 | 608 | 3 | 203 | 0 | 188ms |
 * | **12** | **437** | **2** | 219 | 0 | 188ms |
 * | 16 | 458 | 2 | 229 | 0 | 191ms |
 * | 24 | 373 | 1 | 373 | 0 | 185ms |
 *
 * ## What this says that the point-read measurement did not
 *
 * The two cost classes are genuinely different, and the numbers say so rather
 * than the folklore. On POINT reads ms/wave was FLAT across a 24x range of
 * width (181 -> 214) — width bought waves and nothing else. Here ms/wave
 * **grows 163 -> 373**: a partition read really is heavier, and widening it has
 * a per-wave price that widening a point-read pool does not. Splitting the
 * constant was not tidiness.
 *
 * ## Why twelve, and not six, sixteen, or twenty-four
 *
 * Twelve is where the curve stops paying. It halves the hourly sweep (780ms ->
 * 437ms, 1.8x) by collapsing 4 waves into 2. **Sixteen is measurably WORSE than
 * twelve** (458ms) — it buys no wave, only per-wave cost, which is the clearest
 * possible evidence that the elbow is real and not noise. Twenty-four is 15%
 * faster still, and is rejected on design rather than on time: 24 IS the lead
 * count, so a width of 24 means "unbounded for this call site" on precisely the
 * read that would find a shed threshold first — and `listAllBoardCards` would
 * inherit it if this install ever grows past two boards.
 *
 * ## The bound's real justification, finally measured
 *
 * Both widths used to defend themselves with an unmeasured claim about Mini's
 * "too many concurrent reads" shed threshold. On this path, at every width to
 * 24: **zero shed** — no 503, no `service_timeout`. So shed is not the reason.
 *
 * The reason both constants actually gave was politeness to a shared node, and
 * that was the part nobody had ever measured — the point-read probe explicitly
 * said so ("the probe measured THIS client's shed rate, not the effect of a
 * wide fan-out on lastgit and brain"). Measured now: the neighbour sits at
 * **166-193ms across every width from 1 to 24, against a 197ms idle control**.
 * Flat, and never worse than idle. A wide partition fan-out from one kanban
 * process costs the primary's other clients nothing detectable.
 *
 * That is a real result and it is still a bounded one. It measures ONE process
 * widening; a fleet of kanban processes each opening 24 sockets is a different
 * experiment and nobody has run it. Twelve collapses the hourly sweep to two
 * waves while leaving that experiment untaken — and, unlike six, it is a number
 * this path's own evidence produced.
 *
 * Do not raise this to the lead count, and do not alias it to
 * {@link POINT_READ_CONCURRENCY}. `test/concurrency.test.ts` pins both.
 */
export const PARTITION_READ_CONCURRENCY = 12;

/**
 * Map `items` through `fn` with at most `limit` calls in flight.
 *
 * Workers pull from a shared cursor rather than being handed fixed slices, so
 * one slow item cannot leave the other workers idle at the end of the run.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  fn: (item: T, index: number) => Promise<R>,
  limit: number = POINT_READ_CONCURRENCY,
): Promise<R[]> {
  const out = new Array<R>(items.length);
  if (items.length === 0) return out;
  const width = Math.max(1, Math.min(limit, items.length));
  let cursor = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i] as T, i);
    }
  };
  await Promise.all(Array.from({ length: width }, worker));
  return out;
}
