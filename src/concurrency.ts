// Bound independent key reads and retain the input order.
// The request bounds remain unchanged.

export const POINT_READ_CONCURRENCY = 16;

export const PARTITION_READ_CONCURRENCY = 12;

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
