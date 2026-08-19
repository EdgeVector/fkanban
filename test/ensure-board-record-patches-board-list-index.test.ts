// `ensureBoardRecord` heals a missing Board record from live cards that still
// point at it. Until this test, it wrote the PRIMARY record and never patched
// the `all_boards` secondary — every other Board write in the repo does
// (`boardCreateCmd` on both branches, `board rm` on removal).
//
// That is a PERMANENT dual-write hole, not a lag. `listBoards` trusts
// `all_boards` whenever the row is readable and re-seeds only when it is
// absent, so a Board record missing from the rollup is invisible to
// `list`/`pickup`/`overlap`/the milestone portfolio while `show <slug>` keeps
// working — verbatim the blast radius `patchBoardListIndex`'s own docstring
// warns about.
//
// Reached from four ordinary commands: `move` (x2), `add`, `rm`, `milestone add`.
//
// WHY THE EXISTING SUITE CANNOT SEE IT: `test/default-board-self-heal.test.ts`
// exercises this exact branch, but its `cfg.schemaHashes` binds only `card` and
// `board`. With `card_list_index` unbound `patchBoardListIndex` returns on its
// first line, so that fixture is structurally incapable of observing a missing
// patch. Every cfg here binds the hash.

import { describe, expect, test } from "bun:test";

import type { NodeClient } from "../src/client.ts";
import { FkanbanError } from "../src/client.ts";
import { fakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { addCmd } from "../src/commands/add.ts";
import { moveCmd } from "../src/commands/move.ts";
import { rmCmd } from "../src/commands/rm.ts";
import { BOARD_LIST_INDEX_KEY, type BoardSummary } from "../src/card-list-index.ts";
import {
  boardToFields,
  cardToFields,
  emptyStructuredFields,
  ensureBoardRecord,
  findBoard,
  findCard,
  listBoards,
  nowIso,
  toBoardSummary,
  type Board,
  type Card,
} from "../src/record.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const CARD = "cardhash";
const BOARD = "boardhash";
const INDEX = "cardlistindexhash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: { card: CARD, board: BOARD, card_list_index: INDEX },
};

