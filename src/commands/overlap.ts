// `fkanban overlap <slug>` — compare a candidate card's declared file surfaces
// against in-flight cards in the same repo.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  hydrateCardBodies,
  isBodyOmitted,
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
  /**
   * In-flight peers that were REACHED but could not be compared — no repo, no
   * surfaces, or a body that was never read. Empty conflicts plus a non-empty
   * list here is not a pass; it is a pass over the peers that could be judged.
   */
  unevaluatedPeers: string[];
  /**
   * The candidate itself declared nothing to compare (no repo, or no surfaces),
   * so no comparison ran at all. This is the common case on the live board.
   */
  candidateUndeclared: boolean;
};

/**
 * What the gate is entitled to SAY, as opposed to what it found.
 *
 * `conflicts.length === 0` conflates three different states, and the gate line
 * used to render all three as "no conflicts with doing":
 *
 * - `conflict` — real overlaps were found.
 * - `clear`    — the candidate declared surfaces AND every in-flight peer was
 *                comparable. This is the only state that earns a pass.
 * - `unknown`  — the candidate declared nothing, so nothing was compared. The
 *                gate has no input and no opinion.
 * - `partial`  — comparisons ran, but at least one in-flight peer could not be
 *                judged, so a conflict may exist behind an undeclared peer.
 *
 * Deliberately advisory: this changes what the gate REPORTS, not what it
 * BLOCKS. `pickup claim` still skips on `conflicts` alone, so an
 * unknown/partial verdict cannot strand a card on a board where — as measured
 * — essentially nothing declares surfaces.
 */
export type OverlapVerdict = "conflict" | "clear" | "unknown" | "partial";

export function overlapVerdict(result: OverlapResult): OverlapVerdict {
  if (result.conflicts.length > 0) return "conflict";
  if (result.candidateUndeclared) return "unknown";
  if (result.unevaluatedPeers.length > 0) return "partial";
  return "clear";
}

export function claimedRepo(card: Card): string {
  return (card.repo || parseBodyHeader(card.body, "Repo")).trim();
}

export function claimedSurfaces(card: Card): string[] {
  return card.surfaces.length > 0
    ? normalizeSurfaces(card.surfaces)
    : parseBodyListHeader(card.body, "Surfaces");
}

// Both claims above fall back to a BODY header when the structured field is
// empty. On a body-free projection that fallback reads `""` and returns the
// same answer as "the card declares nothing" — so an unread body looks exactly
// like an honest absence, and the difference is a missed conflict. See
// `Card[BODY_OMITTED]`: these two say when we are guessing.
function repoUnread(card: Card): boolean {
  return card.repo.trim().length === 0 && isBodyOmitted(card);
}

function surfacesUnread(card: Card): boolean {
  return card.surfaces.length === 0 && isBodyOmitted(card);
}

/**
 * Point-read the bodies overlap is about to judge.
 *
 * Bounded on purpose: only cards in `doing` can be an overlap peer, and only
 * those whose repo or surfaces claim is missing from the structured fields need
 * their body at all. On the live board that is at most the WIP set (single
 * digits), not the 200-card active list — hydrating the whole list is the N+1
 * storm `listCards` exists to avoid.
 */
export async function hydrateOverlapPeers(
  node: NodeClient,
  cfg: Config,
  cards: Card[],
): Promise<Card[]> {
  const needsBody = cards.filter(
    (card) => card.column === "doing" && (repoUnread(card) || surfacesUnread(card)),
  );
  if (needsBody.length === 0) return cards;
  const hydrated = new Map(
    (await hydrateCardBodies(node, cfg, needsBody)).map((card) => [card.slug, card]),
  );
  return cards.map((card) => hydrated.get(card.slug) ?? card);
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

/** Pure overlap check against an in-memory card list (used by pickup claim). */
export function overlapAgainstCards(candidate: Card, cards: Card[]): OverlapResult {
  const repo = claimedRepo(candidate);
  const surfaces = claimedSurfaces(candidate);
  const warnings: string[] = [];
  const conflicts: SurfaceConflict[] = [];
  const unevaluatedPeers: string[] = [];

  if (!repo) {
    warnings.push(
      repoUnread(candidate)
        ? `candidate ${candidate.slug} has no repo field and its body was not read; overlap skipped`
        : `candidate ${candidate.slug} has no repo; overlap skipped`,
    );
  }
  if (surfaces.length === 0) {
    warnings.push(
      surfacesUnread(candidate)
        ? `candidate ${candidate.slug} has no surfaces field and its body was not read; overlap unknown`
        : `candidate ${candidate.slug} has no surfaces; overlap unknown`,
    );
  }
  if (!repo || surfaces.length === 0) {
    // Nothing was compared — the peer loop below never runs. Say so, rather
    // than letting an empty `conflicts` read as a clean bill of health.
    return {
      slug: candidate.slug,
      repo,
      surfaces,
      conflicts,
      warnings,
      unevaluatedPeers,
      candidateUndeclared: true,
    };
  }

  // A peer whose repo lives only in an unread body cannot be ruled out of the
  // candidate's repo, so it stays in the set and is reported as unknown rather
  // than filtered away as "different repo".
  const inFlight = cards.filter((card) =>
    card.slug !== candidate.slug &&
    card.column === "doing" &&
    (claimedRepo(card) === repo || repoUnread(card))
  );

  for (const card of inFlight) {
    if (repoUnread(card)) {
      warnings.push(`${card.slug} is in ${card.column} with no repo field and its body was not read; overlap unknown`);
      unevaluatedPeers.push(card.slug);
      continue;
    }
    const otherSurfaces = claimedSurfaces(card);
    if (otherSurfaces.length === 0) {
      warnings.push(
        surfacesUnread(card)
          ? `${card.slug} is in ${card.column} for ${repo} with no surfaces field and its body was not read; overlap unknown`
          : `${card.slug} is in ${card.column} for ${repo} with no surfaces; overlap unknown`,
      );
      unevaluatedPeers.push(card.slug);
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

  return {
    slug: candidate.slug,
    repo,
    surfaces,
    conflicts,
    warnings,
    unevaluatedPeers,
    candidateUndeclared: false,
  };
}

export async function overlapResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<OverlapResult> {
  // The candidate point-read and the board list are independent: `listCards`
  // is keyed by nothing the candidate returns, and the candidate is not read
  // out of the list (it may be in a column the list drops). Awaiting them in
  // sequence made this command pay two ~190ms round trips where one would do —
  // and `pickup claim` runs it on every candidate it considers.
  //
  // `allSettled`, not `all`, so overlapping them cannot change WHICH error a
  // caller sees. With `all` the first rejection wins, so a flaky board read
  // would mask "no such card" on a typo'd slug — the one error the caller can
  // act on. The candidate's failure keeps precedence, exactly as when the
  // reads were serial.
  const [candidate, cards] = await Promise.allSettled([
    requireCard(opts.node, opts.cfg, opts.slug),
    listCards(opts.node, opts.cfg),
  ]);
  if (candidate.status === "rejected") throw candidate.reason;
  if (cards.status === "rejected") throw cards.reason;
  const peers = await hydrateOverlapPeers(opts.node, opts.cfg, cards.value);
  return overlapAgainstCards(candidate.value, peers);
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
