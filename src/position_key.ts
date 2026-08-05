// The position segment of a membership range key — one definition, three indexes.
//
// BoardCards (`column#pos(8)#slug`), MilestoneCards (same shape, via
// `boardCardSk`) and BoardMilestones (`state#pos(8)#slug`) all encode a
// position the same way, and all read it back. It lived twice: once correctly
// in `board-cards.ts` and once, as `String(Number(seg))`, in
// `board-milestones.ts`. That is not a coincidence to tidy up — a key format
// duplicated per index is a format that drifts per index, and this one had
// already drifted into a destructive inverse on the side nobody re-read.
// It belongs to the key, so it lives with the key.

/** Pad a position into the fixed-width segment the range key sorts on. */
export function padPositionSegment(position: string | number): string {
  return String(position).padStart(POSITION_SEGMENT_WIDTH, "0");
}

/**
 * Width of the padded segment. Load-bearing: a partition is read in KEY order,
 * so a column's displayed and drained order is LEXICOGRAPHIC over this segment,
 * not numeric. The two agree only while every position pads to the same width.
 * See `MAX_PADDABLE_POSITION` in `rank_positions.ts`, which is what keeps minted
 * ranks inside one width class.
 */
export const POSITION_SEGMENT_WIDTH = 8;

/**
 * Invert {@link padPositionSegment}.
 *
 * The inverse of STRING padding is STRING stripping. This used to be
 * `String(Number(seg))`, which is a different operation that happens to agree
 * on plain integers and disagrees destructively everywhere else:
 *
 * | position | key segment | `String(Number(…))` | strip |
 * |---|---|---|---|
 * | `7777` | `00007777` | `7777` | `7777` |
 * | `m` | `0000000m` | **`NaN`** | `m` |
 * | `-5` | `000000-5` | **`NaN`** | `-5` |
 * | `1e3` | `000001e3` | **`1000`** | `1e3` |
 *
 * The `1e3` row is the one worth staring at: the numeric path did not fail
 * loudly there, it returned a plausible DIFFERENT position. Both `board_cards_heal`
 * and `milestone_indexes_heal` compare a rebuilt address or position against the
 * fat record's (`boardCardSk(r.column, r.position, r.slug) === truthSk`;
 * `String(row.position) === String(truth.position)`) and write the parsed value
 * back, so a value that parses to something else is how a correct membership row
 * gets reported stale and then "repaired" into a wrong rank.
 *
 * A milestone is the reachable case: `move --position` is validated by
 * `parseIntFlag`, but `milestone add --position` is not, so `1e3` is an
 * invocation a user can type today.
 *
 * What still does not round-trip is a position whose own string form STARTS
 * with `0` (`"007"` pads to `"00000007"` and strips back to `"7"`). That is not
 * recoverable here and not a parse bug: padding is not injective over such
 * inputs, so the key format itself cannot represent them distinctly. Callers
 * that need to know go through the rebuild check — a position that survives
 * `boardCardSk(column, position, slug) === sk` is exact, and that comparison is
 * what heal already gates on.
 *
 * An all-zero segment is the position `0`, not the empty string.
 */
export function unpadPositionSegment(segment: string): string {
  const stripped = segment.replace(/^0+/, "");
  return stripped.length > 0 ? stripped : "0";
}