function board(partial: Partial<Board>): Board {
  return {
    slug: "default",
    title: "Default board",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

function card(partial: Partial<Card>): Card {
  const now = nowIso();
  return {
    slug: "existing",
    title: "Existing",
    body: "",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: now,
    updated_at: now,
    ...partial,
  };
}

function seedCard(node: NodeClient, c: Card) {
  return node.createRecord({ schemaHash: CARD, keyHash: c.slug, fields: cardToFields(c) });
}

function seedBoard(node: NodeClient, b: Board) {
  return node.createRecord({ schemaHash: BOARD, keyHash: b.slug, fields: boardToFields(b) });
}

function seedIndex(node: NodeClient, entries: BoardSummary[]) {
  return node.createRecord({
    schemaHash: INDEX,
    keyHash: BOARD_LIST_INDEX_KEY,
    fields: {
      key: BOARD_LIST_INDEX_KEY,
      payload_json: JSON.stringify(entries),
      updated_at: nowIso(),
    },
  });
}

/**
 * The world a heal walks into: `default` is intact and listed, `scratch` has
 * live cards but its Board record and its rollup entry are both gone — the state
 * `board rm` leaves behind when cards still carry the removed board's slug.
 */
async function worldWithOrphanedScratch(opts: { indexReadable?: boolean } = {}) {
  const node = fakeNode();
  const defaultBoard = board({});
  await seedBoard(node, defaultBoard);
  if (opts.indexReadable === false) {
    await seedUnreadableIndex(node);
    failIndexWrites(node);
  } else {
    await seedIndex(node, [toBoardSummary(defaultBoard)]);
  }
  await seedCard(node, card({ slug: "kept", board: "default", column: "todo" }));
  await seedCard(node, card({ slug: "orphan", board: "scratch", column: "todo" }));
  return node;
}

async function listedSlugs(node: NodeClient): Promise<string[]> {
  return (await listBoards(node, cfg)).map((b) => b.slug).sort();
}

/**
 * An `all_boards` row whose `payload_json` has no atom: ABSENT to the
 * `["payload_json"]` payload read, PRESENT to the `["key"]` existence probe.
 * Seeded rather than mutated because `updateRecord` MERGES — an atom cannot be
 * taken back off a row that has one.
 *
 * MEASURED, and worth knowing before reaching for this: on the
 * `ensureBoardRecord` path a read refusal alone does NOT reach
 * `patchBoardListIndex`. The `listCardStatuses` call that proves the board is
 * referenced runs first and goes through `listBoards`, which treats an
 * unreadable rollup as "not seeded yet" and cold-seeds it from HashKey(default) — so
 * by the time the patch reads the row, the row is readable and the patch
 * succeeds. Three index writes, not one (probed 2026-08-06). Pair this with
 * {@link failIndexWrites} to model a node that is actually shedding.
 */
function seedUnreadableIndex(node: NodeClient) {
  return node.createRecord({
    schemaHash: INDEX,
    keyHash: BOARD_LIST_INDEX_KEY,
    fields: { key: BOARD_LIST_INDEX_KEY, updated_at: nowIso() },
  });
}

/**
 * A node shedding writes to the `all_boards` ROW — the reachable way
 * `patchBoardListIndex` fails from a heal, given the self-repair above. The
 * cold-seed rebuild is best-effort and swallows its failure, so the row stays
 * unreadable and the patch then refuses with `index_unreadable`.
 *
 * Scoped to the one key, not the whole CardListIndex schema: `all_cards` shares
 * that schema, and `patchCardListIndex` — a different rollup on the ordinary
 * card write path — propagates its write failures out of `updateCardRecord` by
 * design. Shedding the schema would fail `move` for that reason instead of the
 * one under test, and the assertion would read as a pass/fail about
 * `ensureBoardRecord` while measuring something else entirely.
 *
 * Reads are left alone: backpressure on one row's writes, not a dead node.
 */
function failIndexWrites(node: NodeClient) {
  const shed = () => {
    throw new FkanbanError({ code: "service_timeout", message: "node did not respond within 30000ms" });
  };
  const sheds = (req: { schemaHash: string; keyHash?: string }) =>
    req.schemaHash === INDEX && req.keyHash === BOARD_LIST_INDEX_KEY;
  const create = node.createRecord.bind(node);
  const update = node.updateRecord.bind(node);
  node.createRecord = async (req) => (sheds(req) ? shed() : create(req));
  node.updateRecord = async (req) => (sheds(req) ? shed() : update(req));
}

describe("ensureBoardRecord patches all_boards, not just the Board record", () => {
  test("move onto a healed board makes it visible to listBoards", async () => {
    const node = await worldWithOrphanedScratch();

    const res = await moveCmd({ cfg, node, slug: "orphan", column: "doing", allowUnclaimed: true });

    expect(res).toMatchObject({ slug: "orphan", to: "doing" });
    // Primary record: healed before this fix too.
    expect((await findBoard(node, cfg, "scratch"))?.columns).toEqual([...DEFAULT_COLUMNS]);
    // Secondary: the hole. `show scratch` worked; `list` could not see it.
    expect(await listedSlugs(node)).toEqual(["default", "scratch"]);
  });

  test("add onto a healed board makes it visible to listBoards", async () => {
    const node = await worldWithOrphanedScratch();

    await addCmd({ cfg, node, slug: "new-card", title: "New card", board: "scratch" });

    expect(await listedSlugs(node)).toEqual(["default", "scratch"]);
  });

  /**
   * `rm` reaches the heal only through its completion-checkpoint branch, which
   * needs the card's board columns — so the card has to be `done` on a
   * non-default board (a `done` card on `default` takes a shortcut that skips
   * the read entirely). Placing it in `todo`, as the other cases here do, leaves
   * `ensureBoardRecord` uncalled and the test vacuous.
   */
  test("rm on a done card whose board vanished also restores the rollup entry", async () => {
    const node = await worldWithOrphanedScratch();
    await seedCard(node, card({ slug: "finished", board: "scratch", column: "done" }));

    await rmCmd({ cfg, node, slug: "finished" });

    expect(await listedSlugs(node)).toEqual(["default", "scratch"]);
  });

  /**
   * DIRECTION CONTROL — the load-bearing test in this file.
   *
   * Every assertion above is also satisfied by a build that REPLACES `all_boards`
   * with `[scratch]` instead of patching it, which would be a strictly worse bug
   * than the one being fixed: it makes every card on every OTHER board invisible
   * to `list`. `["default", "scratch"]` (not `toContain("scratch")`) is what
   * makes those assertions mean anything, and this test says so out loud with a
   * board that has no cards and therefore no other reason to survive a rewrite.
   */
  test("healing one board does not drop the boards already in the rollup", async () => {
    const node = fakeNode();
    const archive = board({ slug: "archive", title: "Archive" });
    await seedBoard(node, archive);
    await seedIndex(node, [toBoardSummary(archive)]);
    await seedCard(node, card({ slug: "orphan", board: "scratch", column: "todo" }));

    await moveCmd({ cfg, node, slug: "orphan", column: "doing", allowUnclaimed: true });

    expect(await listedSlugs(node)).toEqual(["archive", "scratch"]);
  });

  /**
   * REPORT, NEVER REFUSE — the rule this repo settled in
   * `test/milestone-reconcile-index-read-failure.test.ts`.
   *
   * The rollup patch can legitimately fail: `patchBoardListIndex` throws
   * `index_unreadable` when the row is present but its payload does not come
   * back (an ordinary shed), and `cas_conflict` after four losing retries. In
   * `boardCreateCmd` letting that propagate is right — the user asked for a
   * board and an unlisted board is not one.
   *
   * Here it is not. The caller asked to MOVE A CARD; the heal is a side effect,
   * and the card write has already landed by the time a `move` would rethrow.
   * Failing the command would leave the user's move unapplied while the Board
   * record it created stays, and the retry hits the same shed. So the command
   * completes and the unrepaired rollup is REPORTED — with the exact repair
   * command — instead of silently leaving the board invisible.
   *
   * See {@link seedUnreadableIndex}: an unreadable row on its own is not enough
   * to get here, because this path repairs it on the way in.
   */
  test("a refused rollup patch is reported, and does not fail the heal", async () => {
    const node = await worldWithOrphanedScratch({ indexReadable: false });

    const warnings: string[] = [];
    const healed = await ensureBoardRecord(node, cfg, "scratch", {
      warn: (m) => warnings.push(m),
    });

    // The Board record — the part that CAN be written — was written.
    expect(healed.slug).toBe("scratch");
    expect((await findBoard(node, cfg, "scratch"))?.columns).toEqual([...DEFAULT_COLUMNS]);
    // ...and the part that was refused is named, with the command that repairs it.
    const text = warnings.join("\n");
    expect(text).toContain("scratch");
    expect(text).toContain("all_boards");
    expect(text).toContain("board-list-heal");
  });

  /**
   * CONTROL for the test above, at the layer that matters to callers.
   *
   * `ensureBoardRecord` is reached from `move`/`add`/`rm`/`milestone add`, none
   * of which pass a warn sink today. Asserting only on the direct seam would
   * leave a build that rethrows from the default path entirely green here while
   * breaking every real write on a board mid-heal during an ordinary shed. So
   * this one goes through `moveCmd`, with no sink, and pins that the operator's
   * write still lands.
   */
  test("a refused rollup patch does not fail the caller's write", async () => {
    const node = await worldWithOrphanedScratch({ indexReadable: false });

    const res = await moveCmd({
      cfg,
      node,
      slug: "orphan",
      column: "doing",
      allowUnclaimed: true,
    }).catch((e: unknown) => e);

    expect(res).not.toBeInstanceOf(FkanbanError);
    expect(res).toMatchObject({ slug: "orphan", to: "doing" });
    expect((await findCard(node, cfg, "orphan"))?.column).toBe("doing");
  });
});
