// fkanban #94 regression: the Card schema's new structured fields must be
// WRITABLE on the node, and `init`/`doctor` must never adopt a schema hash the
// node would reject every write against.
//
// Root cause (verified 2026-06-25 against :9001 + the prod schema_service):
// TWO `fkanban/Card` schemas were loaded — the current full-field one AND a stale
// 10-field duplicate. `init`'s old resolver picked the FIRST descriptive_name
// match, which could be the stale 10-field hash; it then pinned config to it and
// EVERY `fkanban add` 400'd (fkanban always emits the full field set). The fix:
//   1. resolveLoadedSchema prefers the candidate whose fields SUPERSET the local
//      definition (the writable version), and reports `narrower` when none does.
//   2. a write probe (create+delete of an all-fields record) is the runtime
//      backstop; init refuses to adopt — and doctor goes red — when it fails.
//   3. the node's raw 400 body (unknown/available fields) is surfaced.

import { afterAll, describe, expect, test } from "bun:test";

import { FkanbanError, newNodeClient, type LoadedSchema } from "../src/client.ts";
import { listCards, probeSchemaWritable, WRITE_PROBE_SLUG } from "../src/record.ts";
import type { Config } from "../src/config.ts";
import { fieldsFor, resolveLoadedSchema } from "../src/schemas.ts";

// The current full Card hash (writable) and a stale 10-field duplicate.
const FULL_CARD_HASH = "fullcardhash";
const STALE_CARD_HASH = "stale10fieldcardhash";
const OLD_FIELDS = [
  "slug",
  "title",
  "body",
  "board",
  "column",
  "position",
  "assignee",
  "tags",
  "created_at",
  "updated_at",
];

function loaded(name: string, fields: string[]): LoadedSchema {
  return { name, descriptive_name: "Card", owner_app_id: "fkanban", fields };
}

describe("resolveLoadedSchema (field-superset preference)", () => {
  const fullCard = loaded(FULL_CARD_HASH, fieldsFor("card"));
  const staleCard = loaded(STALE_CARD_HASH, OLD_FIELDS);

  test("prefers the schema whose fields superset the local definition", () => {
    // Stale listed FIRST — the old `loaded.find` would have wrongly picked it.
    const r = resolveLoadedSchema("card", [staleCard, fullCard]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.hash).toBe(FULL_CARD_HASH);
      expect(r.ambiguous).toBe(false);
    }
  });

  test("order-independent: full first also resolves to the full hash", () => {
    const r = resolveLoadedSchema("card", [fullCard, staleCard]);
    expect(r.kind === "ok" && r.hash).toBe(FULL_CARD_HASH);
  });

  test("reports `narrower` (with the missing fields) when only a stale schema is loaded", () => {
    const r = resolveLoadedSchema("card", [staleCard]);
    expect(r.kind).toBe("narrower");
    if (r.kind === "narrower") {
      expect(r.hash).toBe(STALE_CARD_HASH);
      // Every new #94 field is reported missing.
      expect(r.missingFields).toEqual(
        expect.arrayContaining([
          "repo",
          "base",
          "kind",
          "block_status",
          "block_reason",
          "north_star",
          "pr_url",
          "branch",
        ]),
      );
    }
  });

  test("reports `missing` when no fkanban/Card is loaded at all", () => {
    expect(resolveLoadedSchema("card", []).kind).toBe("missing");
    // Wrong owner / wrong descriptive_name do not match.
    expect(
      resolveLoadedSchema("card", [
        { name: "x", descriptive_name: "Card", owner_app_id: "other", fields: fieldsFor("card") },
        { name: "y", descriptive_name: "Board", owner_app_id: "fkanban", fields: fieldsFor("card") },
      ]).kind,
    ).toBe("missing");
  });

  test("flags benign ambiguity when 2+ write-compatible versions are loaded", () => {
    const r = resolveLoadedSchema("card", [
      fullCard,
      loaded("anotherfullhash", fieldsFor("card")),
    ]);
    expect(r.kind === "ok" && r.ambiguous).toBe(true);
  });
});

// A stub node that models the #94 split: writes against FULL_CARD_HASH succeed
// (and round-trip), writes against STALE_CARD_HASH 400 exactly as the real node
// does (`unknown_fields` + `available_fields`). One in-memory store keyed by
// schema+slug lets the probe's create+delete and a real readback work.
const store = new Map<string, Record<string, unknown>>();
const k = (schema: string, hash: string) => `${schema}::${hash}`;

