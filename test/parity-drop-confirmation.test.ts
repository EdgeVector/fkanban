// A parity RED must survive a second look before it accuses the board.
//
// `checkProjectionParity` compares an all-leads sweep against a later wide
// read. On a live board those two reads straddle whatever the pickup, groom and
// papercut routines are doing, and a `rank` is write-new-sk + delete-old-sk. A
// row deleted in that window is in the sweep and not in the wide read — the
// exact shape of a row whose gating field has no atom.
//
// Reproduced against the live primary on 2026-08-04 with rows that CANNOT be
// gated (all 24 fields written): `scripts/probe-parity-delete-race-constructed.ts`
// deletes one of four rows mid-check and the shipped comparison reports it as
// drift, with the remedy `kanban groom board-cards-heal --apply` — a WRITE
// repair aimed at a healthy partition. Seen twice unprompted on the real board
// the same morning (129 rows/1 flagged, then 132 rows/5 flagged with two sks
// for one slug), green four minutes later.
//
// So the sweep is taken again after the wide read, and only rows present in
// BOTH sweeps — stably in the partition for the whole window — can be called
// drift.
import { expect, test, describe } from "bun:test";
import { confirmParityDrop } from "../src/membership_schema_guard.ts";

const row = (sk: string, slug: string) => ({ sk, slug });

describe("confirmParityDrop", () => {
  test("a row deleted during the check is 'moved', not drift", () => {
    const first = [row("todo#0001#alpha", "alpha"), row("todo#0002#bravo", "bravo")];
    const second = [row("todo#0001#alpha", "alpha")]; // bravo deleted mid-check
    const wide = new Set(["alpha"]);

    const got = confirmParityDrop(first, second, wide);
    expect(got.drift).toEqual([]);
    expect(got.moved).toEqual(["bravo"]);
  });

  test("a row that stayed put and the wide read still missed IS drift", () => {
    const first = [row("todo#0001#alpha", "alpha"), row("todo#0002#bravo", "bravo")];
    const second = [row("todo#0001#alpha", "alpha"), row("todo#0002#bravo", "bravo")];
    const wide = new Set(["alpha"]); // bravo present throughout, invisible to wide

    const got = confirmParityDrop(first, second, wide);
    expect(got.drift).toEqual(["bravo"]);
    expect(got.moved).toEqual([]);
  });

  test("a re-ranked card is neither — its new sk is visible under the same slug", () => {
    // `rank` writes the new sk then deletes the old one. The slug never left
    // the board, so nothing about it should be reported.
    const first = [row("todo#1785838243182#charlie", "charlie")];
    const second = [row("todo#00000150#charlie", "charlie")];
    const wide = new Set(["charlie"]);

    const got = confirmParityDrop(first, second, wide);
    expect(got.drift).toEqual([]);
    expect(got.moved).toEqual([]);
  });

  test("drift and race in the same window are separated, not merged", () => {
    const first = [
      row("todo#0001#alpha", "alpha"),
      row("todo#0002#bravo", "bravo"), // deleted mid-check
      row("todo#0003#delta", "delta"), // genuinely invisible to the wide read
    ];
    const second = [row("todo#0001#alpha", "alpha"), row("todo#0003#delta", "delta")];
    const wide = new Set(["alpha"]);

    const got = confirmParityDrop(first, second, wide);
    expect(got.drift).toEqual(["delta"]);
    expect(got.moved).toEqual(["bravo"]);
  });

  test("a slug with several sks is drift only when every one of them is stable and unseen", () => {
    // Two rows for one slug (a rank that has not finished). One is deleted; the
    // survivor is still invisible to the wide read. The slug is genuinely
    // missing from the board's product read, so it IS drift — the race on the
    // sibling sk must not launder it into 'moved'.
    const first = [row("todo#0002#echo", "echo"), row("todo#0009#echo", "echo")];
    const second = [row("todo#0009#echo", "echo")];
    const wide = new Set<string>();

    const got = confirmParityDrop(first, second, wide);
    expect(got.drift).toEqual(["echo"]);
    expect(got.moved).toEqual([]);
  });

  test("no flagged rows at all is quiet on both channels", () => {
    const first = [row("todo#0001#alpha", "alpha")];
    const second = [row("todo#0001#alpha", "alpha")];
    const got = confirmParityDrop(first, second, new Set(["alpha"]));
    expect(got.drift).toEqual([]);
    expect(got.moved).toEqual([]);
  });
});
