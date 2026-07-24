/**
 * Shared Search app plane client for fkanban.
 * Resolution: LASTDB_SEARCH_MODULE → vendor/edgevector-search → unavailable.
 */
import { existsSync } from "node:fs";
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

export async function querySearchPlane(opts: {
  query: string;
  k?: number;
  schemas?: string[];
  searchHome?: string;
}): Promise<SearchPlaneHit[] | null> {
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
    const inboxPath = modPath.replace(/engine\.ts$/, "inbox.ts");
    const eng = engMod.openSearchEngine(resolveIndexDir(opts.searchHome));
    if (existsSync(inboxPath)) {
      const inboxMod = (await import(pathToFileURL(inboxPath).href)) as {
        drainInbox: (e: typeof eng, d: string) => unknown;
      };
      inboxMod.drainInbox(eng, resolveInboxDir(opts.searchHome));
    }
    return eng.search(opts.query, { k: opts.k ?? 50, schemas: opts.schemas });
  } catch {
    return null;
  }
}
