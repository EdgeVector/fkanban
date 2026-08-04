// LastgitCiStatus join for kanban lifecycle visibility.
//
// Pipeline status already lives in LastDB (lastgit's LastgitCiStatus schema).
// This module is a read-side join: resolve repo+oid+context from a card, fetch
// status rows, enrich `show`, and optionally gate `move` into a terminal column
// when the card body opts in via Requires-Status / Requires-Deploy headers.
//
// Defaults (Tom 2026-07-17):
// - Join key: lastgit-repo-slug + oid + context
// - Default context: process.env.LASTGIT_CI_CONTEXT || "ci-required"
// - Show enrichment is best-effort (never fails show)
// - Move gates are opt-in only; --force bypasses (same as dep blocks)
//
// Schema identity: lastgit registers schemas under canonical *hashes*, not the
// short names. Resolve via LASTGIT_SCHEMA_MAP (~/.lastgit/schema-map.json) first,
// then fall back to listSchemas field/owner matching.
//
// Hot-path cost (Tom 2026-07-31 profile): client=kanban queries against
// LastgitCiStatus_hashrange_v2 were the #1 wall-time bucket on the primary
// (~3.3k calls / 40m, avg ~580ms). Root cause was not "list" — it was every
// `kanban show` / MCP show always joining CI, projecting `log_excerpt` (a fat
// atom show never renders), and re-hitting the node for the same status_key
// when agents re-show the same card. Defaults below keep the join but drop
// the unused excerpt and process-cache light snapshots briefly.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { FkanbanError, type NodeClient, type QueryFilter, type QueryRow } from "./client.ts";
import {
  forcedGuardWaiverWarning,
  parseBodyHeader,
  parseBodyListHeader,
  type Card,
} from "./record.ts";

export const DEFAULT_CI_CONTEXT = "ci-required";
/** Logical lastgit schema names (schema-map keys), not node query ids. */
export const CI_STATUS_SCHEMA = "LastgitCiStatus";
export const REF_SCHEMA = "LastgitRef";
export const CR_SCHEMA = "LastgitChangeRequest";

export type LastgitLogicalSchema =
  | typeof CI_STATUS_SCHEMA
  | typeof REF_SCHEMA
  | typeof CR_SCHEMA;

/** Process-local cache of logical name → resolved schema hash for queryAll. */
const schemaHashCache = new Map<string, string | null>();

/**
 * Process-local cache of schema hash → key layout. `null` means "the node did
 * not report one" — NOT a zero value — so an older node's silence can never be
 * mistaken for a usable layout (mirrors `readKeyLayout` in client.ts).
 */
const schemaLayoutCache = new Map<string, KeyLayout | null>();

/**
 * Process-local TTL cache of light CI snapshots keyed by status_key.
 * Collapses agent/MCP re-`show` storms against the same oid+context without
 * lying across process boundaries (each CLI/MCP process has its own map).
 * Override with LASTGIT_CI_STATUS_CACHE_MS=0 to disable.
 */
const ciStatusLightCache = new Map<string, { at: number; snap: CiStatusSnapshot }>();

/** Default TTL for {@link ciStatusLightCache}. */
export const DEFAULT_CI_STATUS_CACHE_MS = 15_000;

type KeyLayout = { hash_field: string; range_field: string | null };

function ciStatusCacheTtlMs(): number {
  const raw = process.env.LASTGIT_CI_STATUS_CACHE_MS?.trim();
  if (raw === undefined || raw === "") return DEFAULT_CI_STATUS_CACHE_MS;
  const n = Number(raw);
  if (!Number.isFinite(n) || n < 0) return DEFAULT_CI_STATUS_CACHE_MS;
  return n;
}

/** Test seam: clear schema hash resolution cache (+ CI light snapshot cache). */
export function clearLastgitSchemaHashCache(): void {
  schemaHashCache.clear();
  schemaLayoutCache.clear();
  ciStatusLightCache.clear();
}

/**
 * Path to lastgit's schema map (logical name → canonical hash).
 * Mirrors lastgit CLI: LASTGIT_SCHEMA_MAP env, else ~/.lastgit/schema-map.json.
 */
