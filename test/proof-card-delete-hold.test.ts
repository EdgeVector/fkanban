/**
 * A milestone's proof card is EVIDENCE, and neither deletion path knew it.
 *
 * `proofGate` refuses to enter `proving`/`complete` unless the proof card
 * exists, belongs to the milestone, has `kind=validation`, sits in its terminal
 * column, and carries a machine-readable `PROOF: PASS`. So the reference was
 * fully guarded on the WRITE side and completely unguarded on the DELETE side:
 *
 *   rm <slug>            refused a live DEPENDENCY, and only that
 *   groom archive-done   held back a live DEPENDENCY, and only that
 *
 * Either one could delete the card behind a `proof_status=passing` claim,
 * leaving a milestone that reads complete next to a computed blocker saying its
 * proof is gone — the live shape of
 * [[papercut-kanban-milestone-proof-passing-with-no-proof-card]].
 *
 * The dependency hold did NOT cover this incidentally: measured on the primary
 * 2026-08-03, 0 of the 2 surviving proof cards were also a dep, so `rm` would
 * have deleted both without a word.
 */
import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { archiveDoneResult } from "../src/commands/archive_done.ts";
import { proofCardRefsFrom, proofHoldReason, readProofCardRefs } from "../src/proof_card_refs.ts";
import type { Board, Card, Milestone } from "../src/record.ts";

const cfg = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {},
} as Config;

const node = {} as NodeClient;
const NOW = Date.parse("2026-08-03T06:00:00.000Z");
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
  } as Card;
}

const milestone = (partial: Partial<Milestone> & { slug: string }): Milestone =>
  ({
    title: partial.slug,
    body: "",
    board: "default",
    state: "active",
    position: "10",
    north_star: "",
    driver: "last-stack-milestone-driver",
    deps: [],
    proof_card: "",
    proof_status: "pending",
    block_reason: "",
    created_at: "",
    updated_at: "",
    completed_at: "",
    ...partial,
  }) as Milestone;

const board = (slug: string): Board =>
  ({
    slug,
    title: slug,
    body: "",
    columns: ["backlog", "todo", "doing", "done"],
    created_at: "",
    updated_at: "",
  }) as Board;

function fixture(cards: Card[], milestones: Milestone[]) {
  const removed: string[] = [];
  return {
    removed,
    opts: {
      cfg,
      node,
      now: NOW,
      boardsFor: async () => [board("default")],
      cardsIn: async (_n: NodeClient, _c: Config, column: string) =>
        column === "done" ? cards : [],
      remove: async (_o: unknown, c: Card) => {
        removed.push(c.slug);
      },
      milestonesFor: async () => milestones,
    },
  };
}

describe("proofCardRefsFrom", () => {
  test("indexes cards by the milestones claiming them, ignoring blanks", () => {
    const refs = proofCardRefsFrom([
      milestone({ slug: "m1", proof_card: "proof-a" }),
      milestone({ slug: "m2", proof_card: "proof-a" }),
      milestone({ slug: "m3", proof_card: "" }),
      milestone({ slug: "m4", proof_card: "   " }),
    ]);
    expect(refs.get("proof-a")).toEqual(["m1", "m2"]);
    expect(refs.size).toBe(1);
    expect(proofHoldReason(refs, "proof-a")).toContain("2 milestones");
    expect(proofHoldReason(refs, "unrelated")).toBeNull();
  });
});

describe("readProofCardRefs distinguishes 'no milestones' from 'cannot tell'", () => {
  test("an unregistered milestone schema means no references, not an error", async () => {
    // A config predating milestones has no milestone subsystem, so nothing can
    // be claiming a proof card. `rm` must keep working there rather than
    // hard-failing on a schema it never needed.
    const refs = await readProofCardRefs({} as NodeClient, { schemaHashes: {} } as Config);
    expect(refs.size).toBe(0);
  });

  test("a FAILED milestone read propagates — the guard fails closed", async () => {
    // The opposite case, and the one that must never be collapsed into the
    // above: if the references cannot be read, the delete must be refused, not
    // permitted. Catching this and returning an empty map would turn routine
    // node backpressure into silent evidence loss.
    const exploding = {
      async queryAll() {
        throw new Error("service_timeout");
      },
    } as unknown as NodeClient;
    const err = await readProofCardRefs(exploding, {
      schemaHashes: { milestone: "milestonehash", board: "boardhash" },
    } as unknown as Config).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toContain("service_timeout");
  });
});

