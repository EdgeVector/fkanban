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
 * 2. **A query returns a row only if EVERY projected field has an atom on
 *    it.** A field missing from the SCHEMA is a loud `unknown_fields` error; a
 *    field missing from a ROW is a silent drop of the whole row — no error, no
 *    null, the row simply is not in `results`. So a wide projection is not a
 *    superset read, it is a filter. This is the mechanism behind the
 *    2026-07-23 milestone incident (135 under-projected rows invisible to the
 *    reconciler built to find them), and it is what makes a narrow write
 *    against a missing or partial row a data-loss path: the row it creates is
 *    one no wide reader can see.
 *
 * A fake that ignores the projection cannot reproduce either bug, and cannot
 * prove that the guards against them work. Faithful is the default here.
 *
 * `dropIncompleteRows: false` models a node that has changed its mind and
 * returns incomplete rows instead. It exists for one purpose: a guard whose
 * only job is to be independent of the node's drop behaviour can only be
 * shown to be load-bearing by a fake willing to stop dropping. Do not reach
 * for it to make a failing test pass.
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
        for (const name of fields) projected[name] = rec.fields[name];
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
