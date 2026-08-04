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
import { CARD_OPTIONAL_SCHEMA_FIELDS, UNIQUE_SCHEMAS, fieldsFor, resolveLoadedSchema } from "../src/schemas.ts";

// The catalog entry the probe now takes (it reads the DECLARED definition, so it
// is callable for the four index schemas too — see `probeSchemaWritable`).
const CARD_ENTRY = UNIQUE_SCHEMAS.find((e) => e.key === "card")!;

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

function loaded(
  name: string,
  fields: string[],
  opts: {
    descriptive_name?: string;
    key?: { hash_field: string; range_field: string | null } | null;
  } = {},
): LoadedSchema {
  return {
    name,
    descriptive_name: opts.descriptive_name ?? "Card",
    owner_app_id: "fkanban",
    fields,
    // Entities are Hash-keyed by `slug` unless a test says otherwise.
    key: opts.key === undefined ? { hash_field: "slug", range_field: null } : opts.key,
  };
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
        loaded("x", fieldsFor("card")),
        loaded("y", fieldsFor("card"), { descriptive_name: "Board" }),
      ].map((s, i) => (i === 0 ? { ...s, owner_app_id: "other" } : s))).kind,
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

// Regression: the pick among several write-compatible versions must not depend
// on the node's listing order, because that order is NOT stable across restarts.
//
// Measured on the live primary 2026-07-30. Six `fkanban/Card` schemas are loaded,
// all Hash/`slug`, so the layout filter separates none of them. The required Card
// field set is 19 (23 minus 4 optional), so the 19/21/22/23-field versions are ALL
// write-compatible. Before the 21:58Z node restart the configured 23-field
// `bc941d…` sorted first and `superset[0]` was right by luck; after the restart the
// 19-field `eacad7…` sorted first (position 450 vs 576), the pick moved, and
// `kanban doctor` exited 1 — on a board that had never lost a write — advising
// `kanban init`, which declares by definition and returns the same configured hash.
describe("resolveLoadedSchema (stable ranking among write-compatible versions)", () => {
  // The real primary's six, with the field counts and hashes it reports.
  const CONFIG_HASH = "bc941dbc630f"; // 23 fields — what config pins
  const NARROW_OK = "eacad7322a1e"; //  19 fields — exactly the required set
  const cards23 = loaded(CONFIG_HASH, fieldsFor("card"));
  const cards22 = loaded("5c064c3e9204", fieldsFor("card").filter((f) => f !== "db"));
  const cards21 = loaded("35b0d28467ed", fieldsFor("card").filter((f) => f !== "db" && f !== "surfaces"));
  const cards19 = loaded(
    NARROW_OK,
    fieldsFor("card").filter((f) => !CARD_OPTIONAL_SCHEMA_FIELDS.includes(f as never)),
  );
  const cards18 = loaded("22851869b3f8", OLD_FIELDS);
  const cards10 = loaded("183416179f84", OLD_FIELDS.slice(0, 8));

  // The post-restart order, which is what broke the live doctor.
  const postRestart = [cards19, cards23, cards22, cards10, cards18, cards21];

  test("the four wide versions really are all write-compatible (why order decided it)", () => {
    const r = resolveLoadedSchema("card", postRestart);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.compatible.sort()).toEqual(
        [CONFIG_HASH, NARROW_OK, "5c064c3e9204", "35b0d28467ed"].sort(),
      );
    }
  });

  test("ranks the WIDEST write-compatible version first, not the first-listed one", () => {
    // Pre-fix this returned NARROW_OK — the live primary's exact wrong answer.
    const r = resolveLoadedSchema("card", postRestart);
    expect(r.kind === "ok" && r.hash).toBe(CONFIG_HASH);
  });

  test("the answer is identical under every listing order", () => {
    const orders = [
      postRestart,
      [...postRestart].reverse(),
      [cards23, cards19, cards21, cards22, cards18, cards10],
      [cards10, cards18, cards21, cards19, cards22, cards23],
    ];
    const answers = new Set(
      orders.map((o) => {
        const r = resolveLoadedSchema("card", o);
        return r.kind === "ok" ? r.hash : r.kind;
      }),
    );
    expect([...answers]).toEqual([CONFIG_HASH]);
  });

  test("equal-width candidates tie-break on hash, not position", () => {
    const a = loaded("aaaa1111", fieldsFor("card"));
    const z = loaded("zzzz9999", fieldsFor("card"));
    expect(resolveLoadedSchema("card", [z, a]).kind === "ok" && resolveLoadedSchema("card", [z, a])).toMatchObject({ hash: "aaaa1111" });
    expect(resolveLoadedSchema("card", [a, z])).toMatchObject({ hash: "aaaa1111" });
  });

  test("`compatible` lists every acceptable pin, so a caller need not match the pick", () => {
    // The doctor-side contract: a config pinned to ANY of these is correct.
    const r = resolveLoadedSchema("card", postRestart);
    expect(r.kind === "ok" && r.compatible.includes(NARROW_OK)).toBe(true);
    expect(r.kind === "ok" && r.compatible.includes(CONFIG_HASH)).toBe(true);
    // A genuinely narrower version is never acceptable.
    expect(r.kind === "ok" && r.compatible.includes("22851869b3f8")).toBe(false);
  });
});

