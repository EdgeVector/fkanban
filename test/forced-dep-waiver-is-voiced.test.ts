// `--force` is ONE waiver over INDEPENDENT guards, and it used to waive the
// dependency soft-block in silence.
//
// The trap is not hypothetical, and it is not reached by an operator doing
// something exotic — it is reached by following the CLI's own advice. The
// live-PR milestone gate refuses with "… or --force for an intentional
// Unassigned/Operational exception". Re-running the move WITH that flag, as
// instructed, ALSO disables this gate. Measured on the live board 2026-08-03:
// `move <slug> doing --force` printed only `moved … todo → doing`, and `show`
// immediately rendered the same card `🔒 blocked` sitting in `doing`.
//
// This project already calls that overload a hazard from the other direction:
// `kanban-stress-script.test.ts` forbids `--force` in the stress harness
// because it would also disable assertBodyReplaceSafe and assertDepUnblocked.
// Banned in the harness, recommended in the error message — these tests close
// the gap by requiring the waiver to be VOICED.
//
// Both copies of that sentence used to end "and the Situations preflight",
// which was never true — `assertSituationPreflightAllowed` takes no `force`.
// The enumeration is machine-checked in
// `forced-guard-waivers-are-voiced.test.ts` now; don't restate it here.
//
// What is deliberately NOT asserted: that `--force` stops working. It still
// overrides (pinned by dep-block-terminal-column.test.ts); it just says so.

import { describe, expect, test } from "bun:test";

import type { NodeClient, QueryFilter, QueryResponse } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardToFields, findCard, nowIso } from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: "cardhash", board: "boardhash" },
};

function seedBoard(node: NodeClient, slug: string) {
  const now = nowIso();
  return node.createRecord({
    schemaHash: cfg.schemaHashes.board!,
    keyHash: slug,
    fields: boardToFields({
      slug,
      title: slug,
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    }),
  });
}

/** Capture stderr warnings for the duration of one action. */
async function captureWarnings<T>(fn: () => Promise<T>): Promise<{ result: T; warnings: string[] }> {
  const warnings: string[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => {
    warnings.push(args.map((a) => String(a)).join(" "));
  };
  try {
    const result = await fn();
    return { result, warnings };
  } finally {
    console.error = original;
  }
}

describe("--force waives the dependency block out loud", () => {
  test("a forced move of a blocked card names the blocker it overrode", async () => {
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "dep1", title: "Dep" });
    await addCmd({ cfg, node, slug: "work", title: "Work", deps: ["dep1"] });

    const { result, warnings } = await captureWarnings(() =>
      moveCmd({ cfg, node, slug: "work", column: "doing", force: true }),
    );

    // The waiver still waives — that is the documented escape hatch.
    expect(result).toMatchObject({ to: "doing" });
    expect((await findCard(node, cfg, "work"))?.column).toBe("doing");

    // …and now says so, naming the specific dependency. Matching on the slug
    // rather than the whole sentence: the assertion is that the operator can
    // tell WHICH dep was overridden, not that the wording never changes.
    const waiver = warnings.find((w) => w.includes("--force") && w.includes("blocked"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("work");
    expect(waiver).toContain("dep1");
    expect(waiver).toContain("doing");
  });

  test("the same waiver is voiced on the `add` path, not just `move`", async () => {
    // `add` and `move` share assertDepUnblocked; a fix wired into only one of
    // them would leave `add --column doing --force` silently blocked-placing.
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "dep2", title: "Dep" });

    const { warnings } = await captureWarnings(() =>
      addCmd({ cfg, node, slug: "work2", title: "Work", column: "doing", deps: ["dep2"], force: true }),
    );

    const waiver = warnings.find((w) => w.includes("--force") && w.includes("blocked"));
    expect(waiver).toBeDefined();
    expect(waiver).toContain("dep2");
  });

  test("nothing is said when --force did not actually waive this gate", async () => {
    // Silence is correct when the card is not blocked: a forced write that had
    // no dependency to override must not imply it overrode one, or the warning
    // becomes noise and stops being read.
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "dep3", title: "Dep", column: "done" });
    await addCmd({ cfg, node, slug: "work3", title: "Work", deps: ["dep3"] });

    const { warnings } = await captureWarnings(() =>
      moveCmd({ cfg, node, slug: "work3", column: "doing", force: true }),
    );

    expect(warnings.filter((w) => w.includes("--force") && w.includes("blocked"))).toEqual([]);
  });

  test("the unforced gate still refuses, and refuses silently", async () => {
    // The warning belongs to the WAIVER. An outright refusal already carries
    // the verdict in its thrown message; printing it too would double-voice it.
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "dep4", title: "Dep" });
    await addCmd({ cfg, node, slug: "work4", title: "Work", deps: ["dep4"] });

    const warnings: string[] = [];
    const original = console.error;
    console.error = (...args: unknown[]) => warnings.push(args.map((a) => String(a)).join(" "));
    try {
      await expect(moveCmd({ cfg, node, slug: "work4", column: "doing" })).rejects.toMatchObject({
        code: "card_blocked",
      });
    } finally {
      console.error = original;
    }
    expect(warnings.filter((w) => w.includes("--force"))).toEqual([]);
    expect((await findCard(node, cfg, "work4"))?.column).toBe("backlog");
  });
});

