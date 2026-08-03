// Pure shaping of `status.request_ops` into per-schema rows plus a rollup.
//
// Extracted from `scripts/probe-ops-delta.ts` so the arithmetic that decides
// what a chief-engineer run believes about live load is testable without a
// node. The probe is the instrument this workspace reaches for FIRST when
// something looks slow (`CLAUDE.md`: "name the load"), and it had been
// double-counting every operation since it was written.

export type OpRow = {
  client: string;
  kind: string;
  schema?: string;
  count: number;
  sum_ms: number;
  max_ms: number;
  error_count: number;
  sum_cold_shard_loads?: number;
  phase_sums?: Record<string, number>;
};

// NUL, not a space: the separator must be a byte that cannot occur inside a
// client name, a verb, or a schema hash.
//
// Written as the ESCAPE `"\0"`, deliberately. The probe this was extracted from
// carried three RAW NUL BYTES in its source — two in the `keyOf` template and
// one in the matching `split()`. Raw NULs are invisible in editors, in
// `git diff`, and in file-reading tools, so the code read as
// `${r.client} ${r.kind}` — an ordinary space — to anyone looking at it. That
// is a standing trap: a well-meaning "tidy up the template literal" that types
// a real space silently turns `splitKey` into a no-op, and every row's
// `client` becomes the entire key while `kind` and `schema` go `undefined`.
// One named constant in escape form, used by both sides, keeps the separator
// greppable and makes a diff that changes it a diff you can actually see.
export const KEY_SEP = "\0";

export const keyOf = (r: OpRow): string =>
  `${r.client}${KEY_SEP}${r.kind}${KEY_SEP}${r.schema ?? "-"}`;

export const splitKey = (key: string): [string, string, string] =>
  key.split(KEY_SEP) as [string, string, string];

/**
 * The three RANKING tables are per-`(client, kind, schema)` views of the SAME
 * counter objects, so unioning them is right: a row that is top-by-count but
 * not top-by-time still gets tracked, and a row appearing in two tables is the
 * same object twice.
 *
 * `app_verb` is NOT one of them. It is a per-`(client, kind)` ROLLUP — it
 * carries no `schema`, and its `count`/`sum_ms` are the SUM over every schema
 * that client/verb touched. It also carries no `phase_sums` and no
 * `sum_cold_shard_loads`, and adds `p95_ms`/`error_statuses` that the ranking
 * tables lack. Unioning it into one map keyed by {@link keyOf} therefore
 * dedupes against nothing: `schema` is absent, so it lands on its own
 * `"<client>\0<kind>\0-"` key beside the very rows it summarizes.
 *
 * Measured on the live primary 2026-08-03, 120s window, `client=kanban`:
 *
 *     kanban query 39a0424fa085    27 calls   1,663 ms
 *     kanban query bc941dbc630f    70 calls      64 ms
 *     kanban query 53bef61388      23 calls       9 ms
 *     kanban query cceb49df4cba    24 calls       2 ms
 *     kanban query -              144 calls   1,738 ms   <- the rollup
 *                                 ---------  ---------
 *     per-schema total            144 calls   1,738 ms   <- exactly equal
 *
 * So the printed table claimed 288 queries where 144 happened, and invented a
 * phantom `schema=-` workload — precisely the wild-goose chase this probe was
 * written to prevent.
 *
 * The second consequence was quieter and worse. A rollup's `sum_ms` is by
 * construction >= any single per-schema row's, so it always won
 * `sort((a,b) => b.sumMs - a.sumMs)` and became `deltas[0]`, "the worst
 * offender" whose phase breakdown the probe prints. Rollup rows have no
 * `phase_sums`, so that block printed nothing, every run, silently. The phase
 * breakdown is the one thing this probe offers that `lastdb ops` does not, and
 * it had never once fired.
 *
 * The ranking tables legitimately carry `schema`-less rows of their own for
 * verbs that have no schema (`kind=status`, `kind=schema`). Those key to the
 * same string as their rollup would, and dedupe correctly — which is why
 * {@link unattributedRemainder} is computed rather than assumed.
 */