const server = Bun.serve({
  port: 0,
  async fetch(req) {
    const url = new URL(req.url);
    const body = req.method === "POST" ? ((await req.json()) as Record<string, unknown>) : undefined;

    if (url.pathname === "/api/mutation") {
      const schema = body!.schema as string;
      const fields = (body!.fields_and_values ?? {}) as Record<string, unknown>;
      const keyHash = (body!.key_value as { hash: string }).hash;
      const mtype = body!.mutation_type as string;

      if (schema === STALE_CARD_HASH) {
        const unknown = Object.keys(fields).filter((f) => !OLD_FIELDS.includes(f));
        if (mtype !== "delete" && unknown.length > 0) {
          return Response.json(
            {
              ok: false,
              error: "unknown_fields",
              message: `Fields ${unknown.map((f) => `'${f}'`).join(", ")} not writable on schema '${STALE_CARD_HASH}'. Available: ${OLD_FIELDS.join(", ")}`,
              unknown_fields: unknown.sort(),
              available_fields: OLD_FIELDS,
            },
            { status: 400 },
          );
        }
      }
      if (mtype === "delete") store.delete(k(schema, keyHash));
      else store.set(k(schema, keyHash), fields);
      return Response.json({ ok: true, success: true });
    }

    if (url.pathname === "/api/query") {
      const schema = body!.schema_name as string;
      const filter = body!.filter as { HashKey?: string } | undefined;
      const want = filter?.HashKey;
      const rows = [...store.entries()]
        .filter(([key]) => key.startsWith(`${schema}::`))
        .map(([key, fields]) => ({ fields, key: { hash: key.split("::")[1]!, range: null } }))
        .filter((r) => want === undefined || r.key.hash === want);
      return Response.json({ ok: true, results: rows, has_more: false });
    }

    return Response.json({ error: "unexpected_path", path: url.pathname }, { status: 500 });
  },
});
afterAll(() => server.stop(true));
const baseUrl = `http://127.0.0.1:${server.port}`;

describe("probeSchemaWritable", () => {
  test("returns writable + cleans up when the node accepts all fields", async () => {
    const node = newNodeClient({ baseUrl, userHash: "u" });
    const r = await probeSchemaWritable(node, FULL_CARD_HASH, "card");
    expect(r.writable).toBe(true);
    // The throwaway probe record was deleted (store has no FULL_CARD_HASH key).
    expect([...store.keys()].some((key) => key.startsWith(`${FULL_CARD_HASH}::`))).toBe(false);
  });

  test("returns not-writable carrying the node's reason on a #94-style 400", async () => {
    const node = newNodeClient({ baseUrl, userHash: "u" });
    const r = await probeSchemaWritable(node, STALE_CARD_HASH, "card");
    expect(r.writable).toBe(false);
    if (!r.writable) {
      expect(r.reason).toContain("not writable on schema");
      // The new fields are named in the surfaced reason.
      expect(r.reason).toContain("repo");
    }
  });

  test("returns writable and hides a leaked probe when cleanup delete fails", async () => {
    const schemaHash = "deletefailurefullcardhash";
    const realNode = newNodeClient({ baseUrl, userHash: "u" });
    const leakyNode = {
      ...realNode,
      deleteRecord: async () => {
        throw new Error("shed delete");
      },
    };
    const cfg: Config = {
      configVersion: 1,
      nodeUrl: baseUrl,
      schemaServiceUrl: baseUrl,
      userHash: "u",
      schemaHashes: { card: schemaHash, board: "unusedboardhash" },
    };

    const r = await probeSchemaWritable(leakyNode, schemaHash, "card");
    expect(r.writable).toBe(true);
    expect([...store.keys()].some((key) => key === `${schemaHash}::${WRITE_PROBE_SLUG}`)).toBe(true);

    const cards = await listCards(realNode, cfg);
    expect(cards.map((c) => c.slug)).not.toContain(WRITE_PROBE_SLUG);

    await realNode.deleteRecord({ schemaHash, keyHash: WRITE_PROBE_SLUG });
  });
});

describe("write+read-back of every structured field against a (full-schema) node", () => {
  test("each new #94 field persists and reads back its non-empty value", async () => {
    const node = newNodeClient({ baseUrl, userHash: "u" });
    const fields: Record<string, unknown> = {};
    for (const f of fieldsFor("card")) fields[f] = f === "tags" || f === "deps" ? [`${f}-1`] : `val-${f}`;
    fields.slug = "rt-card";

    await node.createRecord({ schemaHash: FULL_CARD_HASH, fields, keyHash: "rt-card" });
    const res = await node.queryAll({
      schemaHash: FULL_CARD_HASH,
      fields: fieldsFor("card"),
      filter: { HashKey: "rt-card" },
    });
    expect(res.results).toHaveLength(1);
    const back = res.results[0]!.fields;
    for (const f of [
      "repo",
      "base",
      "kind",
      "deps",
      "block_status",
      "block_reason",
      "north_star",
      "pr_url",
      "branch",
    ]) {
      if (f === "deps") expect(back[f]).toEqual(["deps-1"]);
      else expect(back[f]).toBe(`val-${f}`);
    }
    await node.deleteRecord({ schemaHash: FULL_CARD_HASH, keyHash: "rt-card" });
  });
});

describe("mapNodeError surfaces the raw 400 body", () => {
  test("a #94 unknown_fields 400 names the unwritable fields + the writable set, and does NOT advise `fkanban init`", async () => {
    const node = newNodeClient({ baseUrl, userHash: "u" });
    let err: unknown;
    try {
      await node.createRecord({
        schemaHash: STALE_CARD_HASH,
        fields: { slug: "x", repo: "EdgeVector/fold", base: "main" },
        keyHash: "x",
      });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(FkanbanError);
    const fe = err as FkanbanError;
    expect(fe.code).toBe("unknown_fields");
    // The raw reason is surfaced (not a bare "returned HTTP 400.").
    expect(fe.message).toContain("not writable on schema");
    expect(fe.message).toContain("repo");
    // The footgun hint is gone: doctor is recommended, blind `fkanban init` is not.
    expect(fe.hint ?? "").toContain("doctor");
    expect(fe.hint ?? "").not.toMatch(/re-run `fkanban init` to re-register/);
  });
});