// Regression: an entity must not resolve to its own membership index.
//
// The 2026-07-23 multi-key expand registered `MilestoneCards` under
// descriptive_name `Milestone`, so the live primary carries two `fkanban/Milestone`
// schemas: the Hash `slug` entity (15 fields) and the HashRange `milestone/sk`
// index (30 fields). A membership index PROJECTS the entity's fields and adds its
// own, so it is a strict field superset BY CONSTRUCTION and wins the widest-superset
// contest every time. Measured on the primary 2026-07-30: `Milestone` resolved to
// the index `69e7…` over the correctly-pinned entity `614c…`, so `kanban doctor`
// reported a healthy config as wrong and advised `kanban init` — a remedy that
// cannot change the outcome, since `init` declares by definition and gets `614c…`
// back. Only the key layout separates them.
describe("resolveLoadedSchema (entity vs. its own membership index)", () => {
  const REAL_MILESTONE = "614c4f47";
  const MILESTONE_CARDS_INDEX = "69e76079";

  // The real primary's shape: the index carries every entity field plus its own,
  // and sorts EARLIER in the node's listing (position 55 vs 1060).
  const entity = loaded(REAL_MILESTONE, fieldsFor("milestone"), {
    descriptive_name: "Milestone",
    key: { hash_field: "slug", range_field: null },
  });
  const index = loaded(
    MILESTONE_CARDS_INDEX,
    [...fieldsFor("milestone"), "sk", "layout", "milestone", "column", "repo", "kind"],
    { descriptive_name: "Milestone", key: { hash_field: "milestone", range_field: "sk" } },
  );

  test("the index really is a strict field superset (the reason fields cannot decide)", () => {
    for (const f of fieldsFor("milestone")) expect(index.fields).toContain(f);
    expect(index.fields.length).toBeGreaterThan(entity.fields.length);
  });

  test("resolves to the Hash-keyed entity, not the HashRange index listed first", () => {
    const r = resolveLoadedSchema("milestone", [index, entity]);
    expect(r.kind).toBe("ok");
    if (r.kind === "ok") {
      expect(r.hash).toBe(REAL_MILESTONE);
      // Only one candidate survives the layout filter, so nothing is ambiguous.
      expect(r.ambiguous).toBe(false);
    }
  });

  test("order-independent: entity first also resolves to the entity", () => {
    const r = resolveLoadedSchema("milestone", [entity, index]);
    expect(r.kind === "ok" && r.hash).toBe(REAL_MILESTONE);
  });

  test("a differently-keyed schema is not a candidate at all, not merely outranked", () => {
    // With ONLY the index loaded the entity is genuinely absent. It must report
    // `missing` — never `ok` pointing at the index, and never `narrower` (which
    // would invite adopting an index as the write target).
    expect(resolveLoadedSchema("milestone", [index]).kind).toBe("missing");
  });

  test("a node that omits key layouts keeps the pre-layout behavior", () => {
    // Older nodes report no `key`. Unknown must not read as mismatched, or every
    // schema would resolve to `missing` on such a node.
    const r = resolveLoadedSchema("milestone", [
      loaded(REAL_MILESTONE, fieldsFor("milestone"), { descriptive_name: "Milestone", key: null }),
    ]);
    expect(r.kind === "ok" && r.hash).toBe(REAL_MILESTONE);
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
    const r = await probeSchemaWritable(node, FULL_CARD_HASH, CARD_ENTRY);
    expect(r.writable).toBe(true);
    // The throwaway probe record was deleted (store has no FULL_CARD_HASH key).
    expect([...store.keys()].some((key) => key.startsWith(`${FULL_CARD_HASH}::`))).toBe(false);
  });

  test("returns not-writable carrying the node's reason on a #94-style 400", async () => {
    const node = newNodeClient({ baseUrl, userHash: "u" });
    const r = await probeSchemaWritable(node, STALE_CARD_HASH, CARD_ENTRY);
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

    const r = await probeSchemaWritable(leakyNode, schemaHash, CARD_ENTRY);
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
