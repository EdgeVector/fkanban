// `status.request_ops` carries FOUR tables, and only three of them are
// per-`(client, kind, schema)` rankings of the same counter objects. The
// fourth, `app_verb`, is a per-`(client, kind)` ROLLUP with no `schema` and no
// `phase_sums`.
//
// `probe-ops-delta.ts` unioned all four into one map keyed by
// `client\0kind\0schema`. The rollup's absent `schema` rendered as "-", so it
// never collided with the rows it summarizes — it was ADDED beside them. Every
// operation was counted twice, and a phantom `schema=-` workload appeared in
// the one instrument this workspace uses to decide what is actually costing the
// node time.
//
// The fixtures below are the real shape, taken from the live primary on
// 2026-08-03 (120s window, client=kanban): four per-schema query rows summing
// to exactly the rollup's 144 calls / 1,738 ms.
import { describe, expect, test } from "bun:test";

import {
  KEY_SEP,
  ROLLUP_TABLE,
  RANKING_TABLES,
  keyOf,
  rowsFromRequestOps,
  splitKey,
  unattributedRemainder,
  type OpRow,
} from "../scripts/lib/ops-delta-rows.ts";

const row = (o: Partial<OpRow> & { client: string; kind: string; count: number; sum_ms: number }): OpRow => ({
  max_ms: 0,
  error_count: 0,
  ...o,
});

/** The live shape: per-schema rows in the rankings, a rollup in `app_verb`. */
function liveOps(): Record<string, unknown> {
  const perSchema = [
    row({ client: "kanban", kind: "query", schema: "39a0424fa085", count: 27, sum_ms: 1663, phase_sums: { hydrate: 900_000, count: 700_000 } }),
    row({ client: "kanban", kind: "query", schema: "bc941dbc630f", count: 70, sum_ms: 64 }),
    row({ client: "kanban", kind: "query", schema: "53bef61388aa", count: 23, sum_ms: 9 }),
    row({ client: "kanban", kind: "query", schema: "cceb49df4cba", count: 24, sum_ms: 2 }),
    // A schema-less verb DOES legitimately appear in the ranking tables.
    row({ client: "kanban", kind: "status", count: 8, sum_ms: 46 }),
  ];
  return {
    top_by_total_ms: perSchema,
    top_by_count: perSchema,
    top_by_cold_shard_loads: perSchema,
    app_verb: [
      // Rollups: no `schema`, no `phase_sums`. 27+70+23+24 = 144, 1663+64+9+2 = 1738.
      row({ client: "kanban", kind: "query", count: 144, sum_ms: 1738 }),
      row({ client: "kanban", kind: "status", count: 8, sum_ms: 46 }),
    ],
  };
}

describe("request_ops table shaping", () => {
  test("the rollup table is kept OUT of the per-schema rows", () => {
    const { rows, rollup } = rowsFromRequestOps(liveOps());

    // Five distinct per-schema keys, and not one of them is the query rollup.
    expect(rows.size).toBe(5);
    expect(rows.has(keyOf(row({ client: "kanban", kind: "query", count: 0, sum_ms: 0 })))).toBe(false);

    // The rollup is available, keyed WITHOUT a schema component.
    expect(rollup.get(`kanban${KEY_SEP}query`)?.count).toBe(144);
  });

  test("per-schema calls are not double-counted against the rollup", () => {
    const { rows, rollup } = rowsFromRequestOps(liveOps());

    const queries = [...rows.values()].filter((r) => r.kind === "query");
    const attributedCalls = queries.reduce((s, r) => s + r.count, 0);
    const attributedMs = queries.reduce((s, r) => s + r.sum_ms, 0);

    // This is the equality that proves the rollup is a SUM, not extra traffic.
    expect(attributedCalls).toBe(144);
    expect(attributedMs).toBe(1738);
    expect(rollup.get(`kanban${KEY_SEP}query`)!.count).toBe(attributedCalls);

    // The old union produced 144 + 144. Pin that it no longer can.
    const total = [...rows.values()].filter((r) => r.kind === "query").length;
    expect(total).toBe(4);
  });

  test("a fully-attributed rollup leaves no remainder", () => {
    const { rows, rollup } = rowsFromRequestOps(liveOps());
    const attributed = [...rows.values()].map((r) => ({
      client: r.client,
      kind: r.kind,
      count: r.count,
      sumMs: r.sum_ms,
    }));
    const q = rollup.get(`kanban${KEY_SEP}query`)!;

    expect(
      unattributedRemainder(attributed, {
        client: q.client,
        kind: q.kind,
        count: q.count,
        sumMs: q.sum_ms,
      }),
    ).toEqual({ count: 0, sumMs: 0 });
  });

  test("a schema-less verb dedupes against its own rollup rather than doubling", () => {
    const { rows, rollup } = rowsFromRequestOps(liveOps());
    const attributed = [...rows.values()].map((r) => ({
      client: r.client,
      kind: r.kind,
      count: r.count,
      sumMs: r.sum_ms,
    }));
    const s = rollup.get(`kanban${KEY_SEP}status`)!;

    // `kind=status` has no schema, so its ranking row and its rollup row are
    // the SAME counter — remainder must be zero, not another 8 calls.
    expect(
      unattributedRemainder(attributed, {
        client: s.client,
        kind: s.kind,
        count: s.count,
        sumMs: s.sum_ms,
      }),
    ).toEqual({ count: 0, sumMs: 0 });
  });

  test("traffic the top-N rankings truncated away is surfaced, not lost", () => {
    // The ranking tables are top-32 across ALL clients, so a low-volume schema
    // can be missing from every one of them. That traffic must still show up.
    const ops = liveOps();
    (ops.app_verb as OpRow[])[0]!.count = 200; // rollup saw 56 more than the rankings list
    (ops.app_verb as OpRow[])[0]!.sum_ms = 1938;

    const { rows, rollup } = rowsFromRequestOps(ops);
    const attributed = [...rows.values()].map((r) => ({
      client: r.client,
      kind: r.kind,
      count: r.count,
      sumMs: r.sum_ms,
    }));
    const q = rollup.get(`kanban${KEY_SEP}query`)!;

    expect(
      unattributedRemainder(attributed, {
        client: q.client,
        kind: q.kind,
        count: q.count,
        sumMs: q.sum_ms,
      }),
    ).toEqual({ count: 56, sumMs: 200 });
  });

  test("remainder clamps at zero instead of going negative", () => {
    const attributed = [{ client: "kanban", kind: "query", count: 500, sumMs: 900 }];
    expect(
      unattributedRemainder(attributed, { client: "kanban", kind: "query", count: 10, sumMs: 10 }),
    ).toEqual({ count: 0, sumMs: 0 });
  });

  test("only the ranking tables carry phase sums — the rollup never does", () => {
    // This is why the probe's phase breakdown must not blindly take deltas[0]:
    // the rollup outranks every real row by construction and has no phases.
    const { rows, rollup } = rowsFromRequestOps(liveOps());
    const withPhases = [...rows.values()].filter((r) => r.phase_sums);
    expect(withPhases).toHaveLength(1);
    expect(withPhases[0]!.schema).toBe("39a0424fa085");
    for (const r of rollup.values()) expect(r.phase_sums).toBeUndefined();
  });
});

