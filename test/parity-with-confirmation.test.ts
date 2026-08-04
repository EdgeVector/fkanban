// The confirm-before-accusing dance, as one thing that all three parity checks
// call — instead of one thing BoardCards does inline and two that skip it.
//
// `confirmParityDrop` shipped index-agnostic and pure, but only the BoardCards
// call site was wired to it. BoardMilestones and MilestoneCards kept the
// original sweep-then-wide comparison, which means the same delete-race that
// made BoardCards cry wolf twice on 2026-08-04 is still live on both — and both
// print a WRITE remedy (`kanban milestone reconcile`) when they fire.
//
// The re-sweep is the expensive half (24 partition queries for BoardCards, 19
// partitions for MilestoneCards), so it runs ONLY when the first pass flagged
// something. A healthy board — the overwhelmingly common case — pays nothing.
//
// The resweep is injected, so the decision is testable without a node. That is
// the same reason `confirmParityDrop` is pure: a verdict that prescribes a
// write repair to an operator should not need live infrastructure to test.
import { expect, test, describe } from "bun:test";
import { parityWithConfirmation } from "../src/membership_schema_guard.ts";

const row = (sk: string, slug: string) => ({ sk, slug });
const sweep = (rows: { sk: string; slug: string }[]) => async () => ({ rows, failedLeads: [] });

describe("parityWithConfirmation", () => {
  test("a healthy partition never pays for the second sweep", async () => {
    let resweeps = 0;
    const got = await parityWithConfirmation({
      firstSweep: [row("todo#0001#alpha", "alpha")],
      wideSlugs: new Set(["alpha"]),
      wideRows: 1,
      resweep: async () => {
        resweeps++;
        return { rows: [], failedLeads: [] };
      },
    });
    expect(got.parity.ok).toBe(true);
    expect(resweeps).toBe(0);
  });

  test("a row deleted mid-check is churn, not a finding, and prescribes no repair", async () => {
    const first = [row("todo#0001#alpha", "alpha"), row("todo#0002#bravo", "bravo")];
    const got = await parityWithConfirmation({
      firstSweep: first,
      wideSlugs: new Set(["alpha"]),
      wideRows: 1,
      resweep: sweep([row("todo#0001#alpha", "alpha")]), // bravo gone
    });
    expect(got.parity.ok).toBe(true);
    expect(got.moved).toEqual(["bravo"]);
    expect(got.confirmed).toBe(true);
  });

  test("a row that held still and the wide read still missed is reported as drift", async () => {
    const both = [row("todo#0001#alpha", "alpha"), row("todo#0002#bravo", "bravo")];
    const got = await parityWithConfirmation({
      firstSweep: both,
      wideSlugs: new Set(["alpha"]),
      wideRows: 1,
      resweep: sweep(both),
      remedy: "run `kanban milestone reconcile <slug>`",
    });
    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) {
      expect(got.parity.dropped).toBe(1);
      expect(got.parity.reason).toContain("bravo");
      expect(got.parity.reason).toContain("milestone reconcile");
    }
    expect(got.moved).toEqual([]);
  });

  test("gain-and-drop in the same window stays RED — the verdict is on slugs, not totals", async () => {
    // The wide read returns as many rows as the sweep saw, so a subtraction
    // reports green. `delta` is still a slug the board cannot serve.
    const first = [
      row("todo#0001#alpha", "alpha"),
      row("todo#0003#delta", "delta"),
    ];
    const got = await parityWithConfirmation({
      firstSweep: first,
      wideSlugs: new Set(["alpha", "echo"]), // echo arrived after the sweep
      wideRows: 2,
      resweep: sweep(first),
    });
    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) expect(got.parity.dropped).toBe(1);
  });

  test("a re-sweep that could not run keeps the accusation rather than explaining it away", async () => {
    // A short second baseline would report every stable row as 'moved'. That is
    // the one direction this must never fail in, so the unconfirmed verdict
    // stands and says so.
    const got = await parityWithConfirmation({
      firstSweep: [row("todo#0002#bravo", "bravo")],
      wideSlugs: new Set<string>(),
      wideRows: 0,
      resweep: async () => null,
    });
    expect(got.parity.ok).toBe(false);
    expect(got.confirmed).toBe(false);
    expect(got.moved).toEqual([]);
  });

  test("a re-sweep with a refused lead is also unconfirmed, not a clean bill", async () => {
    const got = await parityWithConfirmation({
      firstSweep: [row("todo#0002#bravo", "bravo")],
      wideSlugs: new Set<string>(),
      wideRows: 0,
      resweep: async () => ({
        rows: [row("todo#0002#bravo", "bravo")],
        failedLeads: [{ field: "column", error: "laststore: corrupt: empty rec" }],
      }),
    });
    expect(got.parity.ok).toBe(false);
    expect(got.confirmed).toBe(false);
  });

  test("the same slug reported twice by the sweep is one casualty, not two", async () => {
    // Two sks for one slug is an unfinished `rank`. Both stable, both unseen —
    // the board is missing ONE card.
    const both = [row("todo#0002#echo", "echo"), row("todo#0009#echo", "echo")];
    const got = await parityWithConfirmation({
      firstSweep: both,
      wideSlugs: new Set<string>(),
      wideRows: 0,
      resweep: sweep(both),
    });
    expect(got.parity.ok).toBe(false);
    if (!got.parity.ok) expect(got.parity.dropped).toBe(1);
  });
});
