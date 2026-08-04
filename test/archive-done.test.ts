import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  ARCHIVE_AGE_FIELDS,
  DEFAULT_ARCHIVE_CUTOFF_HOURS,
  DEFAULT_ARCHIVE_MAX,
  archiveDoneResult,
} from "../src/commands/archive_done.ts";
import type { Board, Card } from "../src/record.ts";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {},
} as Config;

const node = {} as NodeClient;

const NOW = Date.parse("2026-07-31T06:00:00.000Z");
const hoursAgo = (h: number) => new Date(NOW - h * 3_600_000).toISOString();

function card(partial: Partial<Card> & { slug: string }): Card {
  return {
    title: partial.slug,
    body: "",
    board: "default",
    column: "done",
    position: "0",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: hoursAgo(500),
    created_by: "test",
    updated_at: hoursAgo(500),
    done_at: "",
    db: "",
    repo: "",
    base: "",
    kind: "",
    block_status: "",
    block_reason: "",
    north_star: "",
    milestone: "",
    pr_url: "",
    branch: "",
    ...partial,
  };
}

const board = (slug: string): Board =>
  ({
    slug,
    title: slug,
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "",
    updated_at: "",
  }) as Board;

/** Build the injected readers from a column → cards map, per board. */
function fixture(byBoardColumn: Record<string, Record<string, Card[]>>) {
  const removed: string[] = [];
  const reads: Array<{ board: string; column: string }> = [];
  return {
    removed,
    reads,
    opts: {
      cfg,
      node,
      now: NOW,
      boardsFor: async () => Object.keys(byBoardColumn).map(board),
      cardsIn: async (_n: NodeClient, _c: Config, column: string, b: string) => {
        reads.push({ board: b, column });
        return byBoardColumn[b]?.[column] ?? [];
      },
      remove: async (_o: unknown, c: Card) => {
        removed.push(c.slug);
      },
      // No milestones by default, so these cases exercise the sweep itself. The
      // proof-card hold has its own file: proof-card-delete-hold.test.ts.
      milestonesFor: async () => [],
    },
  };
}

