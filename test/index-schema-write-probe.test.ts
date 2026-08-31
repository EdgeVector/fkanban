// The write probe must be callable — and correct — for ALL SEVEN pinned schema
// keys, not just the three RecordTypes.
//
// It used to read `RECORDS[type]` through `schemaFor`/`fieldsFor`/`keyFieldFor`,
// which holds only card/board/milestone, so passing one of the four
// `EXTRA_SCHEMAS` threw `TypeError: undefined is not an object`. That is not a
// scoping decision anyone made: the check was un-writable for the membership
// indexes, so `init` adopted their hashes and `doctor` declared them healthy
// with no proof the node would accept a write there.
//
// Two things must hold for those four, and both are asserted here:
//
//   1. the probe RUNS (it reads the declared definition, not a record-type
//      lookup), and exercises every declared field; and
//   2. its throwaway row lands in its OWN partition — never in a live one.
//      `board_cards` `hash=default` is the partition behind every `kanban
//      list`, and depositing a probe row there was the specific risk that
//      deferred this fix for one run.

import { afterAll, beforeEach, describe, expect, test } from "bun:test";

import { newNodeClient } from "../src/client.ts";
import { probeSchemaWritable, WRITE_PROBE_SLUG } from "../src/record.ts";
import { CARD_OPTIONAL_SCHEMA_FIELDS, EXTRA_SCHEMAS, allPinnedSchemas } from "../src/schemas.ts";
import { handleApiList } from "./http-list.ts";

// Rows keyed by their FULL address — schema, hash key AND range key — because
// the whole question for a HashRange index is which partition the row landed in.
// A fake that keyed on the hash alone could not tell a probe partition from the
// live one, which is exactly the distinction under test.
type Row = { fields: Record<string, unknown>; hash: string; range: string | null };
const store = new Map<string, Row>();
const addr = (schema: string, hash: string, range: string | null) =>
  `${schema}::${hash}::${range ?? ""}`;

// Schemas that reject every write, to prove the not-writable path reports the
// node's reason for an index schema the same way it does for a Card.
const REJECTING = "rejectingindexhash";
// A schema whose delete always fails, to prove a leak is CARRIED, not swallowed.
const DELETE_FAILS = "deletefailsindexhash";

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;

    if (url.pathname === "/api/mutation") {
      const schema = body!.schema as string;
      const fields = (body!.fields_and_values ?? {}) as Record<string, unknown>;
      const key = body!.key_value as { hash: string; range?: string | null };
      const mtype = body!.mutation_type as string;
      const range = key.range ?? null;

      if (schema === REJECTING && mtype !== "delete") {
        return Response.json(
          {
            ok: false,
            error: "unknown_fields",
            message: `Fields not writable on schema '${REJECTING}'.`,
            unknown_fields: Object.keys(fields).sort(),
            available_fields: [],
          },
          { status: 400 },
        );
      }
      if (schema === DELETE_FAILS && mtype === "delete") {
        return Response.json({ ok: false, error: "shed", message: "delete shed" }, { status: 503 });
      }

      if (mtype === "delete") store.delete(addr(schema, key.hash, range));
      else store.set(addr(schema, key.hash, range), { fields, hash: key.hash, range });
      return Response.json({ ok: true, success: true });
    }

    if (url.pathname === "/api/list") return handleApiList(url);
    return Response.json({ error: "unexpected_path", path: url.pathname }, { status: 500 });
  },
});
afterAll(() => server.stop(true));
const baseUrl = `http://127.0.0.1:${server.port}`;
const newNode = () => newNodeClient({ baseUrl, userHash: "u" });

beforeEach(() => store.clear());