describe("the NUL key separator", () => {
  test("keyOf and splitKey round-trip a schema hash", () => {
    const r = row({ client: "kanban", kind: "query", schema: "39a0424fa085", count: 1, sum_ms: 1 });
    expect(splitKey(keyOf(r))).toEqual(["kanban", "query", "39a0424fa085"]);
  });

  test("the separator is NUL, not a space", () => {
    // A space would collide with nothing today, but the whole point is that the
    // separator cannot appear inside a component. Pinning the byte keeps a
    // "tidy up the template literal" edit from silently breaking splitKey —
    // the source used to carry RAW NUL bytes, invisible in every editor.
    expect(KEY_SEP).toBe("\0");
    expect(keyOf(row({ client: "a", kind: "b", schema: "c", count: 0, sum_ms: 0 }))).toBe("a\0b\0c");
  });

  test("a missing schema renders as a dash so rollups stay distinguishable", () => {
    expect(keyOf(row({ client: "kanban", kind: "status", count: 0, sum_ms: 0 }))).toBe(
      `kanban${KEY_SEP}status${KEY_SEP}-`,
    );
  });
});

describe("idle long-poll waits", () => {
  // A watch parks on the node for ~30s and costs it nothing. `lastdb ops`
  // excludes these from its rankings and says so; the raw tables do not — the
  // live primary carries `lastgit local_watch` in BOTH `top_by_count` and
  // `idle_wait`. Ranked beside real work it booked 120,572ms over a 120s
  // window (4 calls x ~30s), ~50x the busiest real row.
  const opsWithWatch = () => ({
    top_by_count: [
      row({ client: "lastgit", kind: "local_watch", count: 4, sum_ms: 120_572 }),
      row({ client: "kanban", kind: "query", schema: "39a0424fa085", count: 31, sum_ms: 2123 }),
    ],
    idle_wait: [row({ client: "lastgit", kind: "local_watch", count: 4, sum_ms: 120_572 })],
  });

  test("an idle kind is kept out of the ranked rows", () => {
    const { rows, idle } = rowsFromRequestOps(opsWithWatch());
    expect([...rows.values()].map((r) => r.kind)).toEqual(["query"]);
    expect(idle.get(`lastgit${KEY_SEP}local_watch`)?.sum_ms).toBe(120_572);
  });

  test("the busiest real row is no longer outranked by a sleep", () => {
    const { rows } = rowsFromRequestOps(opsWithWatch());
    const ranked = [...rows.values()].sort((a, b) => b.sum_ms - a.sum_ms);
    expect(ranked[0]!.schema).toBe("39a0424fa085");
    expect(ranked[0]!.sum_ms).toBe(2123);
  });

  test("an idle kind is excluded from the rollup too", () => {
    const ops = {
      ...opsWithWatch(),
      app_verb: [row({ client: "lastgit", kind: "local_watch", count: 4, sum_ms: 120_572 })],
    };
    const { rollup } = rowsFromRequestOps(ops);
    expect(rollup.has(`lastgit${KEY_SEP}local_watch`)).toBe(false);
  });

  test("idle_wait is the authority, not a hard-coded kind name", () => {
    // Same rows, but the node does NOT call local_watch idle. It must then be
    // ranked like any other work rather than silently dropped by a name match.
    const ops = { top_by_count: opsWithWatch().top_by_count };
    const { rows, idle } = rowsFromRequestOps(ops);
    expect(idle.size).toBe(0);
    expect([...rows.values()].map((r) => r.kind).sort()).toEqual(["local_watch", "query"]);
  });
});

describe("table classification", () => {
  test("app_verb is not one of the ranking tables", () => {
    expect(RANKING_TABLES).not.toContain(ROLLUP_TABLE as never);
    expect(RANKING_TABLES).toEqual(["top_by_total_ms", "top_by_count", "top_by_cold_shard_loads"]);
    expect(ROLLUP_TABLE).toBe("app_verb");
  });

  test("an absent table is tolerated (older nodes)", () => {
    const { rows, rollup } = rowsFromRequestOps({});
    expect(rows.size).toBe(0);
    expect(rollup.size).toBe(0);
  });
});
