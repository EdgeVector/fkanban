/**
 * Shared Search app plane client for fkanban.
 * Semantic Search plane only (schema-scoped MiniLM vectors).
 *
 * Resolution: LASTDB_SEARCH_SEMANTIC_MODULE → host-track semantic → semantic CLI.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

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
  // Semantic only — empty hits still count as a live plane (return []).
  const sem = await querySemantic(opts);
  if (sem !== null) return sem;
  return null;
}