describe("probeSchemaWritable over every pinned schema", () => {
  // The structural regression. Before the entry-shaped signature this threw for
  // four of the seven, which is how the membership indexes ended up with no
  // write coverage at all.
  test.each(allPinnedSchemas().map((e) => [e.key, e] as const))(
    "%s is probeable and round-trips",
    async (_key, entry) => {
      const schemaHash = `hash-for-${entry.key}`;
      const r = await probeSchemaWritable(newNode(), schemaHash, entry);
      expect(r.writable).toBe(true);
      expect(r.writable && r.leaked).toBeUndefined();
      // Cleaned up: the store is empty again.
      expect([...store.keys()]).toHaveLength(0);
    },
  );

  test.each(allPinnedSchemas().map((e) => [e.key, e] as const))(
    "%s writes every declared field, keyed at its own address",
    async (_key, entry) => {
      const schemaHash = `hash-for-${entry.key}`;
      const leaky = { ...newNode(), deleteRecord: async () => {} };
      await probeSchemaWritable(leaky, schemaHash, entry);

      const rows = [...store.values()];
      expect(rows).toHaveLength(1);
      const row = rows[0]!;
      const def = entry.schema.schema;

      // Every declared field is exercised — an all-empty write could be
      // silently accepted by a node that drops unknown empties, which is the
      // #94 failure the probe exists to catch. Card is the one record type with
      // fields a legacy catalog may genuinely not carry; the five index schemas
      // have none, so this asserts full coverage for exactly them.
      const optional =
        entry.key === "card" ? new Set<string>(CARD_OPTIONAL_SCHEMA_FIELDS) : new Set<string>();
      for (const f of def.fields) {
        if (optional.has(f)) continue;
        expect(row.fields[f]).toBeDefined();
      }

      // The address is the probe slug on BOTH axes, and the payload copies of
      // the key fields agree with it — a row whose payload key disagrees with
      // its address is the sparse-row shape heal exists to repair.
      expect(row.hash).toBe(WRITE_PROBE_SLUG);
      expect(row.fields[def.key.hash_field]).toBe(WRITE_PROBE_SLUG);
      if (def.key.range_field) {
        expect(row.range).toBe(WRITE_PROBE_SLUG);
        expect(row.fields[def.key.range_field]).toBe(WRITE_PROBE_SLUG);
      } else {
        expect(row.range).toBeNull();
      }
    },
  );

  // The reason this fix was deferred a run: a HashRange throwaway row must not
  // be deposited in a partition real reads serve. Every read of these four
  // indexes is keyed or range-scoped, and heal enumerates the LIVE board list,
  // so confinement to the probe partition is what makes the probe safe to run
  // against the primary on every `kanban doctor`.
  test("no index probe ever writes a live partition", async () => {
    const leaky = { ...newNode(), deleteRecord: async () => {} };
    for (const entry of EXTRA_SCHEMAS) {
      await probeSchemaWritable(leaky, `hash-for-${entry.key}`, entry);
    }
    expect([...store.values()]).toHaveLength(EXTRA_SCHEMAS.length);
    for (const row of store.values()) {
      expect(row.hash).toBe(WRITE_PROBE_SLUG);
      // Named explicitly: `default` is the board partition behind every
      // `kanban list`, and `all_cards` is the single live CardListIndex row.
      expect(row.hash).not.toBe("default");
      expect(row.hash).not.toBe("all_cards");
    }
  });

  test("an index schema the node rejects reports not-writable with the reason", async () => {
    const entry = EXTRA_SCHEMAS.find((e) => e.key === "board_cards")!;
    const r = await probeSchemaWritable(newNode(), REJECTING, entry);
    expect(r.writable).toBe(false);
    if (!r.writable) expect(r.reason).toContain("not writable on schema");
  });

  // A leaked Card probe is filtered from reads and eventually reaped; a leaked
  // INDEX probe is inert AND permanent, because nothing addresses its
  // partition. The verdict still stands — the write path is proven — but the
  // leak is carried so doctor can say it out loud.
  test("a failed cleanup is carried, not swallowed, without flipping the verdict", async () => {
    const entry = EXTRA_SCHEMAS.find((e) => e.key === "board_cards")!;
    const r = await probeSchemaWritable(newNode(), DELETE_FAILS, entry);
    expect(r.writable).toBe(true);
    expect(r.writable && r.leaked).toBeTruthy();
    expect([...store.values()]).toHaveLength(1);
  });
});
