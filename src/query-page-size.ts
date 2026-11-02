// A row is planned as its key plus two keys for each projected field. Reserve
// half the native 10,000-key budget, plus one row for continuation probes.
const PLANNED_KEY_BUDGET = 5000;
export const MAX_QUERY_PAGE_SIZE = 128;

export function queryPageSize(fieldCount: number): number {
  if (!Number.isSafeInteger(fieldCount) || fieldCount < 0) {
    throw new RangeError("A query page needs a valid field count.");
  }
  // An empty projection requests all fields. Without a declaration, use one
  // row and leave an unsupported individual record to the native guard.
  if (fieldCount === 0) return 1;
  const rows = Math.min(MAX_QUERY_PAGE_SIZE,
    Math.floor(PLANNED_KEY_BUDGET / (1 + 2 * fieldCount)) - 1);
  if (rows < 1) throw new RangeError("One record exceeds the planned query budget.");
  return rows;
}
