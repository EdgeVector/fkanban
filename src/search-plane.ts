/**
 * Shared Search app plane client for fkanban.
 * Prefers semantic Search plane (schema-scoped vectors); falls back to keyword vendor.
 *
 * Resolution: LASTDB_SEARCH_SEMANTIC_MODULE → semantic CLI → LASTDB_SEARCH_MODULE
 * → vendor/edgevector-search → unavailable.
 */
import { existsSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SearchPlaneHit = {
  schema_name: string;
  key_hash: string | null;
  key_range: string | null;
  score: number;
  text: string;
};

function packageRoot(): string {
  return resolve(dirname(fileURLToPath(import.meta.url)), "..");
}

export function resolveSearchModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  const vendorEngine = join(
    packageRoot(),
    "vendor",
    "edgevector-search",
    "src",
    "engine.ts",
  );
  if (existsSync(vendorEngine)) return vendorEngine;
  return null;
}

function resolveSemanticModulePath(): string | null {
  const env = process.env.LASTDB_SEARCH_SEMANTIC_MODULE?.trim();
  if (env && existsSync(env)) return resolve(env);
  const c = `${process.env.HOME ?? ""}/.host-track/apps/search/current/src/semantic.ts`;
  if (existsSync(c)) return c;
  return null;
}

function resolveIndexDir(searchHome?: string): string {
  if (process.env.SEARCH_INDEX_DIR?.trim()) return process.env.SEARCH_INDEX_DIR.trim();
  if (searchHome) return resolve(searchHome, "index");
  if (process.env.SEARCH_HOME?.trim()) {
    return resolve(process.env.SEARCH_HOME.trim(), "index");
  }
  const home =
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search/index");
}

function resolveInboxDir(searchHome?: string): string {
  if (process.env.SEARCH_INBOX?.trim()) return process.env.SEARCH_INBOX.trim();
  if (searchHome) return resolve(searchHome, "inbox");
  if (process.env.SEARCH_HOME?.trim()) {
    return resolve(process.env.SEARCH_HOME.trim(), "inbox");
  }
  const home =
    process.env.LASTDB_HOME?.trim() ||
    process.env.FOLDDB_HOME?.trim() ||
    `${process.env.HOME ?? ""}/.lastdb`;
  return resolve(home, "apps/search/inbox");
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
    env: {
      ...process.env,
      SEARCH_EMBEDDER: process.env.SEARCH_EMBEDDER ?? "deterministic",
    },
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
  // Semantic first — do not drain keyword-only vendor (avoids inbox steal).
  const sem = await querySemantic(opts);
  if (sem !== null) return sem;

  const modPath = resolveSearchModulePath();
  if (!modPath) return null;
  try {
    const engMod = (await import(pathToFileURL(modPath).href)) as {
      openSearchEngine: (d: string) => {
        search: (
          q: string,
          o?: { k?: number; schemas?: string[] },
        ) => SearchPlaneHit[];
        size: number;
      };
    };
    // Keyword fallback only — no drain (Search app owns drain/online-backfill).
    const eng = engMod.openSearchEngine(resolveIndexDir(opts.searchHome));
    return eng.search(opts.query, { k: opts.k ?? 50, schemas: opts.schemas });
  } catch {
    return null;
  }
}
