/**
 * ONE in-memory `NodeClient` fake, modelling LastDB the way LastDB actually
 * behaves — replacing the ~40 hand-rolled copies that each modelled it
 * slightly differently.
 *
 * Two node behaviours are load-bearing for fkanban and are the reason this
 * file exists. Both were learned the hard way, on the live primary:
 *
 * 1. **`updateRecord` MERGES; it does not replace.** A 2-field update leaves
 *    the other 22 fields readable at the full projection (measured:
 *    `scripts/probe-narrow-write-shape.ts`). Every hand-rolled fake used to
 *    implement update as a whole-row replace, which is strictly MORE
 *    destructive than production. That sounds safe and is not: it makes a
 *    correct narrow write — now the recommended pattern, since write cost
 *    scales with fields SENT, not fields changed — indistinguishable from
 *    catastrophic field loss. When `Card` was narrowed, 70 tests failed
 *    against the fakes and 0 against the node.
 *
 * 2. **A projection is a FILTER, not a superset read.** A field missing from
 *    the SCHEMA is a loud `unknown_fields` error; a field missing from a ROW is
 *    a silent drop of the whole row — no error, no null, the row simply is not
 *    in `results`. This is the mechanism behind the 2026-07-23 milestone
 *    incident (135 under-projected rows invisible to the reconciler built to
 *    find them), and it is what makes a narrow write against a missing or
 *    partial row a data-loss path: the row it creates is one no wide reader can
 *    see.
 *
 *    **This fake is STRICTER than the node, deliberately, and the gap is now
 *    measured.** It drops a row when ANY projected field lacks an atom. On the
 *    primary the field that LEADS the projection is what gates the row:
 *    `[title,board]` returns the witness row and `[board,title]` does not —
 *    same set, two orders, two answers (2026-08-01,
 *    `scripts/probe-projection-order-dependence.ts` and the three probes after
 *    it). So production returns rows this fake drops, never the reverse.
 *    Stricter is the safe direction for the guards under test here, and
 *    modelling the real rule would rewrite the expectations of ~40 tests, so it
 *    stays — but it is a KNOWN divergence, not fidelity. Do not cite this file
 *    as evidence for what the node does.
 *
 * A fake that ignores the projection cannot reproduce either bug, and cannot
 * prove that the guards against them work. Faithful is the default here.
 *
 * **Rule 2 is CONDITIONAL, and nothing in this repo knows the condition.**
 * Measured on the live primary 2026-08-01
 * (`scripts/probe-projection-rule-regression.ts`,
 * `scripts/probe-wire-projection-semantics.ts`), same node, same client, same
 * query verb:
 *
 *   - `BoardCards`, HashKey=default: `["slug"]` -> 351 rows,
 *     `["slug","milestone"]` -> 332. **19 rows dropped.** Rule 2 holds.
 *   - `MilestoneCards`, one partition: `["slug"]` -> 56 rows, and EVERY payload
 *     field projected one at a time -> 56 rows, 47-56 of them carrying the
 *     field. **Nothing dropped; partial rows returned instead.** The single
 *     exception is `milestone` — the partition key — which drops 7. Rule 2
 *     does not hold.
 *   - `BoardMilestones`, HashKey=default: `completed_at` is projected by every
 *     read and written by no writer; 33 rows return, **0 carry the key**, none
 *     dropped. Rule 2 does not hold.
 *
 * So `dropIncompleteRows` is not "faithful vs. a node that changed its mind" —
 * it selects between two behaviours the node exhibits TODAY on different
 * indexes. It stays `true` by default because that is the stricter model and
 * because BoardCards, the busiest index, still behaves that way. Reach for
 * `false` when the code under test reads an index measured NOT to drop
 * (MilestoneCards, BoardMilestones) — not to make a failing test pass.
 *
 * When it is `false`, a projected field with no atom is OMITTED from `fields`
 * rather than set to `undefined`, because that is what the node does: on the
 * primary, `"completed_at" in row.fields` is false for all 33 BoardMilestones
 * rows. A guard written as `"x" in fields` must fail here for the same reason
 * it would fail in production.
 */
import type {
  NodeClient,
  QueryFilter,
  QueryResponse,
  QueryRow,
} from "../src/client.ts";

export type StoredRecord = {
  keyHash: string;
  rangeKey: string | null;
  fields: Record<string, unknown>;
};

/** One write the code under test issued, in order. */
export type RecordedWrite = {
  op: "create" | "update" | "delete";
  schemaHash: string;
  keyHash: string;
  rangeKey: string | null;
  /** Exactly the fields SENT — the thing a narrow-write test asserts on. */
  fields?: Record<string, unknown>;
};

export type FakeNode = NodeClient & {
  /** Every row currently stored for a schema, whole (not projected). */
  rowsOf(schemaHash: string): StoredRecord[];
  /** One row by key, or undefined. */
  rowAt(schemaHash: string, keyHash: string, rangeKey?: string | null): StoredRecord | undefined;
  /** Put a row directly, bypassing the code under test. */
  seed(opts: {
    schemaHash: string;
    keyHash: string;
    rangeKey?: string | null;
    fields: Record<string, unknown>;
  }): void;
  /** Writes in issue order. */
  writes: RecordedWrite[];
  /**
   * One entry per `updateRecords` REQUEST, holding that request's row keys.
   *
   * `writes` cannot answer "did this batch?" — a batch of 48 and 48 separate
   * writes both append 48 entries to it, and the difference between them is the
   * whole reason the batch path exists (48 partition-gate acquisitions vs one).
   * This is the surface that can tell them apart.
   */
  batches: string[][];
  /** Reads in issue order — `fields` is the projection asked for. */
  reads: Array<{ schemaHash: string; fields: string[]; filter?: QueryFilter }>;
  /** See the file header. Faithful (`true`) unless a test says otherwise. */
  dropIncompleteRows: boolean;
};

