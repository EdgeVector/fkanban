// `first_doing_at` is the stall clock the pickup fleet did not have.
//
// The failure it exists to make visible: on 2026-09-22 one card
// (`lastdb-streaming-file-blob-put`) fenced 4 ready cards and 6 pickup workers
// through the surface-overlap gate. It had been unresolved since 2026-09-17,
// but `last-stack-factory-health` measured its doing-age at 0.16h, because a
// watch re-dispatch (`move <slug> todo`, then a pickup claim back into
// `doing`) rewrites `position` — the very field the age clock reads. The 5h
// HARD band was crossed twice that day and cleared by a reset both times.
//
// So the property under test is not "a stamp exists". It is: the stamp
// SURVIVES the todo -> doing cycle that resets `position`.

import { describe, expect, test } from "bun:test";

import {
  cardToFields,
  emptyStructuredFields,
  firstDoingAtForColumnTransition,
  firstDoingAtTag,
  rowToCard,
  type Card,
} from "../src/record.ts";
import {
  boardCardFieldsFromCard,
  cardFromBoardCardFields,
} from "../src/board-cards.ts";

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-09-17T15:53:46.000Z",
    created_by: "test",
    updated_at: "2026-09-17T15:53:46.000Z",
    ...emptyStructuredFields(),
    ...partial,
  };
}

const T1 = "2026-09-17T16:00:00.000Z";
const T2 = "2026-09-20T10:00:00.000Z";
const T3 = "2026-09-22T13:39:51.000Z";

describe("firstDoingAtForColumnTransition", () => {
  test("stamps on the first entry into doing", () => {
    expect(firstDoingAtForColumnTransition(card({ first_doing_at: "" }), "doing", T1)).toBe(T1);
  });

  test("keeps the original stamp on a re-entry into doing", () => {
    const claimed = card({ first_doing_at: T1 });
    expect(firstDoingAtForColumnTransition(claimed, "doing", T3)).toBe(T1);
  });

  test("survives a re-dispatch to todo — the whole point", () => {
    const claimed = card({ column: "doing", first_doing_at: T1 });
    const requeued = firstDoingAtForColumnTransition(claimed, "todo", T2);
    expect(requeued).toBe(T1);
    // and the next claim still reads the ORIGINAL attempt start
    expect(firstDoingAtForColumnTransition(card({ first_doing_at: requeued }), "doing", T3)).toBe(T1);
  });

  test("clears on done — a shipped card starts fresh if reopened", () => {
    expect(firstDoingAtForColumnTransition(card({ first_doing_at: T1 }), "done", T3)).toBe("");
  });

  test("clears on backlog — a deliberate park is not a stall", () => {
    // A card held for a human decision for three weeks must not wake up three
    // weeks stale. `backlog` is the park lane, so it ends the attempt.
    expect(firstDoingAtForColumnTransition(card({ first_doing_at: T1 }), "backlog", T3)).toBe("");
  });

  test("a card created straight into doing is stamped", () => {
    expect(firstDoingAtForColumnTransition(null, "doing", T1)).toBe(T1);
  });

  test("a card created into todo carries no stamp", () => {
    expect(firstDoingAtForColumnTransition(null, "todo", T1)).toBe("");
  });
});

describe("the 2026-09-22 starvation cycle", () => {
  test("three build attempts age from the FIRST claim, not the last", () => {
    // Replay the real loop: claim, re-dispatch, claim, re-dispatch, claim.
    // `position` is rewritten on every column enter; the stall clock is not.
    let c = card({ column: "todo", first_doing_at: "" });
    const stamps = ["2026-09-17T16:00:00.000Z", "2026-09-22T05:45:00.000Z", T3];

    for (const at of stamps) {
      c = {
        ...c,
        column: "doing",
        position: String(Date.parse(at)),
        first_doing_at: firstDoingAtForColumnTransition(c, "doing", at),
      };
      c = {
        ...c,
        column: "todo",
        position: String(Date.parse(at) + 1),
        first_doing_at: firstDoingAtForColumnTransition(c, "todo", at),
      };
    }

    const HARD_BAND_H = 5; // factory-health [doing] hard_max_age_h
    const asOf = Date.parse(T3) + 60_000;

    // What the OLD clock saw on the final pass: about a minute. Under the
    // band, so no alarm — which is what happened for five days.
    const positionAgeH = (asOf - Number(c.position)) / 3_600_000;
    expect(positionAgeH).toBeLessThan(HARD_BAND_H);

    // What the NEW clock sees: the whole unresolved attempt, well past HARD.
    expect(c.first_doing_at).toBe("2026-09-17T16:00:00.000Z");
    const stallAgeH = (asOf - Date.parse(c.first_doing_at)) / 3_600_000;
    expect(stallAgeH).toBeGreaterThan(HARD_BAND_H);
    expect(Math.round(stallAgeH)).toBe(118);
  });
});

describe("persistence", () => {
  test("round-trips through the Card schema as a tag", () => {
    const fields = cardToFields(card({ first_doing_at: T1, tags: ["lastdb", "p2"] }));
    expect(fields.tags).toContain(firstDoingAtTag(T1));

    const back = rowToCard({ key: { hash: "c", range: "" }, fields } as never);
    expect(back.first_doing_at).toBe(T1);
    // The stamp is a clock, not a label: it must not surface as a user tag.
    expect(back.tags).toEqual(["lastdb", "p2"]);
  });

  test("round-trips through the BoardCards thin projection", () => {
    // This is the projection `kanban list --json --all` reads, and
    // `last-stack-factory-health` ages the doing column from exactly that.
    // A stamp that only lived on the Card schema would never reach the alarm.
    const fields = boardCardFieldsFromCard(card({ column: "doing", first_doing_at: T1, tags: ["p2"] }));
    const back = cardFromBoardCardFields(fields);
    expect(back.first_doing_at).toBe(T1);
    expect(back.tags).toEqual(["p2"]);
  });

  test("an unstamped card round-trips as empty, not as a bogus tag", () => {
    const fields = boardCardFieldsFromCard(card({ tags: ["p2"] }));
    expect(fields.tags).toEqual(["p2"]);
    expect(cardFromBoardCardFields(fields).first_doing_at).toBe("");
  });

  test("a legacy row with no stamp reads as empty", () => {
    const back = rowToCard({
      key: { hash: "c", range: "" },
      fields: { slug: "c", column: "doing", tags: ["p2"] },
    } as never);
    expect(back.first_doing_at).toBe("");
  });
});
