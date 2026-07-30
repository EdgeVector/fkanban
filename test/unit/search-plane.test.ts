/**
 * fkanban search plane is semantic-only (keyword LastStore removed 2026-07-30).
 */
import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { querySearchPlane } from "../../src/search-plane.ts";

const HOST_SEMANTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/semantic.ts",
);
const HOST_DETERMINISTIC = resolve(
  process.env.HOME ?? "",
  ".host-track/apps/search/current/src/vector/deterministic.ts",
);

describe("fkanban search-plane semantic-only", () => {
  test("keyword-only ingest is not returned by querySearchPlane", async () => {
    const home = mkdtempSync(join(tmpdir(), "fk-sp-kw-"));
    const indexDir = join(home, "index");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(join(home, "inbox"), { recursive: true });
    const unique = `fkanban-kw-should-not-${Date.now()}`;
    process.env.SEARCH_HOME = home;
    process.env.LASTDB_SEARCH_BIN = "/nonexistent/search-bin-xyz";
    delete process.env.LASTDB_SEARCH_SEMANTIC_MODULE;

    const vendorEngine = resolve(
      import.meta.dirname,
      "../../vendor/edgevector-search/src/engine.ts",
    );
    if (existsSync(vendorEngine)) {
      const engMod = (await import(pathToFileURL(vendorEngine).href)) as {
        openSearchEngine: (d: string) => {
          applyChangeBatch: (b: unknown) => number;
          persist: () => void;
        };
      };
      engMod.openSearchEngine(indexDir).applyChangeBatch({
        schema_name: "fkanban/Card",
        searchable_fields: ["body"],
        changes: [
          {
            mutation_id: "m1",
            kind: "upsert",
            key_value: { hash: "card-x", range: null },
            fields_and_values: { body: unique },
          },
        ],
      });
    }

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      schemas: ["fkanban/Card"],
    });
    if (hits !== null) {
      expect(hits.every((h) => !h.text.includes(unique))).toBe(true);
    }

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
  });
});