describe("the cost of speaking, and the cost of not being able to", () => {
  test("a forced write on a DEP-FREE card pays no extra read", async () => {
    // The reads that describe the waiver are only worth paying when there is a
    // verdict to describe. `depStatus` iterates `card.deps` and nothing else, so
    // a dep-free card cannot be blocked and must short-circuit BEFORE the board
    // read — otherwise every forced write on the hot path funds a lookup whose
    // answer is knowable for free.
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "solo", title: "Solo" });

    // The board-LIST scan (no HashKey) is the read `assertDepUnblocked` adds;
    // the HashKey point-read of the card's own board is `moveCmd`'s and predates
    // this change. Counting the scan specifically is what makes this an absolute
    // claim about the gate rather than a claim about total traffic.
    const boardScans = (from: number) =>
      node.reads.slice(from).filter(
        (r) => r.schemaHash === cfg.schemaHashes.board && r.filter?.HashKey === undefined,
      ).length;

    const before = node.reads.length;
    await moveCmd({ cfg, node, slug: "solo", column: "doing", force: true });
    expect(boardScans(before)).toBe(0);

    // And the same move on a card that DOES have deps is allowed to read — the
    // 0 above must mean "short-circuited", not "this gate never reads at all",
    // which would make the assertion vacuous.
    await addCmd({ cfg, node, slug: "dep5", title: "Dep" });
    await addCmd({ cfg, node, slug: "work5", title: "Work", deps: ["dep5"] });
    const beforeDeps = node.reads.length;
    await moveCmd({ cfg, node, slug: "work5", column: "doing", force: true });
    expect(boardScans(beforeDeps)).toBeGreaterThan(0);
  });

  test("a node that cannot answer does not turn an override into a refusal", async () => {
    // `--force` is what you reach for when the node is degraded, so the lookup
    // added for REPORTING must never gate the write. If it could throw, this
    // change would have made the escape hatch fail exactly when it is needed.
    const node = fakeNode();
    await seedBoard(node, "default");
    await addCmd({ cfg, node, slug: "dep6", title: "Dep" });
    await addCmd({ cfg, node, slug: "work6", title: "Work", deps: ["dep6"] });

    // Fail ONLY the board-list scan that `assertDepUnblocked` issues, not the
    // HashKey point-read `moveCmd` already does to resolve the card's board —
    // breaking that one would prove nothing about this gate.
    const failing: NodeClient = {
      ...node,
      queryAll: (opts: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse> => {
        if (opts.schemaHash === cfg.schemaHashes.board && opts.filter?.HashKey === undefined) {
          return Promise.reject(new Error("service_timeout: node did not respond"));
        }
        return node.queryAll(opts);
      },
    };

    const { result, warnings } = await captureWarnings(() =>
      moveCmd({ cfg, node: failing, slug: "work6", column: "doing", force: true }),
    );

    expect(result).toMatchObject({ to: "doing" });
    // The operator is still told the gate went unchecked — an unreported skip
    // would be the same silence this file exists to remove.
    expect(warnings.some((w) => w.includes("--force") && w.includes("could not be read"))).toBe(true);
  });
});
