/**
 * fkanban search plane is semantic-only (host-track Search or explicit module).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { querySearchPlane } from "../../src/search-plane.ts";

/**
 * Write an isolated LastSeek schema-resolution table that knows `fkanban/Card`,
 * and return its path for `LASTSEEK_SCHEMA_TABLE`.
 *
 * Without this the test reads the HOST table at ~/.lastseek/schema-table.json,
 * which `lastseek schema-table` builds solely from the Schema Service — a
 * schema.org-derived list that contains no LastDB app schemas and cannot be
 * made to contain them (`--catalog` is accepted and ignored). So
 * `lastseek query --schema fkanban/Card` exits non-zero with "unknown schema"
 * and the plane query throws LastSeekUnknownSchemaError.
 *
 * That made a unit test depend on unreachable host state: it went red on
 * 2026-08-08 and took fkanban's whole ci-required gate with it, blocking every
 * CR on a condition no CR could fix. A test that owns its SEARCH_HOME should
 * own its schema table too.
 */
function writeSchemaTable(dir: string, schema: string): string {
  const path = join(dir, "schema-table.json");
  writeFileSync(
    path,
    JSON.stringify({
      source: "test-fixture",
      by_name: { [schema]: schema },
      by_descriptive: { [schema]: [schema] },
      identities: [schema],
    }),
    "utf8",
  );
  return path;
}

const HOST_SEMANTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/semantic.ts",
);
const HOST_DETERMINISTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/vector/deterministic.ts",
);

describe("fkanban search-plane semantic-only", () => {
  test("querySearchPlane returns null when semantic module and CLI are unavailable", async () => {
    const home = mkdtempSync(join(tmpdir(), "fk-sp-nosem-"));
    mkdirSync(join(home, "inbox"), { recursive: true });
    const fakeHome = mkdtempSync(join(tmpdir(), "fk-sp-home-"));
    const prevHome = process.env.HOME;
    process.env.HOME = fakeHome;
    process.env.SEARCH_HOME = home;
    process.env.LASTDB_SEARCH_BIN = "/nonexistent/search-bin-xyz";
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;

    const hits = await querySearchPlane({
      query: "anything-unique-marker-xyz",
      k: 10,
      searchHome: home,
      schemas: ["fkanban/Card"],
    });
    expect(hits).toBeNull();

    process.env.HOME = prevHome;
    delete process.env.SEARCH_HOME;
    delete process.env.LASTDB_SEARCH_BIN;
  });

  test("semantic ingest works when host-track Search is present", async () => {
    if (!existsSync(HOST_SEMANTIC) || !existsSync(HOST_DETERMINISTIC)) return;

    const home = mkdtempSync(join(tmpdir(), "fk-sp-sem-"));
    mkdirSync(join(home, "inbox"), { recursive: true });
    const unique = `fkanban-sem-${Date.now()}-card9`;
    process.env.SEARCH_HOME = home;
    process.env.SEARCH_EMBEDDER = "deterministic";
    process.env.LASTDB_SEARCH_SEMANTIC_MODULE = HOST_SEMANTIC;
    const prevTable = process.env.LASTSEEK_SCHEMA_TABLE;
    const prevSeekHome = process.env.LASTSEEK_HOME;
    process.env.LASTSEEK_SCHEMA_TABLE = writeSchemaTable(home, "fkanban/Card");
    // queryLastSeek spawns `lastseek query` WITHOUT --home, so the CLI reads
    // $LASTSEEK_HOME (default ~/.lastseek/index) no matter what searchHome the
    // caller passed. Unset, this test ingests into its own temp SEARCH_HOME and
    // then queries the real host index — it passed alone only by accident of
    // what happened to be sitting there, and went red the moment the full suite
    // changed that. Pin the CLI at the same home the ingest wrote to.
    process.env.LASTSEEK_HOME = home;

    const detMod = (await import(pathToFileURL(HOST_DETERMINISTIC).href)) as {
      DeterministicMiniLmCompatEmbedder: new () => unknown;
    };
    const semMod = (await import(pathToFileURL(HOST_SEMANTIC).href)) as {
      openSearchSession: (o?: { embedder?: unknown }) => {
        semantic: {
          ensureReady: () => Promise<void>;
          applyBatch: (b: unknown) => Promise<number>;
        };
      };
    };
    const emb = new detMod.DeterministicMiniLmCompatEmbedder();
    const session = semMod.openSearchSession({ embedder: emb });
    await session.semantic.ensureReady();
    await session.semantic.applyBatch({
      schema_name: "fkanban/Card",
      searchable_fields: ["title", "body", "slug"],
      changes: [
        {
          mutation_id: "m-fk-1",
          kind: "upsert",
          key_value: { hash: "card-plane-slug", range: null },
          fields_and_values: {
            slug: "card-plane-slug",
            title: "plane card",
            body: unique,
          },
        },
      ],
    });

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      schemas: ["fkanban/Card"],
    });
    expect(hits).not.toBeNull();
    expect(hits!.some((h) => h.key_hash === "card-plane-slug")).toBe(true);

    delete process.env.SEARCH_HOME;
    delete process.env.SEARCH_EMBEDDER;
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;
    if (prevTable === undefined) delete process.env.LASTSEEK_SCHEMA_TABLE;
    else process.env.LASTSEEK_SCHEMA_TABLE = prevTable;
    if (prevSeekHome === undefined) delete process.env.LASTSEEK_HOME;
    else process.env.LASTSEEK_HOME = prevSeekHome;
    // 30s, not bun's 5s default: with the schema now resolvable this test does
    // the real work it always meant to — embedder load, ingest, compact, query
    // — where before it failed in ~2s on "unknown schema" and never got there.
  }, 30_000);
});
