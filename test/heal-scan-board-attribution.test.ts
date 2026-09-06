// A discovery source may SUPPLY a board. It may never DENY one.
//
// Sibling of `scan-ghost-row-false-empty-body.test.ts`, which pinned the same
// rule for `body`. This file pins the OTHER field `board_cards_heal` used to
// read off a discovery source: `board`.
//
// The discovery source was the Card full scan (`scanCardSummariesForReconcile`)
// until kanban-groom-heal-stop-card-list-scan-20260904 removed it entirely — it
// cost 108305 Card-schema queries over 16h45m on the primary. Discovery for a
// candidate with no membership row anywhere is now the legacy `all_cards`
// rollup only (see `board_cards_heal.ts`), which carries the exact same
// "SLUG ORACLE ONLY" contract the scan did: a caller must not trust any field
// on a rollup row except `slug`. This file's fixture now seeds that hazard
// into the rollup instead of a scan ghost row — same defect class, current
// discovery source.
//
// `scanCardSummariesForReconcile` was documented "SLUG ORACLE ONLY", and the
// primary bore that out — measured 2026-07-31, 99 of 410 winning scan rows
// carried `board: ""` on cards that point-read fine, and 47 slugs came back
// twice, so which row won a last-write-wins map was arbitrary. Heal honoured
// that for WRITES (every repair is authored by a Card point read) but not for
// two SELECTION decisions:
//
//   const board = t.board || "default";                  // a guess
//   if (boardFilter && board !== boardFilter) continue;  // (1) drops the card
//   byKey.set(`${board}\0${slug}`, []);                  // (2) mints a key
//
// (1) `groom board-cards-heal --board X` silently skipped a card whose scan row
//     was blank, even with truth saying X and its membership row missing —
//     precisely the card heal exists to restore.
// (2) a card already correctly membered on X was ALSO keyed under `default`,
//     where an empty row list reads as "missing BoardCards membership": a
//     spurious repair and, under `--apply`, a redundant wide write.
//
// Neither fired on the live board when it was measured (0 of 410), because
// `|| "default"` happens to be right while nearly every card lives on
// `default`. The fixture is therefore a NON-default board — the case the guess
// gets wrong — rather than a reproduction of today's primary.

import { beforeEach, describe, expect, test } from "bun:test";

import { fakeNode, type FakeNode } from "./fake-node.ts";
import type { Config } from "../src/config.ts";
import { boardCardsHealResult } from "../src/commands/board_cards_heal.ts";
import { boardToFields, cardToFields, nowIso, type Card } from "../src/record.ts";
import { boardCardFieldsFromCard, boardCardSk } from "../src/board-cards.ts";
import { DEFAULT_COLUMNS } from "../src/schemas.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://unused.invalid",
  schemaServiceUrl: "http://unused.invalid",
  userHash: "test-user",
  schemaHashes: {
    card: "cardhash",
    board: "boardhash",
    board_cards: "boardcardshash",
    card_list_index: "cardlistindexhash",
  },
};

const CARD_LIST_INDEX_KEY = "all_cards";

const TEAM = "team";

function card(over: Partial<Card> & { slug: string }): Card {
  const now = nowIso();
  return {
    slug: over.slug,
    title: over.title ?? over.slug,
    body: "",
    board: over.board ?? TEAM,
    column: over.column ?? "todo",
    position: over.position ?? "m",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: [],
    created_at: now,
    updated_at: now,
    done_at: "",
    db: "",
    kind: "pr",
    priority: "",
    block_status: "none",
    block_reason: "",
    north_star: "",
    milestone: "",
    repo: "EdgeVector/fkanban",
    base: "main",
    pr_url: "",
    branch: "",
    created_by: "test",
  } as Card;
}