export function lastgitSchemaMapPath(): string {
  const fromEnv = process.env.LASTGIT_SCHEMA_MAP?.trim();
  if (fromEnv) return fromEnv;
  return join(homedir(), ".lastgit", "schema-map.json");
}

/** Read logical→hash entries from the lastgit schema map file (best-effort). */
export function readLastgitSchemaMap(path = lastgitSchemaMapPath()): Record<string, string> {
  try {
    if (!existsSync(path)) return {};
    const raw = JSON.parse(readFileSync(path, "utf8")) as {
      schemas?: Record<string, unknown>;
    };
    const schemas = raw.schemas ?? {};
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(schemas)) {
      if (typeof v === "string" && v.length > 0) out[k] = v;
    }
    return out;
  } catch {
    return {};
  }
}

/**
 * Score a loaded schema as a candidate for a logical lastgit schema.
 * Higher is better; 0 = not a match.
 */
export function scoreLastgitSchemaCandidate(
  logical: LastgitLogicalSchema,
  s: { name: string; descriptive_name: string; owner_app_id: string; fields: string[] },
): number {
  const fields = new Set(s.fields ?? []);
  const desc = s.descriptive_name ?? "";
  const name = s.name ?? "";
  const owner = s.owner_app_id ?? "";
  let score = 0;
  if (owner === "lastgit") score += 10;
  if (name === logical || name === `lastgit/${logical}`) score += 50;
  if (name.startsWith("lastgit/") && name.includes(logical)) score += 30;

  if (logical === CI_STATUS_SCHEMA) {
    if (!(fields.has("status_key") && fields.has("oid") && fields.has("context") && fields.has("state"))) {
      return 0;
    }
    // Prefer the live hashrange_v2 shape lastgit writes (log_excerpt + layout).
    if (fields.has("log_excerpt")) score += 20;
    if (fields.has("event_id")) score += 5;
    if (fields.has("updated_at")) score += 5;
    if (fields.has("layout")) score += 10;
    if (/LastgitCiStatus/i.test(desc) || /Lastgit CI Status/i.test(desc)) score += 15;
    if (/hashrange/i.test(desc)) score += 10;
    // Deprioritize slim/red projection schemas.
    if (/CiRed/i.test(desc) || /CiRed/i.test(name)) score -= 40;
  } else if (logical === REF_SCHEMA) {
    if (!(fields.has("name") && fields.has("oid") && fields.has("repo"))) return 0;
    if (/Materialized Ref/i.test(desc) || /LastgitRef/i.test(desc)) score += 20;
  } else if (logical === CR_SCHEMA) {
    if (!(fields.has("cr_id") && fields.has("head_oid") && fields.has("repo"))) return 0;
    if (/Change Request/i.test(desc)) score += 20;
    if (fields.has("require_status")) score += 5;
  }
  return score;
}

/**
 * Resolve a logical lastgit schema name to a node query schema hash.
 * Order: in-memory cache → LASTGIT_SCHEMA_MAP file → listSchemas scoring.
 */
export async function resolveLastgitSchemaHash(
  node: NodeClient,
  logical: LastgitLogicalSchema,
): Promise<string | null> {
  if (schemaHashCache.has(logical)) return schemaHashCache.get(logical) ?? null;

  const fromMap = readLastgitSchemaMap()[logical];
  if (fromMap) {
    schemaHashCache.set(logical, fromMap);
    return fromMap;
  }

  if (!node.listSchemas) {
    schemaHashCache.set(logical, null);
    return null;
  }

  try {
    const loaded = await node.listSchemas();
    let best: { name: string; score: number } | null = null;
    for (const s of loaded) {
      const score = scoreLastgitSchemaCandidate(logical, s);
      if (score <= 0) continue;
      if (!best || score > best.score) best = { name: s.name, score };
    }
    const resolved = best?.name ?? null;
    schemaHashCache.set(logical, resolved);
    return resolved;
  } catch {
    schemaHashCache.set(logical, null);
    return null;
  }
}

export type CiState = "pending" | "success" | "failure" | "missing" | "unavailable";

export type OidResolution = {
  oid: string;
  via: "head-oid" | "change-request" | "ref" | "none";
};