export const RANKING_TABLES = [
  "top_by_total_ms",
  "top_by_count",
  "top_by_cold_shard_loads",
] as const;

export const ROLLUP_TABLE = "app_verb";

/**
 * The table naming every `(client, kind)` whose recorded time is a
 * CLIENT-REQUESTED SLEEP rather than node work.
 *
 * A long-poll watch parks on the node until something changes or the poll times
 * out, so it books ~30s of "duration" while costing the node nothing. `lastdb
 * ops` prints these under their own heading and says so explicitly — "idle
 * long-poll wait (client-requested sleep, NOT node work — excluded from the
 * rankings above)".
 *
 * The raw tables are not so tidy: `local_watch` is ALSO carried in
 * `top_by_count`. Ranking it beside real work put a sleep at the top of the
 * probe's output — measured live 2026-08-03, `lastgit local_watch` booked
 * 120,572ms over a 120s window (4 calls x ~30s), roughly 50x the busiest real
 * row — and, now that the phase breakdown actually fires, handed the breakdown
 * to a row whose only phase is `queue_wait_us` at 0ms/call.
 *
 * `idle_wait` is the node's own answer to "which kinds are sleeps", so it is
 * the authority here rather than a hard-coded `kind === "local_watch"`.
 */
export const IDLE_TABLE = "idle_wait";

export function idleKeys(ops: Record<string, unknown>): Set<string> {
  const out = new Set<string>();
  for (const r of (ops[IDLE_TABLE] as OpRow[] | undefined) ?? []) {
    out.add(`${r.client}${KEY_SEP}${r.kind}`);
  }
  return out;
}

export const isIdle = (idle: Set<string>, client: string, kind: string): boolean =>
  idle.has(`${client}${KEY_SEP}${kind}`);

export function rowsFromRequestOps(ops: Record<string, unknown>): {
  rows: Map<string, OpRow>;
  rollup: Map<string, OpRow>;
  idle: Map<string, OpRow>;
} {
  const idleSet = idleKeys(ops);
  const rows = new Map<string, OpRow>();
  for (const table of RANKING_TABLES) {
    for (const r of (ops[table] as OpRow[] | undefined) ?? []) {
      if (isIdle(idleSet, r.client, r.kind)) continue;
      rows.set(keyOf(r), r);
    }
  }
  const rollup = new Map<string, OpRow>();
  for (const r of (ops[ROLLUP_TABLE] as OpRow[] | undefined) ?? []) {
    if (isIdle(idleSet, r.client, r.kind)) continue;
    rollup.set(`${r.client}${KEY_SEP}${r.kind}`, r);
  }
  const idle = new Map<string, OpRow>();
  for (const r of (ops[IDLE_TABLE] as OpRow[] | undefined) ?? []) {
    idle.set(`${r.client}${KEY_SEP}${r.kind}`, r);
  }
  return { rows, rollup, idle };
}

/**
 * Traffic the rollup saw that the per-schema rows cannot account for.
 *
 * The ranking tables are top-N truncated (32 rows each, across ALL clients), so
 * a low-volume schema can be absent from every one of them while its calls
 * still land in `app_verb`. Reporting `rollup - sum(per-schema)` as an explicit
 * `(unattributed)` row keeps that traffic visible WITHOUT double-counting the
 * rows that are attributed — the property the old union silently traded away.
 *
 * Clamps at zero rather than going negative. Zero is the normal case, and it is
 * also exactly what a schema-less verb like `kind=status` produces: its
 * ranking-table row and its rollup row are the same counter, so the remainder
 * vanishes and nothing extra is printed.
 */
export type Attributable = { client: string; kind: string; count: number; sumMs: number };

export function unattributedRemainder(
  attributed: Iterable<Attributable>,
  rollup: Attributable,
): { count: number; sumMs: number } {
  let count = rollup.count;
  let sumMs = rollup.sumMs;
  for (const r of attributed) {
    if (r.client !== rollup.client || r.kind !== rollup.kind) continue;
    count -= r.count;
    sumMs -= r.sumMs;
  }
  return { count: Math.max(0, count), sumMs: Math.max(0, sumMs) };
}
