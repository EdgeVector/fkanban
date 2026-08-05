// The inverse of STRING padding is STRING stripping — on BOTH membership indexes.
//
// `parseBoardCardSk` learned this already. Its `unpadBoardCardPosition` carries
// a table explaining why `String(Number(seg))` is the wrong inverse of
// `padStart(8, "0")`: it is a different operation that agrees with the intended
// one on plain integers and disagrees destructively at the edges — `NaN` for
// anything non-numeric, and, worse, a plausible DIFFERENT number for `1e3`.
//
// `parseBoardMilestoneSk` is the sibling index over the same key shape
// (`state#pos(8)#slug` against `column#pos(8)#slug`) and was never given the
// fix. It still reads its position segment back as `String(Number(seg))`.
//
// This is not theoretical on the milestone side, and that is the asymmetry
// worth naming: a card's position is minted by `add`/`move`/`rank`, and `move`
// routes its `--position` through `parseIntFlag` (clean integer, or exit 2).
// A MILESTONE's position is user-supplied and unvalidated — `cli.ts` passes
// `values.position` straight into `milestoneAddCmd`, which stores
// `opts.position ?? existing?.position ?? String(Date.now())`. So
// `kanban milestone add m --position 1e3` is a supported invocation today, and
// it is the one that comes back as a different milestone position.
//
// Both parse call sites treat the segment as the row's ADDRESS, not as a copy:
//
//   board-milestones.ts:320  `if (m.position.length === 0) m.position = parsed.position`
//                            ("The range key is the row's address; the copies are copies.")
//   board-milestones.ts:413  `position: parsed?.position ?? ""` on BoardMilestoneRow
//
// and `milestone_indexes_heal` gates a rewrite on
// `String(row.position) === String(truth.position)`. So a segment that parses
// to something else is how a correct membership row gets reported stale and
// then "repaired" into a wrong position — the same failure `unpadBoardCardPosition`
// was written to stop.

import { expect, test } from "bun:test";

import { boardCardSk, parseBoardCardSk } from "../src/board-cards.ts";
import { boardMilestoneSk, parseBoardMilestoneSk } from "../src/board-milestones.ts";

// Positions that a writer can actually put on a milestone today. `1e3` and the
// non-numeric cases are reachable through `milestone add --position` (no
// `parseIntFlag` on that path); the 13-digit epoch is what `milestone add`
// mints by default via `String(Date.now())`.
const POSITIONS = [
  "0",
  "3",
  "230",
  "99999999",
  "1785921161431", // String(Date.now()) — padStart(8) is a no-op here
  "1e3", // parses to a plausible DIFFERENT position: 1000
  "-5", // NaN
  "m", // NaN
];

test("parseBoardMilestoneSk round-trips every position boardMilestoneSk can write", () => {
  for (const position of POSITIONS) {
    const sk = boardMilestoneSk("active", position, "some-milestone");
    const parsed = parseBoardMilestoneSk(sk);
    expect(parsed).not.toBeNull();
    expect({ position, got: parsed!.position }).toEqual({ position, got: position });
    expect(parsed!.state).toBe("active");
    expect(parsed!.slug).toBe("some-milestone");
  }
});

// The point of the fix is that the two indexes stop disagreeing about what a
// position segment means. Same padded shape in, same value out.
test("board-milestone and board-card sk position parsing agree", () => {
  for (const position of POSITIONS) {
    const fromMilestone = parseBoardMilestoneSk(
      boardMilestoneSk("active", position, "s"),
    );
    const fromCard = parseBoardCardSk(boardCardSk("active", position, "s"));
    expect({ position, got: fromMilestone!.position }).toEqual({
      position,
      got: fromCard!.position,
    });
  }
});

// A slug may contain `#` (the key is split on the FIRST two separators only),
// and an all-zero segment is the position `0`, not the empty string. Both are
// already true of the card parser; assert the milestone parser matches.
test("parseBoardMilestoneSk splits on the first two separators and keeps zero", () => {
  const parsed = parseBoardMilestoneSk("active#00000000#slug#with#hashes");
  expect(parsed).toEqual({
    state: "active",
    position: "0",
    slug: "slug#with#hashes",
  });
});