export type CiStatusSnapshot = {
  repo: string;
  oid: string;
  context: string;
  state: CiState;
  updated_at: string;
  log_excerpt: string;
  resolved_via: OidResolution["via"];
  status_key: string;
};

export type LifecycleRequirements = {
  /** CI contexts that must be success before terminal move (Requires-Status). */
  statusContexts: string[];
  /** Deploy contexts that must be success before terminal move (Requires-Deploy). */
  deployContexts: string[];
};

export type PipelineAttachResult = {
  requirements: LifecycleRequirements;
  statuses: CiStatusSnapshot[];
  /** True when the card asked for gates but we could not resolve a lastgit repo. */
  unresolvedRepo: boolean;
  /** True when the card asked for gates / show but we could not resolve an oid. */
  unresolvedOid: boolean;
};

/**
 * Fields `show` / move-gates need. `log_excerpt` is deliberately omitted:
 * `formatPipelineStatusLines` only prints state+context+repo@oid, and the
 * excerpt atom is the expensive part of LastgitCiStatus (multi-KB, often the
 * only cold load on an otherwise warm tip).
 */
const CI_FIELDS_LIGHT = [
  "status_key",
  "repo",
  "oid",
  "context",
  "state",
  "updated_at",
] as const;

/** Full projection including log_excerpt — opt-in only. */
const CI_FIELDS_WITH_EXCERPT = [
  ...CI_FIELDS_LIGHT,
  "log_excerpt",
  "event_id",
  "schema_version",
] as const;

const REF_FIELDS = ["rkey", "repo", "name", "oid", "event_id", "schema_version"] as const;
const CR_FIELDS = [
  "cr_key",
  "cr_id",
  "repo",
  "head_ref",
  "base_ref",
  "head_oid",
  "state",
  "require_status",
] as const;

/** Context lastgit CI watch/status use when not overridden. */
export function defaultCiContext(): string {
  const fromEnv = process.env.LASTGIT_CI_CONTEXT?.trim();
  return fromEnv && fromEnv.length > 0 ? fromEnv : DEFAULT_CI_CONTEXT;
}

/**
 * Map a card Repo value (owner/name, bare slug, or lastdb:///slug) to the
 * lastgit repo partition key.
 */