describe("groom archive-done holds proof cards back", () => {
  test("a proof card past the cutoff is skipped, not archived", async () => {
    const f = fixture(
      [card({ slug: "the-proof", updated_at: hoursAgo(100) }), card({ slug: "ordinary", updated_at: hoursAgo(100) })],
      [milestone({ slug: "m1", proof_card: "the-proof" })],
    );
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });

    expect(f.removed).toEqual(["ordinary"]);
    expect(report.skipped_proof_card).toBe(1);
    expect(report.archived).toBe(1);
    const held = report.actions.find((a) => a.slug === "the-proof");
    expect(held?.action).toBe("skipped-proof-card");
    expect(held?.reason).toContain("m1");
  });

  test("the hold is reported in the summary line, so a sweep cannot hide it", async () => {
    const f = fixture(
      [card({ slug: "the-proof", updated_at: hoursAgo(100) })],
      [milestone({ slug: "m1", proof_card: "the-proof" })],
    );
    const { text } = await archiveDoneResult({ ...f.opts, apply: true });
    expect(text).toContain("skipped_proof_card=1");
    expect(text).toContain("skipped-proof-card");
  });

  test("a dry run previews the hold rather than promising the archive", async () => {
    const f = fixture(
      [card({ slug: "the-proof", updated_at: hoursAgo(100) })],
      [milestone({ slug: "m1", proof_card: "the-proof" })],
    );
    const { report } = await archiveDoneResult(f.opts);
    expect(report.actions.map((a) => a.action)).toEqual(["skipped-proof-card"]);
    expect(f.removed).toEqual([]);
  });

  /**
   * THE DESIGN LOCK — state is deliberately NOT consulted.
   *
   * The reflex is to mirror the dependency hold, which only counts cards in
   * non-terminal columns because a finished card's dep no longer blocks
   * anything. Applying that reflex here inverts the rule and re-opens the hole:
   * a dep matters while work is UNFINISHED, but a proof matters BECAUSE the work
   * finished. A `complete` milestone's proof card is the basis of its completion
   * claim, so it must survive longest — not become collectable first.
   *
   * This fails if anyone filters the hold by milestone state.
   */
  test("a COMPLETE milestone's proof card is held — the case a state filter would drop", async () => {
    const f = fixture(
      [card({ slug: "the-proof", updated_at: hoursAgo(900) })],
      [milestone({ slug: "m1", state: "complete", proof_status: "passing", proof_card: "the-proof" })],
    );
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });
    expect(f.removed).toEqual([]);
    expect(report.skipped_proof_card).toBe(1);
  });

  test("an ABANDONED milestone's proof card is held too", async () => {
    const f = fixture(
      [card({ slug: "the-proof", updated_at: hoursAgo(900) })],
      [milestone({ slug: "m1", state: "abandoned", proof_card: "the-proof" })],
    );
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });
    expect(f.removed).toEqual([]);
    expect(report.skipped_proof_card).toBe(1);
  });

  test("cards no milestone claims are archived exactly as before", async () => {
    const f = fixture(
      [card({ slug: "a", updated_at: hoursAgo(100) }), card({ slug: "b", updated_at: hoursAgo(100) })],
      [milestone({ slug: "m1", proof_card: "some-other-card" })],
    );
    const { report } = await archiveDoneResult({ ...f.opts, apply: true });
    expect(f.removed.sort()).toEqual(["a", "b"]);
    expect(report.skipped_proof_card).toBe(0);
  });
});
