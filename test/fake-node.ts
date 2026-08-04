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
 *    The rule is **HASH-ELSE-LEAD**, measured 2026-08-04, and it is the
 *    DEFAULT here since that date: one gate, which is the HASH field when the
 *    projection contains it and the LEADING field otherwise
 *    (`scripts/probe-projection-rule-constructed.ts`, four constructed rows
 *    with verified atom sets, 51 projections, 204 judgements — LEAD 191/13,
 *    ANY 173/31, LEAD+KEY 193/11, HASH-ELSE-LEAD 204/0).
 *
 *    The superseded `any_missing` was not merely "stricter". It drops rows the
 *    node returns (`[title,kind]` returns a row missing `kind`) and it is
 *    silent about the one thing that really does gate (`[slug,milestone]` drops
 *    a row carrying `slug`, because `milestone` is the hash field). The earlier
 *    order-dependence reading — `[title,board]` returns a witness that
 *    `[board,title]` does not — is the same fact seen through the LEAD model:
 *    the hash field gates from either position, and the order was a coincidence
 *    of where it sat.
 *
 *    **Declare `hashFields` whenever the test is about the projection.** With
 *    no entry for a schema the gate falls back to the LEADING field, which is
 *    the right default for the many tests that seed complete rows and are not
 *    about projection at all — but it is NOT the node's answer for the
 *    membership indexes, whose gate is a field the declared layout does not
 *    name. See {@link FakeNodeOptions.hashFields}.
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
  /**
   * Hash FIELD name per schema hash — what `hash_else_lead` needs to know.
   *
   * A projection rule that turns on which field is the partition key cannot be
   * modelled without this, and there is nothing in a schema hash to derive it
   * from, so the test states it.
   */
  hashFields: Record<string, string>;
  /** See {@link FakeNodeOptions.projectionRule}. */
  projectionRule: "any_missing" | "hash_else_lead";
};

export type FakeNodeOptions = {
  baseUrl?: string;
  userHash?: string;
  /**
   * Only for proving a guard is independent of the node's drop rule. `false`
   * means DROP NOTHING and is honoured under both projection rules — see the
   * note in `queryAll` for the 2026-08-04 bug where it was not.
   */
  dropIncompleteRows?: boolean;
  /**
   * Which projection rule to apply. Default `hash_else_lead` — the rule the
   * node was measured to apply (see the file header).
   *
   * `any_missing` is the superseded historical model, kept only so a test can
   * state that a guard holds even under a drop rule stricter than the node's.
   * Do not reach for it to describe what the node does.
   */
  projectionRule?: "any_missing" | "hash_else_lead";
  /**
   * Hash field name per schema hash — the gate `hash_else_lead` applies when
   * the projection contains it. Omit and the gate is the LEADING field.
   *
   * **This is the LIVE catalog `hash_field`, which for the membership indexes
   * is NOT the one `src/schemas.ts` declares.** After the 2026-07-23 multi-key
   * expand, BoardCards' catalog `hash_field` reads `milestone` even though its
   * declared layout says `board` (`src/membership_schema_guard.ts`), so every
   * BoardCards read that projects `milestone` is gated on `milestone` and a row
   * with no `milestone` atom is silently absent. Deriving these from the
   * declared schema would therefore model the wrong gate — state the live one.
   */
  hashFields?: Record<string, string>;
  /** Partial overrides for the rarely-used members (rawCall, listSchemas, …). */
  overrides?: Partial<NodeClient>;
};

const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\u0000${rangeKey ?? ""}`;

const notImpl = (member: string) => async (): Promise<never> => {
  throw new Error(`fakeNode.${member} not implemented`);
};

/**
 * Matches the five filter shapes fkanban actually sends: `HashKey`,
 * `HashRangePrefix`, `HashRangeKey`, `HashRangeRange`, and plain field
 * equality.
 *
 * Every one of them must be listed here, not just the ones a test happens to
 * exercise. An unknown key-shaped filter falls through to the field-equality
 * branch below, where it compares a filter OBJECT against a stored string and
 * matches nothing — so a new filter shape does not fail loudly, it silently
 * returns zero rows, and a test asserting "the terminal column was excluded"
 * passes because everything was.
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

  // Inclusive start, exclusive end — fold's `HashRangeFilter::HashRangeRange`.
  const range = f.HashRangeRange as { hash: string; start: string; end: string } | undefined;
  if (range) {
    const rk = rec.rangeKey ?? "";
    return rec.keyHash === range.hash && rk >= range.start && rk < range.end;
  }

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
    projectionRule: opts.projectionRule ?? "hash_else_lead",
    hashFields: opts.hashFields ?? {},
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
      const hashField = node.hashFields[schemaHash];
      for (const rec of tableFor(schemaHash).values()) {
        if (!matchesFilter(rec, filter)) continue;
        // `dropIncompleteRows: false` means DROP NOTHING, and it has to mean
        // that under BOTH rules. It is the opt-out for tests proving a guard
        // holds independently of the node's drop rule, so a rule that gates
        // anyway makes those tests measure the opposite of what they claim.
        // Until 2026-08-04 the `hash_else_lead` branch ran ahead of this check
        // and gated regardless; three tests that had opted out were silently
        // still being filtered, and said so only when the default changed
        // underneath them.
        if (node.dropIncompleteRows) {
          if (node.projectionRule === "hash_else_lead") {
            // The MEASURED rule. One gate, not a conjunction: the hash field when
            // it is projected, the leading field otherwise. A row missing some
            // other projected field is returned WITHOUT that field — which is why
            // this is not simply a weaker `any_missing`.
            const gate = hashField && fields.includes(hashField) ? hashField : fields[0];
            if (gate !== undefined && !(gate in rec.fields)) continue;
          } else if (fields.some((name) => !(name in rec.fields))) {
            // The historical model: any projected field with no atom drops the row.
            continue;
          }
        }
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
