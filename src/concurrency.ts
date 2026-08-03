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
 * ## The cost model this number is derived from
 *
 * A point read costs the node ~1.9ms and the caller ~190ms; a bare `fetch` over
 * the same socket costs the same ~190ms. So a read is almost entirely
 * per-request latency, and **the unit of cost is the serial wave**, not the
 * request, the row, or the field (`pickup.ts` states the same rule). Total cost
 * is therefore `ceil(N / width) x ~190ms` — width buys waves, and nothing else.
 *
 * ## Measured, live primary, 2026-08-03
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
 * Six, and separate from {@link POINT_READ_CONCURRENCY} on purpose.
 *
 * `listAllBoardCards` fans out one partition read per board and used to reuse
 * the point-read width, while its own comment admitted the reuse was not
 * justified: *"a partition read is heavier than the point read
 * POINT_READ_CONCURRENCY was sized for. The width is reused rather than
 * re-tuned because the bound here is a LOAD GUARD, not an optimum: what was
 * measured is 2-wide, and widening past that is unmeasured on this path."*
 *
 * That was survivable while the two numbers happened to agree. It stops being
 * survivable the moment either one moves — raising the point-read width to 16
 * on the strength of a POINT-read measurement would have silently widened
 * partition fan-out to 16 as well, on a path whose own documentation says the
 * evidence only reaches 2. One constant serving two cost classes means every
 * future tuning of the cheap class is an unmeasured change to the expensive
 * one.
 *
 * A partition read returns hundreds of rows and is the node's #1 consumer of
 * wall time system-wide (`lastdb ops`: `client=kanban kind=query
 * schema=board_cards`). It is the read that would find a shed threshold first.
 * So it keeps the conservative width until somebody measures THIS path, and
 * `POINT_READ_CONCURRENCY` can now move without dragging it along.
 */
export const PARTITION_READ_CONCURRENCY = 6;

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
