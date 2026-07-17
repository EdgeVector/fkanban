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

import { FkanbanError, type NodeClient, type QueryRow } from "./client.ts";
import {
  parseBodyHeader,
  parseBodyListHeader,
  type Card,
} from "./record.ts";

export const DEFAULT_CI_CONTEXT = "ci-required";
export const CI_STATUS_SCHEMA = "LastgitCiStatus";
export const REF_SCHEMA = "LastgitRef";
export const CR_SCHEMA = "LastgitChangeRequest";

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

const CI_FIELDS = [
  "status_key",
  "repo",
  "oid",
  "context",
  "state",
  "log_excerpt",
  "event_id",
  "updated_at",
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

async function querySchema(
  node: NodeClient,
  schema: string,
  fields: readonly string[],
  filter?: { HashKey: string },
): Promise<QueryRow[]> {
  try {
    const res = await node.queryAll({
      schemaHash: schema,
      fields: [...fields],
      ...(filter ? { filter } : {}),
    });
    return res.results ?? [];
  } catch {
    // Schema missing / permission / busy — treat as unavailable for best-effort paths.
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
    const rows = await querySchema(node, CR_SCHEMA, CR_FIELDS, { HashKey: opts.repoSlug });
    const match = rows.find((r) => {
      const id = strField(r.fields, "cr_id");
      return id === crId || id === `cr-${crId}` || `cr-${id}` === crId;
    });
    const head = match ? strField(match.fields, "head_oid") : "";
    if (isPlausibleOid(head)) return { oid: head.toLowerCase(), via: "change-request" };
  }

  const refName = fullRefName(opts.branch || parseBodyHeader(opts.body, "Branch"));
  if (refName) {
    const rows = await querySchema(node, REF_SCHEMA, REF_FIELDS, { HashKey: opts.repoSlug });
    const match = rows.find((r) => strField(r.fields, "name") === refName);
    const oid = match ? strField(match.fields, "oid") : "";
    if (isPlausibleOid(oid)) return { oid: oid.toLowerCase(), via: "ref" };
  }

  return { oid: "", via: "none" };
}

/** Fetch one LastgitCiStatus row for repo+oid+context (best-effort). */
export async function fetchCiStatus(
  node: NodeClient,
  repoSlug: string,
  oid: string,
  context: string,
  resolved_via: OidResolution["via"] = "none",
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

  const rows = await querySchema(node, CI_STATUS_SCHEMA, CI_FIELDS, { HashKey: repoSlug });
  if (rows.length === 0) {
    // Distinguish "query failed / schema absent" from "no row" is hard without
    // a separate probe; treat empty as missing (common for not-yet-watched oids).
    return empty("missing");
  }

  const wantKey = `${repoSlug}:${oid}:${context}`;
  const match = rows.find((r) => {
    const fields = r.fields;
    if (strField(fields, "status_key") === wantKey) return true;
    return (
      strField(fields, "repo") === repoSlug &&
      strField(fields, "oid").toLowerCase() === oid.toLowerCase() &&
      strField(fields, "context") === context
    );
  });

  if (!match) return empty("missing");
  return rowToCi(match.fields, resolved_via);
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
 * `--force` bypasses (caller passes force=true).
 */
export async function assertLifecycleMoveAllowed(opts: {
  node: NodeClient;
  card: Card;
  targetColumn: string;
  terminalColumn: string;
  force?: boolean;
}): Promise<void> {
  if (opts.force) return;
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
  throw new FkanbanError({
    code: "lifecycle_status_blocked",
    message:
      `lifecycle_status_blocked: Card "${opts.card.slug}" cannot move to ` +
      `"${opts.targetColumn}" until required pipeline contexts succeed (${detail}).`,
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
