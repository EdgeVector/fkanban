/**
 * Shared semantic search plane client for fkanban (schema-scoped vectors).
 *
 * Resolution: LastSeek → LASTDB_SEARCH_SEMANTIC_MODULE → host-track semantic
 * → semantic CLI.
 *
 * LastSeek (`lastdb:///lastseek`) is the Rust successor to the TypeScript
 * Search app. It goes first rather than replacing the rest, so the cutover is a
 * property of what is installed rather than a flag day; `LASTSEEK_DISABLE=1`
 * pins the incumbent.
 *
 * The `card` hash in fkanban's own config (`bc941dbc…`) is a registry name
 * LastSeek's Schema Service table resolves directly, so this tier passes it
 * unchanged and needs no translation.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
import { queryLastSeek } from "./lastseek-plane.ts";

export type SearchPlaneHit = {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  score: number;
  text: string;
};

function resolveSemanticModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_SEMANTIC_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  const c = `${process.env.HOME ?? ""}/.host-track/apps/search/current/src/semantic.ts`;
  if (existsSync(c)) return c;
  return null;
}

function resolveSearchHome(searchHome?: string): string {
  if (searchHome) return searchHome;
  if (process.env.SEARCH_HOME?.trim()) return process.env.SEARCH_HOME.trim();
  const home =
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search");
}

async function querySemantic(opts: {
  query: string;
  k?: number;
  schemas?: string[];
  searchHome?: string;
}): Promise<SearchPlaneHit[] | null> {
  const modPath = resolveSemanticModulePath();
  if (modPath) {
    try {
      const mod = (await import(pathToFileURL(modPath).href)) as {
        openSearchSession?: (o?: unknown) => {
          semantic: {
            ensureReady: () => Promise<void>;
            query: (
              q: string,
              o?: { k?: number; schemas?: string[] },
            ) => Promise<SearchPlaneHit[]>;
          };
        };
        openSemanticPlane?: (home: string) => {
          ensureReady: () => Promise<void>;
          query: (
            q: string,
            o?: { k?: number; schemas?: string[] },
          ) => Promise<SearchPlaneHit[]>;
        };
      };
      if (typeof mod.openSearchSession === "function") {
        const s = mod.openSearchSession({});
        await s.semantic.ensureReady();
        return await s.semantic.query(opts.query, {
          k: opts.k ?? 50,
          schemas: opts.schemas,
        });
      }
      if (typeof mod.openSemanticPlane === "function") {
        const p = mod.openSemanticPlane(resolveSearchHome(opts.searchHome));
        await p.ensureReady();
        return await p.query(opts.query, {
          k: opts.k ?? 50,
          schemas: opts.schemas,
        });
      }
    } catch {
      /* CLI */
    }
  }
  const bin = process.env.LASTDB_SEARCH_BIN?.trim() || "search";
  const args = [
    "semantic-query",
    opts.query,
    "--json",
    "--k",
    String(opts.k ?? 50),
  ];
  for (const s of opts.schemas ?? []) args.push("--schema", s);
  const r = spawnSync(bin, args, {
    encoding: "utf8",
    env: process.env,
    timeout: 60_000,
  });
  if (r.error || r.status !== 0) return null;
  try {
    const parsed = JSON.parse(r.stdout) as { hits?: SearchPlaneHit[] };
    return Array.isArray(parsed.hits) ? parsed.hits : [];
  } catch {
    return null;
  }
}

export async function querySearchPlane(opts: {
  query: string;
  k?: number;
  schemas?: string[];
  searchHome?: string;
}): Promise<SearchPlaneHit[] | null> {
  // LastSeek first, when its query can answer.
  //
  // An unresolvable schema throws out of here on purpose. Catching it and
  // falling through would land on the incumbent, which answers the same query
  // with `[]` — and the confident-empty answer LastSeek exists to remove would
  // be back, reintroduced by the fallback meant to be safe.
  const seek = queryLastSeek({
    query: opts.query,
    k: opts.k ?? 50,
    schemas: opts.schemas,
  });
  if (seek !== null) {
    return seek.map((h) => ({
      // Callers compare `schema_name` against the hashes they passed, so it
      // carries the identity, not the readable label.
      schema_name: h.schema_identity,
      key_hash: h.key_hash,
      key_range: h.key_range,
      score: h.score,
      text: h.text,
    }));
  }
  // Semantic only — empty hits still count as a live plane (return []).
  const sem = await querySemantic(opts);
  if (sem !== null) return sem;
  return null;
}
