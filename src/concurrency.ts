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
 * Default fan-out width for point-read pools.
 *
 * Six is enough to hide socket latency on a few-hundred-card board without
 * looking like a scraper. Deliberately modest: a `rows=1` Card point-read
 * averages ~2s on the primary under the 0.23.1 HashGroup warm-cap read
 * regression, so a wide pool buys little and risks the shed threshold.
 */
export const POINT_READ_CONCURRENCY = 6;

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
