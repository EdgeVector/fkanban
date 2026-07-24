import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { querySearchPlane } from "../../src/search-plane.ts";

const SEARCH_ENGINE = resolve(
  import.meta.dirname,
  "../../../search-kanban-search-as-app-implement/src/engine.ts",
);

describe("fkanban search-plane cutover", () => {
  test("querySearchPlane finds card fixture from Search engine", async () => {
    const home = mkdtempSync(join(tmpdir(), "fk-sp-"));
    const indexDir = join(home, "index");
    mkdirSync(indexDir, { recursive: true });
    mkdirSync(join(home, "inbox"), { recursive: true });
    const unique = `fkanban-plane-${Date.now()}-card9`;
    process.env.LASTDB_SEARCH_MODULE = SEARCH_ENGINE;
    process.env.SEARCH_HOME = home;

    const engMod = (await import(pathToFileURL(SEARCH_ENGINE).href)) as {
      openSearchEngine: (d: string) => {
        applyChangeBatch: (b: unknown) => number;
        persist: () => void;
      };
    };
    const eng = engMod.openSearchEngine(indexDir);
    eng.applyChangeBatch({
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
    eng.persist();

    const hits = await querySearchPlane({
      query: unique,
      k: 10,
      searchHome: home,
      schemas: ["fkanban/Card"],
    });
    expect(hits).not.toBeNull();
    expect(hits!.some((h) => h.key_hash === "card-plane-slug")).toBe(true);
    expect(hits!.some((h) => h.text.includes(unique))).toBe(true);
  });
});
