// `fkanban overlap <slug>` — compare a candidate card's declared file surfaces
// against in-flight cards in the same repo.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  listCards,
  normalizeSurfaces,
  parseBodyHeader,
  parseBodyListHeader,
  requireCard,
  type Card,
} from "../record.ts";

export type SurfaceConflict = {
  slug: string;
  title: string;
  column: string;
  repo: string;
  matches: Array<{ candidate: string; other: string }>;
};

export type OverlapResult = {
  slug: string;
  repo: string;
  surfaces: string[];
  conflicts: SurfaceConflict[];
  warnings: string[];
};

function claimedRepo(card: Card): string {
  return (card.repo || parseBodyHeader(card.body, "Repo")).trim();
}

export function claimedSurfaces(card: Card): string[] {
  return card.surfaces.length > 0
    ? normalizeSurfaces(card.surfaces)
    : parseBodyListHeader(card.body, "Surfaces");
}

function cleanPattern(pattern: string): string {
  return pattern.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

function literalPrefix(pattern: string): string {
  const p = cleanPattern(pattern);
  const wildcard = p.search(/[*?[]/);
  if (wildcard < 0) return p;
  const raw = p.slice(0, wildcard);
  const slash = raw.lastIndexOf("/");
  if (slash >= 0) return raw.slice(0, slash + 1);
  return raw;
}

function bareSubsystemMatches(bare: string, other: string): boolean {
  const b = cleanPattern(bare);
  const o = cleanPattern(other);
  if (!b || b.includes("/") || /[*?[]/.test(b)) return false;
  if (o === b || o.startsWith(`${b}/`) || o.includes(`/${b}/`)) return true;
  return o.split("/").some((segment) => segment === b || segment.replace(/\.[^.]+$/, "") === b);
}

export function surfacesMayOverlap(a: string, b: string): boolean {
  const left = cleanPattern(a);
  const right = cleanPattern(b);
  if (!left || !right) return false;
  if (left === right || left === "**" || right === "**") return true;
  if (bareSubsystemMatches(left, right) || bareSubsystemMatches(right, left)) return true;

  const lp = literalPrefix(left);
  const rp = literalPrefix(right);
  if (!lp || !rp) return true;
  return lp.startsWith(rp) || rp.startsWith(lp);
}

function matchedPairs(candidate: string[], other: string[]): Array<{ candidate: string; other: string }> {
  const matches: Array<{ candidate: string; other: string }> = [];
  for (const c of candidate) {
    for (const o of other) {
      if (surfacesMayOverlap(c, o)) matches.push({ candidate: c, other: o });
    }
  }
  return matches;
}

export async function overlapResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<OverlapResult> {
  const candidate = await requireCard(opts.node, opts.cfg, opts.slug);
  const repo = claimedRepo(candidate);
  const surfaces = claimedSurfaces(candidate);
  const warnings: string[] = [];
  const conflicts: SurfaceConflict[] = [];

  if (!repo) warnings.push(`candidate ${candidate.slug} has no repo; overlap skipped`);
  if (surfaces.length === 0) warnings.push(`candidate ${candidate.slug} has no surfaces; overlap unknown`);
  if (!repo || surfaces.length === 0) {
    return { slug: candidate.slug, repo, surfaces, conflicts, warnings };
  }

  const cards = await listCards(opts.node, opts.cfg);
  const inFlight = cards.filter((card) =>
    card.slug !== candidate.slug &&
    (card.column === "doing" || card.column === "review") &&
    claimedRepo(card) === repo
  );

  for (const card of inFlight) {
    const otherSurfaces = claimedSurfaces(card);
    if (otherSurfaces.length === 0) {
      warnings.push(`${card.slug} is in ${card.column} for ${repo} with no surfaces; overlap unknown`);
      continue;
    }
    const matches = matchedPairs(surfaces, otherSurfaces);
    if (matches.length > 0) {
      conflicts.push({
        slug: card.slug,
        title: card.title,
        column: card.column,
        repo,
        matches,
      });
    }
  }

  return { slug: candidate.slug, repo, surfaces, conflicts, warnings };
}

export function formatOverlap(result: OverlapResult, json?: boolean): string {
  if (json) return JSON.stringify(result, null, 2);

  const lines: string[] = [];
  for (const warning of result.warnings) lines.push(`warning: ${warning}`);

  if (result.conflicts.length === 0) {
    lines.push(`No declared surface conflicts for ${result.slug}.`);
    return lines.join("\n");
  }

  lines.push(`Surface conflicts for ${result.slug}:`);
  for (const conflict of result.conflicts) {
    const title = conflict.title ? ` — ${conflict.title}` : "";
    lines.push(`  - ${conflict.slug} [${conflict.column}]${title}`);
    for (const match of conflict.matches) {
      lines.push(`      ${match.candidate} ↔ ${match.other}`);
    }
  }
  return lines.join("\n");
}

export async function overlapCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
}): Promise<{ text: string; result: OverlapResult }> {
  const result = await overlapResult(opts);
  return { text: formatOverlap(result, opts.json), result };
}
