// Tiny "did you mean" support for the CLI's unknown-command path. A standard
// Levenshtein edit distance plus a closest-match picker — no dependency. Used
// so a single-character typo (`fkanban lst`) surfaces `Did you mean "list"?`
// before the full help wall, the way git/cargo/npm/gh already do.

// Classic dynamic-programming Levenshtein (insertions, deletions,
// substitutions, each cost 1). Two rolling rows keep it O(min(a,b)) memory.
export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (a.length === 0) return b.length;
  if (b.length === 0) return a.length;

  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  let curr = new Array<number>(b.length + 1);
  for (let i = 1; i <= a.length; i++) {
    curr[0] = i;
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        prev[j]! + 1, // deletion
        curr[j - 1]! + 1, // insertion
        prev[j - 1]! + cost, // substitution
      );
    }
    [prev, curr] = [curr, prev];
  }
  return prev[b.length]!;
}

// Pick the closest candidate to `input`, but only when it's close enough to be
// a likely typo rather than noise. The threshold is `max(2, ceil(len/3))` so
// short words still match a one-edit fix (`ad`→`add`, `lst`→`list`) while a
// genuinely unrelated token (`frobnicate`) yields no suggestion. Returns the
// best candidate or `null` when nothing is within the threshold.
export function suggestClosest(input: string, candidates: readonly string[]): string | null {
  if (input.length === 0) return null;
  const threshold = Math.max(2, Math.ceil(input.length / 3));
  let best: string | null = null;
  let bestDistance = Infinity;
  for (const candidate of candidates) {
    const d = levenshtein(input, candidate);
    if (d < bestDistance) {
      bestDistance = d;
      best = candidate;
    }
  }
  return best !== null && bestDistance <= threshold ? best : null;
}