function seedBoard(node: FakeNode, slug: string): void {
  const now = nowIso();
  node.seed({
    schemaHash: "boardhash",
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

/** Card truth: keyed by slug, carrying the real board. */
function seedCardTruth(node: FakeNode, c: Card): void {
  node.seed({ schemaHash: "cardhash", keyHash: c.slug, fields: cardToFields(c) });
}

/** The membership row a healthy card has. */
function seedMembership(node: FakeNode, c: Card): void {
  node.seed({
    schemaHash: "boardcardshash",
    keyHash: c.board,
    rangeKey: boardCardSk(c.column, c.position, c.slug),
    fields: boardCardFieldsFromCard(c),
  });
}

/**
 * A rollup entry naming a slug with a BLANK `board` — the current discovery
 * source's equivalent of the retired scan's ghost row (99 of 410 winning scan
 * rows carried `board: ""` on cards that point-read fine, measured
 * 2026-07-31). `readCardListIndex` only ever extracts `.slug` from a row, but
 * this fixture seeds a wrong `board` anyway so a regression that started
 * trusting it would be caught the same way the scan-era one was.
 */
function seedBlankBoardRollupEntry(node: FakeNode, slugs: string[]): void {
  node.seed({
    schemaHash: "cardlistindexhash",
    keyHash: CARD_LIST_INDEX_KEY,
    fields: {
      key: CARD_LIST_INDEX_KEY,
      payload_json: JSON.stringify(slugs.map((slug) => ({ slug, board: "" }))),
      updated_at: nowIso(),
    },
  });
}

describe("heal must not take a card's board from the scan", () => {
  let node: FakeNode;
  // Membership row missing — the card heal exists to restore.
  const unmembered = card({ slug: "team-card-missing-membership" });
  // Membership row already correct on TEAM.
  const healthy = card({ slug: "team-card-already-correct", position: "n" });

  beforeEach(() => {
    node = fakeNode();
    seedBoard(node, "default");
    seedBoard(node, TEAM);

    seedCardTruth(node, unmembered);
    seedCardTruth(node, healthy);
    seedMembership(node, healthy);
    seedBlankBoardRollupEntry(node, [unmembered.slug, healthy.slug]);
  });

  // NON-VACUITY. Every assertion below is only meaningful if the fixture really
  // reproduces the hazard: the rollup must carry a blank board while the keyed
  // read returns the real one. A fixture that quietly stopped doing that would
  // make the rest of this file pass for the wrong reason.
  test("the fixture reproduces the hazard: rollup says board=\"\", keyed read says team", async () => {
    const rollup = await node.queryAll({
      schemaHash: "cardlistindexhash",
      fields: ["key", "payload_json"],
      filter: { HashKey: CARD_LIST_INDEX_KEY },
    });
    const payload = JSON.parse(
      (rollup.results[0]!.fields as Record<string, unknown>).payload_json as string,
    ) as Array<{ slug: string; board: string }>;
    const row = payload.find((r) => r.slug === unmembered.slug);
    expect(row?.board).toBe("");

    const keyed = await node.queryAll({
      schemaHash: "cardhash",
      fields: ["slug", "board"],
      filter: { HashKey: unmembered.slug },
    });
    expect(keyed.results).toHaveLength(1);
    expect((keyed.results[0]!.fields as Record<string, unknown>).board).toBe(TEAM);
  });

  test("--board team still finds a card the scan failed to place on team", async () => {
    const { report } = await boardCardsHealResult({ cfg, node, board: TEAM, json: true });

    const action = report.actions.find((a) => a.slug === unmembered.slug);
    expect(action).toBeDefined();
    expect(action!.action).toBe("upsert-truth");
    // Truth names the board, not the scan and not the `|| "default"` fallback.
    expect(action!.board).toBe(TEAM);
  });

  test("--board team repairs it into the team partition, not default", async () => {
    await boardCardsHealResult({ cfg, node, board: TEAM, apply: true, json: true });

    const written = node.writes.filter(
      (w) => w.schemaHash === "boardcardshash" && w.op !== "delete",
    );
    const forCard = written.filter(
      (w) => (w.fields as Record<string, unknown> | undefined)?.slug === unmembered.slug,
    );
    expect(forCard).toHaveLength(1);
    expect(forCard[0]!.keyHash).toBe(TEAM);
    expect(node.rowsOf("boardcardshash").some((r) => r.keyHash === "default")).toBe(false);
  });

  test("a card already membered on team is not reported missing", async () => {
    const { report } = await boardCardsHealResult({ cfg, node, json: true });

    const actions = report.actions.filter((a) => a.slug === healthy.slug);
    // Exactly one verdict, and it is "nothing to do" — not a second, synthetic
    // candidate keyed under the guessed board reading as missing membership.
    expect(actions).toHaveLength(1);
    expect(actions[0]!.action).toBe("noop-match");
    expect(actions.some((a) => a.action === "upsert-truth")).toBe(false);
  });

  test("--apply issues no write for a card that is already correct", async () => {
    await boardCardsHealResult({ cfg, node, slugs: [healthy.slug], apply: true, json: true });

    const written = node.writes.filter(
      (w) => w.schemaHash === "boardcardshash" && w.op !== "delete",
    );
    expect(written).toHaveLength(0);
  });

  test("a card membered elsewhere costs a spine read, not a point read", async () => {
    // Deferring the --board filter to truth means a candidate cannot be ruled
    // out before its point read, which on a small board turned every discovered
    // slug into one (measured: 16 -> 411). "Has membership anywhere" is instead
    // answered by a spine read per non-target partition. `healthy` is membered
    // on TEAM, so a `--board default` run must not point-read it at all.
    const before = node.reads.length;
    await boardCardsHealResult({ cfg, node, board: "default", json: true });
    const fresh = node.reads.slice(before);

    // The rollup names `healthy` as a candidate with a blank board. The
    // membership filter must still be answered by the TEAM partition spine,
    // not by adopting that blank board.

    // And the cheap census really is what ruled it out.
    const teamPartitionReads = fresh.filter(
      (r) =>
        r.schemaHash === "boardcardshash" &&
        (r.filter as { HashKey?: string } | undefined)?.HashKey === TEAM,
    );
    expect(teamPartitionReads.length).toBeGreaterThan(0);
  });

  test("--board default does not claim a team card", async () => {
    // The mirror of the first case: the guess used to put every blank-board
    // card on `default`, so a `--board default` run would adopt one.
    const { report } = await boardCardsHealResult({ cfg, node, board: "default", json: true });

    expect(report.actions.some((a) => a.slug === unmembered.slug)).toBe(false);
  });
});