describe("groom archive-done", () => {
  test("dry-run by default: reports eligible cards and writes nothing", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "old-1", updated_at: hoursAgo(100) }),
          card({ slug: "fresh-1", updated_at: hoursAgo(2) }),
        ],
      },
    });
    const { report } = await archiveDoneResult(f.opts);

    expect(report.dryRun).toBe(true);
    expect(report.terminal_rows).toBe(2);
    expect(report.eligible).toBe(1);
    expect(report.archived).toBe(0);
    expect(f.removed).toEqual([]);
    expect(report.actions.map((a) => [a.slug, a.action])).toEqual([["old-1", "would-archive"]]);
  });

  test("--apply archives only cards past the cutoff", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "old-1", updated_at: hoursAgo(100) }),
          card({ slug: "fresh-1", updated_at: hoursAgo(2) }),
          card({ slug: "edge-just-under", updated_at: hoursAgo(DEFAULT_ARCHIVE_CUTOFF_HOURS - 0.1) }),
          card({ slug: "edge-just-over", updated_at: hoursAgo(DEFAULT_ARCHIVE_CUTOFF_HOURS + 0.1) }),
        ],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(report.archived).toBe(2);
    expect(f.removed.sort()).toEqual(["edge-just-over", "old-1"]);
    expect(report.failed).toBe(0);
  });

  test("oldest cards are archived first, so a capped run drains the coldest end", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "age-50", updated_at: hoursAgo(50) }),
          card({ slug: "age-900", updated_at: hoursAgo(900) }),
          card({ slug: "age-300", updated_at: hoursAgo(300) }),
        ],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true, max: 2 });

    expect(f.removed).toEqual(["age-900", "age-300"]);
    expect(report.archived).toBe(2);
    expect(report.deferred).toBe(1);
    expect(report.eligible).toBe(3);
  });

  // The regression that made the whole command necessary: `updated_at` is absent
  // from CARD_STATUS_FIELDS, and LastDB returns "" for an unprojected field. A
  // sweep whose projection omits it ages nothing and reports a clean run.
  test("age projection includes updated_at and done_at", () => {
    expect(ARCHIVE_AGE_FIELDS).toContain("updated_at");
    expect(ARCHIVE_AGE_FIELDS).toContain("done_at");
    expect(ARCHIVE_AGE_FIELDS).toContain("deps");
  });

  test("an unparsable timestamp is counted, never archived", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "no-stamp", updated_at: "", done_at: "" }),
          card({ slug: "garbage-stamp", updated_at: "not-a-date" }),
          card({ slug: "old-1", updated_at: hoursAgo(100) }),
        ],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(report.boards[0]!.unparsable_age).toBe(2);
    expect(f.removed).toEqual(["old-1"]);
  });

  test("done_at wins over updated_at, so a touched-but-long-done card still ages", async () => {
    const f = fixture({
      default: {
        done: [card({ slug: "touched", done_at: hoursAgo(500), updated_at: hoursAgo(1) })],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(report.eligible).toBe(1);
    expect(f.removed).toEqual(["touched"]);
  });

  // Deleting a dep makes it read back as MISSING, which flips every dependent to
  // blocked. The sweep must recognise that BEFORE the write and not count it as
  // a failure — a sweep reporting failures nobody can act on gets muted.
  test("a card a live non-terminal card still depends on is skipped, not failed", async () => {
    const f = fixture({
      default: {
        done: [card({ slug: "needed-dep", updated_at: hoursAgo(100) })],
        todo: [card({ slug: "waiter", column: "todo", deps: ["needed-dep"] })],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(report.skipped_dependency).toBe(1);
    expect(report.failed).toBe(0);
    expect(report.archived).toBe(0);
    expect(f.removed).toEqual([]);
  });

  // Found on the live board: the headline read `would_archive=502` while 30 of
  // those 502 were dependency-held. The one number a human reads must not be
  // derived arithmetically from `eligible`.
  test("the dry-run headline excludes dependency-held cards", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "held", updated_at: hoursAgo(100) }),
          card({ slug: "free", updated_at: hoursAgo(100) }),
        ],
        todo: [card({ slug: "waiter", column: "todo", deps: ["held"] })],
      },
    });
    const { report, text } = await archiveDoneResult(f.opts);

    expect(report.eligible).toBe(2);
    expect(report.skipped_dependency).toBe(1);
    expect(text).toContain("would_archive=1");
    expect(text).not.toContain("would_archive=2");
  });

  // A dry run must preview exactly what --apply would do. Counting the cap against
  // `archived` (never incremented in a dry run) made the preview promise every
  // eligible card: 472 on the live board where --apply would archive 200.
  test("dry-run honours --max, so the preview matches the apply", async () => {
    const done = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `age-${i}`, updated_at: hoursAgo(100 + i) }),
    );
    const dry = fixture({ default: { done } });
    const dryRun = await archiveDoneResult({ ...dry.opts, max: 2 });
    expect(dryRun.report.deferred).toBe(3);
    expect(dryRun.text).toContain("would_archive=2");

    const wet = fixture({ default: { done } });
    const applyRun = await archiveDoneResult({ ...wet.opts, apply: true, max: 2 });
    expect(applyRun.report.archived).toBe(2);
    expect(applyRun.report.deferred).toBe(3);
    // The preview named the same cards the apply actually archived.
    expect(dryRun.report.actions.filter((a) => a.action === "would-archive").map((a) => a.slug))
      .toEqual(wet.removed);
  });

  test("a delete that fails still consumes cap budget", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "boom", updated_at: hoursAgo(900) }),
          card({ slug: "next", updated_at: hoursAgo(100) }),
        ],
      },
    });
    const { report } = await archiveDoneResult({
      ...f.opts,
      apply: true,
      max: 1,
      remove: async () => {
        throw new Error("node said no");
      },
    });
    expect(report.failed).toBe(1);
    expect(report.deferred).toBe(1);
  });

  test("a dep declared only by another TERMINAL card does not protect it", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "needed-dep", updated_at: hoursAgo(100) }),
          card({ slug: "finished-waiter", updated_at: hoursAgo(100), deps: ["needed-dep"] }),
        ],
      },
    });
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(report.skipped_dependency).toBe(0);
    expect(report.archived).toBe(2);
  });

  test("a delete failure is reported, and does not abort the sweep", async () => {
    const f = fixture({
      default: {
        done: [
          card({ slug: "boom", updated_at: hoursAgo(900) }),
          card({ slug: "fine", updated_at: hoursAgo(100) }),
        ],
      },
    });
    const { report } = await archiveDoneResult({
      ...f.opts,
      apply: true,
      remove: async (_o: unknown, c: Card) => {
        if (c.slug === "boom") throw new Error("node said no\nsecond line dropped");
        f.removed.push(c.slug);
      },
    });

    expect(report.failed).toBe(1);
    expect(report.archived).toBe(1);
    expect(f.removed).toEqual(["fine"]);
    expect(report.actions.find((a) => a.slug === "boom")!.reason).toBe("node said no");
  });

  test("every board's terminal column is swept, and --board narrows to one", async () => {
    const layout = {
      default: { done: [card({ slug: "d-old", updated_at: hoursAgo(100) })] },
      scratch: {
        done: [card({ slug: "s-old", board: "scratch", updated_at: hoursAgo(100) })],
      },
    };

    const all = fixture(layout);
    const allRun = await archiveDoneResult({ ...all.opts, apply: true });
    expect(allRun.report.boards.map((b) => b.board).sort()).toEqual(["default", "scratch"]);
    expect(all.removed.sort()).toEqual(["d-old", "s-old"]);

    const one = fixture(layout);
    const oneRun = await archiveDoneResult({ ...one.opts, apply: true, board: "scratch" });
    expect(oneRun.report.boards.map((b) => b.board)).toEqual(["scratch"]);
    expect(one.removed).toEqual(["s-old"]);
  });

  test("--board rejects a board that is not live", async () => {
    const f = fixture({ default: { done: [] } });
    await expect(archiveDoneResult({ ...f.opts, board: "nope" })).rejects.toThrow(/No live board/);
  });

  test("a custom cutoff is honoured", async () => {
    const f = fixture({
      default: { done: [card({ slug: "age-100", updated_at: hoursAgo(100) })] },
    });
    const strict = await archiveDoneResult({ ...f.opts, cutoffHours: 200 });
    expect(strict.report.eligible).toBe(0);
    const loose = await archiveDoneResult({ ...f.opts, cutoffHours: 50 });
    expect(loose.report.eligible).toBe(1);
  });

  test("the per-run ceiling has a bounded default", () => {
    expect(DEFAULT_ARCHIVE_MAX).toBeGreaterThan(0);
    expect(DEFAULT_ARCHIVE_MAX).toBeLessThanOrEqual(1000);
  });

  test("the terminal column is never read as a dep source", async () => {
    const f = fixture({
      default: {
        done: [card({ slug: "old-1", updated_at: hoursAgo(100) })],
        todo: [],
        doing: [],
        backlog: [],
      },
    });
    await archiveDoneResult({ ...f.opts, apply: true });

    // one read of the terminal column for eligibility, then only NON-terminal
    // columns for the dependency guard.
    const terminalReads = f.reads.filter((r) => r.column === "done");
    expect(terminalReads).toHaveLength(1);
    expect(f.reads.filter((r) => r.column !== "done").map((r) => r.column).sort()).toEqual([
      "backlog",
      "doing",
      "todo",
    ]);
  });

  // The sweep's reads are independent partition reads, and a read is almost
  // entirely per-request latency, so what it costs is serial WAVES
  // (`concurrency.ts`). Both fan-outs here — one terminal read per board, and
  // boards x non-terminal columns for the dependency guard — used to run one
  // after another, which is invisible to every other test in this file: they
  // assert WHICH columns were read, and a serial and a concurrent sweep read
  // exactly the same ones.
  //
  // So this asserts the property those cannot: that the reads OVERLAP. It fails
  // against the serial version with maxInFlight = 1.
  test("board reads are issued concurrently, not one wave per board", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const boards = ["b1", "b2", "b3", "b4"];
    const { report } = await archiveDoneResult({
      cfg,
      node,
      now: NOW,
      boardsFor: async () => boards.map(board),
      cardsIn: async (_n: NodeClient, _c: Config, column: string, b: string) => {
        inFlight += 1;
        maxInFlight = Math.max(maxInFlight, inFlight);
        // A real read is a socket round trip; yield so overlap is observable.
        await new Promise((r) => setTimeout(r, 5));
        inFlight -= 1;
        return column === "done" && b === "b1"
          ? [card({ slug: "old-1", board: b, updated_at: hoursAgo(100) })]
          : [];
      },
      remove: async () => {},
      milestonesFor: async () => [],
    });

    // 4 boards x 3 non-terminal columns = 12 dep-guard reads, plus 4 terminal
    // reads. Serial would be 16 waves of 1.
    expect(maxInFlight).toBeGreaterThan(1);
    // And the result is unchanged by the overlap.
    expect(report.eligible).toBe(1);
    expect(report.actions.map((a) => a.slug)).toEqual(["old-1"]);
  });
});