export type FakeNodeOptions = {
  baseUrl?: string;
  userHash?: string;
  /** Only for proving a guard is independent of the node's drop rule. */
  dropIncompleteRows?: boolean;
  /** Partial overrides for the rarely-used members (rawCall, listSchemas, …). */
  overrides?: Partial<NodeClient>;
};

const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\u0000${rangeKey ?? ""}`;

const notImpl = (member: string) => async (): Promise<never> => {
  throw new Error(`fakeNode.${member} not implemented`);
};

/**
 * Matches the four filter shapes fkanban actually sends: `HashKey`,
 * `HashRangePrefix`, `HashRangeKey`, and plain field equality.
 *
 * The key-shaped filters address the row; anything else compares against
 * stored field values, which is how callers like `findCard` look a card up by
 * `slug` on a schema whose hash key is something else.
 */
function matchesFilter(rec: StoredRecord, filter?: QueryFilter): boolean {
  if (!filter) return true;
  const f = filter as Record<string, unknown>;

  if (typeof f.HashKey === "string") return rec.keyHash === f.HashKey;

  const prefix = f.HashRangePrefix as { hash: string; prefix: string } | undefined;
  if (prefix) {
    return rec.keyHash === prefix.hash && (rec.rangeKey ?? "").startsWith(prefix.prefix);
  }

  const exact = f.HashRangeKey as { hash: string; range: string } | undefined;
  if (exact) return rec.keyHash === exact.hash && (rec.rangeKey ?? "") === exact.range;

  return Object.entries(f).every(([field, value]) => rec.fields[field] === value);
}

export function fakeNode(opts: FakeNodeOptions = {}): FakeNode {
  const store = new Map<string, Map<string, StoredRecord>>();
  const writes: RecordedWrite[] = [];
  const batches: string[][] = [];
  const reads: Array<{ schemaHash: string; fields: string[]; filter?: QueryFilter }> = [];

  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };

  const node: FakeNode = {
    baseUrl: opts.baseUrl ?? "http://unused.invalid",
    userHash: opts.userHash ?? "test-user",
    dropIncompleteRows: opts.dropIncompleteRows ?? true,
    writes,
    batches,
    reads,

    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),

    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      writes.push({ op: "create", schemaHash, keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },

    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      writes.push({ op: "update", schemaHash, keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
      const key = storeKey(keyHash, rangeKey);
      const prior = tableFor(schemaHash).get(key);
      // MERGE, not replace. And note that an update against a row that does
      // not exist SUCCEEDS and stores exactly the subset sent — LastDB's
      // update-on-missing-row is a silent upsert, which is precisely how a
      // narrow write manufactures an unreadable row.
      tableFor(schemaHash).set(key, {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...prior?.fields, ...fields },
      });
    },

    // Implemented — NOT left off — so the batch write path is exercised rather
    // than falling back to per-row here and shipping untested. Each row lands
    // through the same merge `updateRecord` does and is recorded in `writes` in
    // order, so assertions written against per-row writes keep reading true;
    // `batches` is what distinguishes "N rows written" from "N rows written in
    // one request", which is the entire point of the path under test.
    async updateRecords(rows) {
      batches.push(rows.map((row) => row.rangeKey ?? row.keyHash));
      for (const { schemaHash, fields, keyHash, rangeKey } of rows) {
        writes.push({ op: "update", schemaHash, keyHash, rangeKey: rangeKey ?? null, fields: { ...fields } });
        const key = storeKey(keyHash, rangeKey);
        const prior = tableFor(schemaHash).get(key);
        tableFor(schemaHash).set(key, {
          keyHash,
          rangeKey: rangeKey ?? null,
          fields: { ...prior?.fields, ...fields },
        });
      }
    },

    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      writes.push({ op: "delete", schemaHash, keyHash, rangeKey: rangeKey ?? null });
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },

    async queryAll({ schemaHash, fields, filter }): Promise<QueryResponse> {
      reads.push({ schemaHash, fields, filter });
      const results: QueryRow[] = [];
      for (const rec of tableFor(schemaHash).values()) {
        if (!matchesFilter(rec, filter)) continue;
        // THE RULE: any projected field with no atom on this row drops the row.
        if (node.dropIncompleteRows && fields.some((name) => !(name in rec.fields))) continue;
        const projected: Record<string, unknown> = {};
        // Absent is ABSENT — not a key holding `undefined`. The node omits it.
        for (const name of fields) {
          if (name in rec.fields) projected[name] = rec.fields[name];
        }
        results.push({ fields: projected, key: { hash: rec.keyHash, range: rec.rangeKey } });
      }
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },

    rawCall: notImpl("rawCall") as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),

    rowsOf(schemaHash: string) {
      return [...tableFor(schemaHash).values()];
    },
    rowAt(schemaHash: string, keyHash: string, rangeKey?: string | null) {
      return tableFor(schemaHash).get(storeKey(keyHash, rangeKey));
    },
    seed({ schemaHash, keyHash, rangeKey, fields }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },

    ...opts.overrides,
  };

  return node;
}
