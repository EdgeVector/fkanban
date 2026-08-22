export type PickupV2Card = {
  slug: string;
  column: string;
  position: string;
  created_at: string;
  repo: string;
  deps: string[];
  surfaces: string[];
};

export type DependencyStatuses = Readonly<Record<string, boolean>>;

function normalizeSurface(surface: string): string {
  return surface.trim().replace(/^\.\//, "").replace(/^\/+/, "").replace(/\/+$/, "");
}

/** Missing surfaces reserve the complete repository. */
export function effectiveSurfaces(card: Pick<PickupV2Card, "surfaces">): string[] {
  const surfaces: string[] = [];
  const seen = new Set<string>();
  for (const raw of card.surfaces) {
    const surface = normalizeSurface(raw);
    if (!surface || seen.has(surface)) continue;
    seen.add(surface);
    surfaces.push(surface);
  }
  return surfaces.length > 0 ? surfaces : ["**"];
}

function literalPrefix(pattern: string): string {
  const wildcard = pattern.search(/[*?[]/);
  if (wildcard < 0) return pattern;
  const raw = pattern.slice(0, wildcard);
  const slash = raw.lastIndexOf("/");
  return slash >= 0 ? raw.slice(0, slash + 1) : raw;
}

function bareSubsystemMatches(bare: string, other: string): boolean {
  if (!bare || bare.includes("/") || /[*?[]/.test(bare)) return false;
  if (other === bare || other.startsWith(`${bare}/`) || other.includes(`/${bare}/`)) return true;
  return other.split("/").some((segment) =>
    segment === bare || segment.replace(/\.[^.]+$/, "") === bare
  );
}

function patternsMayOverlap(left: string, right: string): boolean {
  if (left === right || left === "**" || right === "**") return true;
  if (bareSubsystemMatches(left, right) || bareSubsystemMatches(right, left)) return true;

  const leftPrefix = literalPrefix(left);
  const rightPrefix = literalPrefix(right);
  if (!leftPrefix || !rightPrefix) return true;
  return leftPrefix.startsWith(rightPrefix) || rightPrefix.startsWith(leftPrefix);
}

/** Compare effective surfaces only when both cards name the same repository. */
export function surfacesOverlap(
  candidate: Pick<PickupV2Card, "repo" | "surfaces">,
  doing: Pick<PickupV2Card, "repo" | "surfaces">,
): boolean {
  const candidateRepo = candidate.repo.trim();
  const doingRepo = doing.repo.trim();
  if (!candidateRepo || candidateRepo !== doingRepo) return false;

  return effectiveSurfaces(candidate).some((left) =>
    effectiveSurfaces(doing).some((right) => patternsMayOverlap(left, right))
  );
}

function compareUnsignedIntegerStrings(left: string, right: string): number | null {
  if (!/^\d+$/.test(left) || !/^\d+$/.test(right)) return null;
  const a = left.replace(/^0+(?=\d)/, "");
  const b = right.replace(/^0+(?=\d)/, "");
  return a.length - b.length || a.localeCompare(b);
}

export function comparePickupV2Cards(left: PickupV2Card, right: PickupV2Card): number {
  const leftPosition = left.position.trim() || "0";
  const rightPosition = right.position.trim() || "0";
  const integerOrder = compareUnsignedIntegerStrings(leftPosition, rightPosition);
  const positionOrder = integerOrder ?? Number(leftPosition) - Number(rightPosition);
  if (Number.isFinite(positionOrder) && positionOrder !== 0) return positionOrder;
  return left.created_at.localeCompare(right.created_at) || left.slug.localeCompare(right.slug);
}

function dependenciesAreTerminal(card: PickupV2Card, statuses: DependencyStatuses): boolean {
  return card.deps.every((slug) => statuses[slug] === true);
}

/** Return the first eligible todo card in stable board order. */
export function firstEligible<T extends PickupV2Card>(
  todo: readonly T[],
  doing: readonly PickupV2Card[],
  dependencyStatuses: DependencyStatuses,
): T | undefined {
  const ordered = [...todo].sort(comparePickupV2Cards);
  return ordered.find((candidate) =>
    candidate.column === "todo" &&
    candidate.repo.trim().length > 0 &&
    dependenciesAreTerminal(candidate, dependencyStatuses) &&
    !doing.some((peer) => peer.column === "doing" && surfacesOverlap(candidate, peer))
  );
}