export function lastgitRepoSlug(repo: string): string {
  const t = repo.trim();
  if (!t) return "";
  const lastdb = t.match(/^lastdb:\/\/\/([^/#?]+)/i);
  if (lastdb?.[1]) return lastdb[1];
  // Strip trailing .git
  const noGit = t.replace(/\.git$/i, "");
  const slash = noGit.lastIndexOf("/");
  if (slash >= 0) return noGit.slice(slash + 1);
  return noGit;
}

/** Collect opt-in gate contexts from card body headers (comma-separated). */
export function parseLifecycleRequirements(body: string): LifecycleRequirements {
  return {
    statusContexts: uniqueNonEmpty(parseBodyListHeader(body, "Requires-Status")),
    deployContexts: uniqueNonEmpty(parseBodyListHeader(body, "Requires-Deploy")),
  };
}

export function requiredContexts(reqs: LifecycleRequirements): string[] {
  return uniqueNonEmpty([...reqs.statusContexts, ...reqs.deployContexts]);
}

export function hasLifecycleGate(reqs: LifecycleRequirements): boolean {
  return requiredContexts(reqs).length > 0;
}

/** Contexts to display on show: required ones, else the default CI context. */
export function contextsForShow(reqs: LifecycleRequirements, defaultCtx = defaultCiContext()): string[] {
  const required = requiredContexts(reqs);
  if (required.length > 0) return required;
  return defaultCtx ? [defaultCtx] : [];
}

/**
 * Parse an explicit Head-Oid / Head-OID / Oid body header (40-hex preferred;
 * also accepts short oids ≥7 hex).
 */
export function parseHeadOidHeader(body: string): string {
  for (const name of ["Head-Oid", "Head-OID", "Oid", "OID"]) {
    const v = parseBodyHeader(body, name).trim();
    if (isPlausibleOid(v)) return v.toLowerCase();
  }
  return "";
}

export function isPlausibleOid(value: string): boolean {
  return /^[0-9a-f]{7,40}$/i.test(value.trim());
}

/**
 * Extract a lastgit change-request id from pr_url or body PR header.
 * Accepts bare `cr-…`, path segments, or query-ish strings containing cr-*.
 */
export function parseCrId(prUrl: string, body = ""): string {
  const candidates = [prUrl, parseBodyHeader(body, "PR"), parseBodyHeader(body, "CR")];
  for (const raw of candidates) {
    const t = raw.trim();
    if (!t) continue;
    const m = t.match(/\b(cr-[A-Za-z0-9_-]+)\b/);
    if (m?.[1]) return m[1];
    // Bare id without cr- prefix only if it looks like lastgit's id shape
    if (/^[A-Za-z0-9][A-Za-z0-9_-]{5,}$/.test(t) && !t.includes("/") && !t.includes(":")) {
      return t.startsWith("cr-") ? t : t;
    }
  }
  return "";
}

export function fullRefName(branch: string): string {
  const t = branch.trim();
  if (!t) return "";
  if (t.startsWith("refs/")) return t;
  return `refs/heads/${t}`;
}

function uniqueNonEmpty(values: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const v of values) {
    const t = v.trim();
    if (!t || seen.has(t)) continue;
    seen.add(t);
    out.push(t);
  }
  return out;
}

function strField(fields: Record<string, unknown>, name: string): string {
  const v = fields[name];
  return typeof v === "string" ? v : v == null ? "" : String(v);
}

function rowToCi(fields: Record<string, unknown>, resolved_via: OidResolution["via"]): CiStatusSnapshot {
  const stateRaw = strField(fields, "state").toLowerCase();
  const state: CiState =
    stateRaw === "pending" || stateRaw === "success" || stateRaw === "failure"
      ? stateRaw
      : "missing";
  return {
    repo: strField(fields, "repo"),
    oid: strField(fields, "oid"),
    context: strField(fields, "context"),
    state,
    updated_at: strField(fields, "updated_at"),
    log_excerpt: strField(fields, "log_excerpt"),
    resolved_via,
    status_key: strField(fields, "status_key"),
  };
}

/** An empty `hash_field` means the node reported no layout — not a layout of "". */
function usableLayout(key: KeyLayout | null | undefined): KeyLayout | null {
  if (!key || typeof key.hash_field !== "string" || key.hash_field.length === 0) return null;
  return { hash_field: key.hash_field, range_field: key.range_field || null };
}

/**
 * Key layout for a resolved lastgit schema hash.
 *
 * Prefers `GET /api/schema/{hash}` — one schema — over `GET /api/schemas`,
 * which returns EVERY loaded schema and is ~2 MB on this node. Resolving three
 * lastgit logs through the list endpoint cost ~3.5s of the first `show`, which
 * would have eaten most of what the keyed reads save. When only the list
 * endpoint is available, one call fills the cache for every schema in it, so
 * the remaining logs never pay for it again.
 *
 * `null` means the node reported no layout (older node) — callers must then
 * fall back to a partition read rather than read the silence as "not HashRange".
 */
async function resolveSchemaKeyLayout(
  node: NodeClient,
  schemaHash: string,
): Promise<KeyLayout | null> {
  if (schemaLayoutCache.has(schemaHash)) return schemaLayoutCache.get(schemaHash) ?? null;

  if (node.getSchema) {
    try {
      const layout = usableLayout((await node.getSchema(schemaHash)).key);
      schemaLayoutCache.set(schemaHash, layout);
      return layout;
    } catch {
      // Fall through to the list endpoint.
    }
  }

  if (!node.listSchemas) {
    schemaLayoutCache.set(schemaHash, null);
    return null;
  }
  try {
    const loaded = await node.listSchemas();
    for (const s of loaded) schemaLayoutCache.set(s.name, usableLayout(s.key));
    if (!schemaLayoutCache.has(schemaHash)) schemaLayoutCache.set(schemaHash, null);
    return schemaLayoutCache.get(schemaHash) ?? null;
  } catch {
    schemaLayoutCache.set(schemaHash, null);
    return null;
  }
}

/**
 * Read lastgit's logs the way lastgit itself reads them: by key.
 *
 * Every join this module performs already HOLDS the range component of the
 * row it wants — `status_key` for CI, `cr_id` for a change request, the full
 * ref name for a ref — and all three of those schemas are HashRange keyed on
 * `repo`. Asking for the partition and then running `rows.find()` in the
 * client is the scan-shaped read `concepts-lastdb-agent-access-model` exists
 * to forbid, and it was measurably the most expensive thing kanban did to the
 * node: 778 rows / 3.93 MB / ~450ms per lookup, 2-4 lookups per `show`,
 * against 1 row / 14 KB / ~16-115ms for the keyed read.
 *
 * The keyed path is taken only when the node reports a HashRange layout hashed
 * on `repo`. That is the same rule lastgit's own `getCiStatus` applies, and it
 * deliberately does NOT require `range_field` to NAME the field we key on:
 * the shared CI/CrEvent schema declares `event_id` while its rows are keyed by
 * `status_key`, and lastgit — the writer — reads it by `status_key` anyway.
 * Verified against the live node on all three schemas, each with a negative
 * control (an absurd range returns 0 rows, so the predicate is really applied
 * and not silently ignored).
 *
 * A keyed read returning no rows is a genuine ABSENCE and is reported as such.
 * There is no fall back to a partition scan on empty: most cards have no CI
 * row at all, so a miss is the common case, and re-reading the partition on
 * every miss would cost strictly more than the scan it replaced.
 */
async function querySchema(
  node: NodeClient,
  logical: LastgitLogicalSchema,
  fields: readonly string[],
  lookup?: { repo: string; range?: string },
): Promise<QueryRow[]> {
  const schemaHash = await resolveLastgitSchemaHash(node, logical);
  if (!schemaHash) return [];

  let filter: Record<string, unknown> | undefined;
  if (lookup) {
    const layout = lookup.range ? await resolveSchemaKeyLayout(node, schemaHash) : null;
    filter =
      layout && layout.range_field !== null && layout.hash_field === "repo"
        ? { HashRangeKey: { hash: lookup.repo, range: lookup.range } }
        : { HashKey: lookup.repo };
  }

  try {
    const res = await node.queryAll({
      schemaHash,
      fields: [...fields],
      ...(filter ? { filter: filter as QueryFilter } : {}),
    });
    return res.results ?? [];
  } catch {
    // Schema missing / permission / busy — treat as unavailable for best-effort paths.
    // Drop a bad cache entry so a later attempt can re-resolve via listSchemas.
    schemaHashCache.delete(logical);
    schemaLayoutCache.delete(schemaHash);
    return [];
  }
}

/**
 * Resolve the commit oid for a card.
 * Order: Head-Oid header → LastgitChangeRequest.head_oid → LastgitRef tip for branch.
 */
export async function resolveCardOid(
  node: NodeClient,
  opts: { repoSlug: string; body: string; branch: string; prUrl: string },
): Promise<OidResolution> {
  const fromHeader = parseHeadOidHeader(opts.body);
  if (fromHeader) return { oid: fromHeader, via: "head-oid" };

  if (!opts.repoSlug) return { oid: "", via: "none" };

  const crId = parseCrId(opts.prUrl, opts.body);
  if (crId) {
    // A card may cite the CR either with or without the `cr-` prefix, and the
    // keyed read can only ask for one range at a time — so ask for the spelling
    // the card used, then for the other one. Both are point reads; the second
    // only runs when the first genuinely has no row.
    const candidates = crId.startsWith("cr-") ? [crId, crId.slice(3)] : [crId, `cr-${crId}`];
    for (const candidate of candidates) {
      const rows = await querySchema(node, CR_SCHEMA, CR_FIELDS, {
        repo: opts.repoSlug,
        range: candidate,
      });
      const match = rows.find((r) => {
        const id = strField(r.fields, "cr_id");
        return id === crId || id === `cr-${crId}` || `cr-${id}` === crId;
      });
      const head = match ? strField(match.fields, "head_oid") : "";
      if (isPlausibleOid(head)) return { oid: head.toLowerCase(), via: "change-request" };
    }
  }

  const refName = fullRefName(opts.branch || parseBodyHeader(opts.body, "Branch"));
  if (refName) {
    const rows = await querySchema(node, REF_SCHEMA, REF_FIELDS, {
      repo: opts.repoSlug,
      range: refName,
    });
    const match = rows.find((r) => strField(r.fields, "name") === refName);
    const oid = match ? strField(match.fields, "oid") : "";
    if (isPlausibleOid(oid)) return { oid: oid.toLowerCase(), via: "ref" };
  }

  return { oid: "", via: "none" };
}

export type FetchCiStatusOptions = {
  /**
   * Project `log_excerpt` (and a couple of unused metadata fields). Default
   * false: show never prints the excerpt, and pulling it was the dominant
   * per-row cost on LastgitCiStatus under agent show storms.
   */
  includeLogExcerpt?: boolean;
  /** Skip the process-local TTL cache (tests / force-refresh). */
  bypassCache?: boolean;
};

/** Fetch one LastgitCiStatus row for repo+oid+context (best-effort). */
export async function fetchCiStatus(
  node: NodeClient,
  repoSlug: string,
  oid: string,
  context: string,
  resolved_via: OidResolution["via"] = "none",
  opts: FetchCiStatusOptions = {},
): Promise<CiStatusSnapshot> {
  const empty = (state: CiState): CiStatusSnapshot => ({
    repo: repoSlug,
    oid,
    context,
    state,
    updated_at: "",
    log_excerpt: "",
    resolved_via,
    status_key: repoSlug && oid && context ? `${repoSlug}:${oid}:${context}` : "",
  });

  if (!repoSlug || !oid || !context) return empty("missing");

  const wantKey = `${repoSlug}:${oid}:${context}`;
  const includeLogExcerpt = opts.includeLogExcerpt === true;
  const ttlMs = ciStatusCacheTtlMs();
  // Only light (no-excerpt) reads share the cache — an excerpt-bearing caller
  // must not be served a blank log_excerpt from a prior light hit.
  if (!includeLogExcerpt && !opts.bypassCache && ttlMs > 0) {
    const hit = ciStatusLightCache.get(wantKey);
    if (hit && Date.now() - hit.at <= ttlMs) {
      return { ...hit.snap, resolved_via };
    }
  }

  const fields = includeLogExcerpt ? CI_FIELDS_WITH_EXCERPT : CI_FIELDS_LIGHT;
  const rows = await querySchema(node, CI_STATUS_SCHEMA, fields, {
    repo: repoSlug,
    range: wantKey,
  });
  if (rows.length === 0) {
    // Distinguish "query failed / schema absent" from "no row" is hard without
    // a separate probe; treat empty as missing (common for not-yet-watched oids).
    const miss = empty("missing");
    if (!includeLogExcerpt && !opts.bypassCache && ttlMs > 0) {
      ciStatusLightCache.set(wantKey, { at: Date.now(), snap: miss });
    }
    return miss;
  }

  const match = rows.find((r) => {
    const f = r.fields;
    if (strField(f, "status_key") === wantKey) return true;
    return (
      strField(f, "repo") === repoSlug &&
      strField(f, "oid").toLowerCase() === oid.toLowerCase() &&
      strField(f, "context") === context
    );
  });

  if (!match) {
    const miss = empty("missing");
    if (!includeLogExcerpt && !opts.bypassCache && ttlMs > 0) {
      ciStatusLightCache.set(wantKey, { at: Date.now(), snap: miss });
    }
    return miss;
  }
  const snap = rowToCi(match.fields, resolved_via);
  if (!includeLogExcerpt && !opts.bypassCache && ttlMs > 0) {
    ciStatusLightCache.set(wantKey, { at: Date.now(), snap });
  }
  return snap;
}

/**
 * Attach pipeline status snapshots for a card. Best-effort: never throws.
 * Used by `show` enrichment.
 */
export async function attachPipelineStatus(
  node: NodeClient,
  card: Pick<Card, "repo" | "body" | "branch" | "pr_url">,
  opts: { defaultContext?: string } = {},
): Promise<PipelineAttachResult> {
  const requirements = parseLifecycleRequirements(card.body);
  const contexts = contextsForShow(requirements, opts.defaultContext ?? defaultCiContext());
  const repoSlug = lastgitRepoSlug(card.repo || parseBodyHeader(card.body, "Repo"));

  if (!repoSlug) {
    return {
      requirements,
      statuses: [],
      unresolvedRepo: true,
      unresolvedOid: true,
    };
  }

  let oidRes: OidResolution;
  try {
    oidRes = await resolveCardOid(node, {
      repoSlug,
      body: card.body,
      branch: card.branch,
      prUrl: card.pr_url,
    });
  } catch {
    oidRes = { oid: "", via: "none" };
  }

  if (!oidRes.oid) {
    return {
      requirements,
      statuses: contexts.map((context) => ({
        repo: repoSlug,
        oid: "",
        context,
        state: "missing" as const,
        updated_at: "",
        log_excerpt: "",
        resolved_via: "none" as const,
        status_key: "",
      })),
      unresolvedRepo: false,
      unresolvedOid: true,
    };
  }

  const statuses: CiStatusSnapshot[] = [];
  for (const context of contexts) {
    try {
      statuses.push(await fetchCiStatus(node, repoSlug, oidRes.oid, context, oidRes.via));
    } catch {
      statuses.push({
        repo: repoSlug,
        oid: oidRes.oid,
        context,
        state: "unavailable",
        updated_at: "",
        log_excerpt: "",
        resolved_via: oidRes.via,
        status_key: `${repoSlug}:${oidRes.oid}:${context}`,
      });
    }
  }

  return {
    requirements,
    statuses,
    unresolvedRepo: false,
    unresolvedOid: false,
  };
}

export type LifecycleGateViolation = {
  context: string;
  kind: "status" | "deploy";
  state: CiState;
  oid: string;
  repo: string;
};

/**
 * Evaluate whether a terminal move is allowed under opt-in Requires-* headers.
 * Pure once statuses are fetched — used by tests and moveCmd.
 */
export function evaluateLifecycleGate(opts: {
  requirements: LifecycleRequirements;
  statuses: CiStatusSnapshot[];
  unresolvedRepo: boolean;
  unresolvedOid: boolean;
  repoSlug: string;
  oid: string;
}): { ok: true } | { ok: false; violations: LifecycleGateViolation[] } {
  if (!hasLifecycleGate(opts.requirements)) return { ok: true };

  const byContext = new Map(opts.statuses.map((s) => [s.context, s]));
  const violations: LifecycleGateViolation[] = [];

  const check = (contexts: string[], kind: "status" | "deploy") => {
    for (const context of contexts) {
      if (opts.unresolvedRepo || opts.unresolvedOid) {
        violations.push({
          context,
          kind,
          state: "missing",
          oid: opts.oid,
          repo: opts.repoSlug,
        });
        continue;
      }
      const snap = byContext.get(context);
      const state = snap?.state ?? "missing";
      if (state !== "success") {
        violations.push({
          context,
          kind,
          state,
          oid: snap?.oid || opts.oid,
          repo: snap?.repo || opts.repoSlug,
        });
      }
    }
  };

  check(opts.requirements.statusContexts, "status");
  check(opts.requirements.deployContexts, "deploy");

  return violations.length === 0 ? { ok: true } : { ok: false, violations };
}

/**
 * Opt-in gate for moving into a board's terminal column.
 * No-op when the card has no Requires-Status / Requires-Deploy headers.
 * `--force` bypasses — out loud (caller passes force=true).
 *
 * ## Why this one had to start speaking too
 *
 * Of the guards `--force` clears in one keystroke, this is the one whose silent
 * waiver is worst: it puts a card in the board's TERMINAL column while its
 * required CI contexts are failing or missing. `done` is what the rollups,
 * the milestone proof state and every "is it shipped?" read key off, so a
 * silently forced terminal move does not just mislead the operator who typed
 * the flag — it makes the board assert something untrue to everyone else.
 *
 * The shape follows {@link assertDepUnblocked}, whose two constraints apply
 * here unchanged and for the same reasons:
 *
 *   1. **The fast path stays free.** `parseLifecycleRequirements` is a pure
 *      body parse, so a card with no `Requires-Status`/`Requires-Deploy` header
 *      is knowably ungated with no read at all. That check moves ABOVE the
 *      force short-circuit; the node read below is paid only when there is a
 *      real verdict to report.
 *   2. **Reporting must never gate.** Already structural here, and worth
 *      recording so nobody adds a defensive `try` that can never fire:
 *      `attachPipelineStatus` is best-effort and NEVER THROWS — it catches at
 *      both the OID resolution and the per-context fetch, and reports a
 *      degraded node as `state: "unavailable"` / `"missing"` rather than an
 *      exception. So a forced move cannot be converted into a refusal by a read
 *      failure; it is voiced as an unmet context, which is the honest reading.
 *      (Unforced, that same degraded read still REFUSES — that is this opt-in
 *      gate's pre-existing fail-closed stance, not something the waiver changed.)
 */
export async function assertLifecycleMoveAllowed(opts: {
  node: NodeClient;
  card: Card;
  targetColumn: string;
  terminalColumn: string;
  force?: boolean;
}): Promise<void> {
  if (opts.targetColumn !== opts.terminalColumn) return;

  const requirements = parseLifecycleRequirements(opts.card.body);
  if (!hasLifecycleGate(requirements)) return;

  const attached = await attachPipelineStatus(opts.node, opts.card);
  const repoSlug = lastgitRepoSlug(opts.card.repo || parseBodyHeader(opts.card.body, "Repo"));
  const oid = attached.statuses[0]?.oid ?? "";

  const verdict = evaluateLifecycleGate({
    requirements: attached.requirements,
    statuses: attached.statuses,
    unresolvedRepo: attached.unresolvedRepo,
    unresolvedOid: attached.unresolvedOid,
    repoSlug,
    oid,
  });

  if (verdict.ok) return;

  const detail = verdict.violations
    .map((v) => `${v.kind}:${v.context}=${v.state}`)
    .join(", ");
  const message =
    `lifecycle_status_blocked: Card "${opts.card.slug}" cannot move to ` +
    `"${opts.targetColumn}" until required pipeline contexts succeed (${detail}).`;
  if (opts.force) {
    console.error(forcedGuardWaiverWarning(opts.card.slug, "lifecycle pipeline-status", message));
    return;
  }
  throw new FkanbanError({
    code: "lifecycle_status_blocked",
    message,
    hint:
      "Wait for LastgitCiStatus success, fix the failing context, set Head-Oid/branch " +
      "so kanban can resolve the commit, or pass --force to bypass the opt-in gate.",
  });
}

/** Human lines for `kanban show` text view. */
export function formatPipelineStatusLines(
  attached: PipelineAttachResult,
  color = false,
): string[] {
  if (attached.statuses.length === 0 && !attached.unresolvedRepo) return [];

  const paint = (code: string, s: string) => {
    if (!color) return s;
    const codes: Record<string, string> = {
      dim: "\x1b[2m",
      green: "\x1b[32m",
      yellow: "\x1b[33m",
      red: "\x1b[31m",
      reset: "\x1b[0m",
    };
    return `${codes[code] ?? ""}${s}${codes.reset}`;
  };

  const stateColor = (state: CiState): string => {
    if (state === "success") return "green";
    if (state === "pending") return "yellow";
    if (state === "failure") return "red";
    return "dim";
  };

  const lines: string[] = [];
  if (attached.unresolvedRepo) {
    lines.push(paint("dim", "pipeline: (no lastgit repo resolved from Repo header)"));
    return lines;
  }

  const req = requiredContexts(attached.requirements);
  const gateNote = req.length > 0 ? ` gate:${req.join(",")}` : "";

  if (attached.unresolvedOid) {
    lines.push(
      paint("dim", `pipeline: oid unresolved (set Head-Oid: or branch/CR)${gateNote}`),
    );
    return lines;
  }

  for (const s of attached.statuses) {
    const shortOid = s.oid.length > 12 ? s.oid.slice(0, 12) : s.oid;
    const via = s.resolved_via !== "none" ? ` via ${s.resolved_via}` : "";
    lines.push(
      `pipeline: ${paint(stateColor(s.state), s.state)}  ${s.context}  ` +
        paint("dim", `${s.repo}@${shortOid}${via}${gateNote}`),
    );
  }
  return lines;
}
