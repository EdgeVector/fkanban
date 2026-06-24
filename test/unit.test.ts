// Pure-logic unit tests — no node / schema-service required.

import { describe, expect, test } from "bun:test";

import {
  DEFAULT_COLUMNS,
  cardSchema,
  boardSchema,
  isRecordType,
  isDefaultColumn,
  namespacedSchemaName,
} from "../src/schemas.ts";
import {
  appendPosition,
  ensureColumn,
  isTombstoned,
  sortCards,
  validateSlug,
  rowToCard,
  cardToFields,
  normalizeDeps,
  normalizeTags,
  depStatus,
  blockedSlugSet,
  boardTerminalMap,
  wouldCreateCycle,
  cardMatchesQuery,
  queryTerms,
  searchCards,
  depTag,
  isWorkingColumn,
  orphanedDependentsWarning,
  TOMBSTONE_TAG,
  DEP_TAG_PREFIX,
  emptyStructuredFields,
  type Card,
} from "../src/record.ts";
import { FkanbanError, type NodeClient, type QueryResponse, type QueryRow } from "../src/client.ts";
import { listCmd, otherBoardsFooter, type ListOptions } from "../src/commands/list.ts";
import { type Config } from "../src/config.ts";
import {
  formatAdd,
  formatMove,
  formatDep,
  formatTag,
  formatRm,
  formatBoardCreate,
  formatError,
} from "../src/format.ts";
import { renderBoard, renderSearchResults } from "../src/board.ts";
import { doctor } from "../src/commands/doctor.ts";
import { mcpAddCommand, mcpEntrypointPath } from "../src/mcp/register.ts";
import { TOP_HELP, COMMAND_HELP, resolveHelp, suggestFlag } from "../src/cli.ts";
import { levenshtein, suggestClosest } from "../src/suggest.ts";

function card(partial: Partial<Card>): Card {
  return {
    slug: "c",
    title: "C",
    body: "",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    ...emptyStructuredFields(),
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...partial,
  };
}

describe("schemas", () => {
  test("two record types are recognised", () => {
    expect(isRecordType("card")).toBe(true);
    expect(isRecordType("board")).toBe(true);
    expect(isRecordType("design")).toBe(false);
  });

  test("schemas declare the fkanban app owner", () => {
    expect(cardSchema.schema.owner_app_id).toBe("fkanban");
    expect(boardSchema.schema.owner_app_id).toBe("fkanban");
    expect(namespacedSchemaName("Card")).toBe("fkanban/Card");
  });

  test("card key is its slug", () => {
    expect(cardSchema.schema.key.hash_field).toBe("slug");
  });

  test("default columns are the kanban lifecycle", () => {
    expect([...DEFAULT_COLUMNS]).toEqual(["backlog", "todo", "doing", "review", "done"]);
    expect(isDefaultColumn("doing")).toBe(true);
    expect(isDefaultColumn("nope")).toBe(false);
  });
});

describe("slug validation", () => {
  test("accepts a clean slug", () => {
    expect(() => validateSlug("ship-login_2")).not.toThrow();
  });
  test("rejects uppercase / spaces / empty", () => {
    for (const bad of ["", "Ship", "a b", "-lead"]) {
      expect(() => validateSlug(bad)).toThrow(FkanbanError);
    }
  });
});

describe("column validation", () => {
  test("falls back to default columns when board lists none", () => {
    expect(() => ensureColumn("doing", [])).not.toThrow();
    expect(() => ensureColumn("nonsense", [])).toThrow(FkanbanError);
  });
  test("honours a board's custom columns", () => {
    expect(() => ensureColumn("qa", ["dev", "qa", "ship"])).not.toThrow();
    expect(() => ensureColumn("doing", ["dev", "qa", "ship"])).toThrow(FkanbanError);
  });
});

describe("ordering + tombstones", () => {
  test("sorts by numeric position then created_at", () => {
    const cards = [
      card({ slug: "c", position: "20" }),
      card({ slug: "a", position: "10" }),
      card({ slug: "b", position: "10", created_at: "2026-01-02T00:00:00.000Z" }),
    ];
    expect(sortCards(cards).map((c) => c.slug)).toEqual(["a", "b", "c"]);
  });
  test("tombstone tag is detected", () => {
    expect(isTombstoned([TOMBSTONE_TAG])).toBe(true);
    expect(isTombstoned(["auth"])).toBe(false);
  });
  test("appendPosition sorts after legacy hand-numbered positions", () => {
    const cards = [
      card({ slug: "new", position: appendPosition() }),
      card({ slug: "old-a", position: "10" }),
      card({ slug: "old-b", position: "20" }),
    ];
    expect(sortCards(cards).map((c) => c.slug)).toEqual(["old-a", "old-b", "new"]);
  });
});

describe("row → card", () => {
  test("coerces fields and parses comma-string tags", () => {
    const c = rowToCard({
      key: { hash: "ship", range: null },
      fields: { slug: "ship", title: "Ship", column: "doing", tags: "auth, p1" },
    });
    expect(c.slug).toBe("ship");
    expect(c.column).toBe("doing");
    expect(c.tags).toEqual(["auth", "p1"]);
  });
});

describe("dependencies", () => {
  test("dep tags split out of tags into deps on read", () => {
    const c = rowToCard({
      key: { hash: "x", range: null },
      fields: { slug: "x", tags: ["p1", depTag("a"), depTag("b"), TOMBSTONE_TAG] },
    });
    expect(c.deps).toEqual(["a", "b"]);
    expect(c.tags).toEqual(["p1", TOMBSTONE_TAG]); // tombstone stays, dep tags removed
  });

  test("cardToFields folds deps back into tags (round-trips)", () => {
    const c = card({ slug: "x", tags: ["p1"], deps: ["a", "b"] });
    const fields = cardToFields(c);
    expect(fields.tags).toEqual(["p1", depTag("a"), depTag("b")]);
    const back = rowToCard({ key: { hash: "x", range: null }, fields });
    expect(back.tags).toEqual(["p1"]);
    expect(back.deps).toEqual(["a", "b"]);
  });

  test("DEP_TAG_PREFIX is the reserved prefix", () => {
    expect(depTag("foo")).toBe(`${DEP_TAG_PREFIX}foo`);
  });

  test("normalizeDeps drops blanks, self, and dupes (order-stable)", () => {
    expect(normalizeDeps([" a ", "self", "a", "", "b"], "self")).toEqual(["a", "b"]);
  });

  test("normalizeTags trims, drops blanks, and dedupes (order-stable)", () => {
    expect(normalizeTags([" p1 ", "p1", "", "blocked", "p1"])).toEqual(["p1", "blocked"]);
  });

  test("a card is blocked until every dep reaches done", () => {
    const all = [
      card({ slug: "a", column: "doing" }),
      card({ slug: "b", column: "done" }),
      card({ slug: "x", column: "todo", deps: ["a", "b"] }),
    ];
    const x = all.find((c) => c.slug === "x")!;
    const s = depStatus(x, all);
    expect(s.blocked).toBe(true);
    expect(s.blockedBy).toEqual(["a"]); // b is done, so only a blocks
    expect(s.missing).toEqual([]);
  });

  test("unblocked once all deps are done", () => {
    const all = [
      card({ slug: "a", column: "done" }),
      card({ slug: "x", column: "todo", deps: ["a"] }),
    ];
    const s = depStatus(all[1]!, all);
    expect(s.blocked).toBe(false);
    expect(blockedSlugSet(all, all).has("x")).toBe(false);
  });

  test("a missing dep is surfaced but does not block", () => {
    const x = card({ slug: "x", deps: ["ghost"] });
    const s = depStatus(x, [x]);
    expect(s.missing).toEqual(["ghost"]);
    expect(s.blocked).toBe(false);
  });

  // --- dep done-ness uses the dep board's TERMINAL column, not literal "done" ---

  test("boardTerminalMap maps each board slug to its last column", () => {
    const m = boardTerminalMap([
      { slug: "zz", title: "Z", body: "", columns: ["spec", "build", "ship"], created_at: "", updated_at: "" },
      { slug: "default", title: "D", body: "", columns: [...DEFAULT_COLUMNS], created_at: "", updated_at: "" },
      // A degenerate empty-columns board contributes no entry (falls back to "done").
      { slug: "empty", title: "E", body: "", columns: [], created_at: "", updated_at: "" },
    ]);
    expect(m.get("zz")).toBe("ship");
    expect(m.get("default")).toBe("done");
    expect(m.has("empty")).toBe(false);
  });

  test("custom-board dep is satisfied once it reaches that board's terminal column", () => {
    const terminal = boardTerminalMap([
      { slug: "zz", title: "Z", body: "", columns: ["spec", "build", "ship"], created_at: "", updated_at: "" },
    ]);
    // c1 is in `ship`, the LAST column of board zz — as done as that board allows.
    const c1 = card({ slug: "c1", board: "zz", column: "ship" });
    const c2 = card({ slug: "c2", board: "zz", column: "spec", deps: ["c1"] });
    const all = [c1, c2];
    expect(depStatus(c2, all, terminal).blocked).toBe(false);
    expect(blockedSlugSet([c2], all, terminal).has("c2")).toBe(false);
  });

  test("custom-board dep in a NON-terminal column still blocks", () => {
    const terminal = boardTerminalMap([
      { slug: "zz", title: "Z", body: "", columns: ["spec", "build", "ship"], created_at: "", updated_at: "" },
    ]);
    // c1 is in `build`, not the last column — so c2 is still blocked.
    const c1 = card({ slug: "c1", board: "zz", column: "build" });
    const c2 = card({ slug: "c2", board: "zz", column: "spec", deps: ["c1"] });
    const s = depStatus(c2, [c1, c2], terminal);
    expect(s.blocked).toBe(true);
    expect(s.blockedBy).toEqual(["c1"]);
  });

  test("default board: dep done-ness unchanged (terminal column is `done`)", () => {
    const terminal = boardTerminalMap([
      { slug: "default", title: "D", body: "", columns: [...DEFAULT_COLUMNS], created_at: "", updated_at: "" },
    ]);
    // Identical to the legacy behavior: `review` does NOT satisfy; `done` does.
    const inReview = card({ slug: "a", column: "review" });
    const inDone = card({ slug: "b", column: "done" });
    const x = card({ slug: "x", column: "todo", deps: ["a", "b"] });
    const all = [inReview, inDone, x];
    // With the map AND without it (omitted → falls back to "done") behaves identically.
    expect(depStatus(x, all, terminal).blockedBy).toEqual(["a"]);
    expect(depStatus(x, all).blockedBy).toEqual(["a"]);
  });

  test("unresolvable dep board falls back to literal `done`", () => {
    // No board map entry for `gone` (deleted board / forward ref): a dep there
    // is satisfied only at literal `done`, never regressing the old behavior.
    const inShip = card({ slug: "c1", board: "gone", column: "ship" });
    const inDone = card({ slug: "c1d", board: "gone", column: "done" });
    const blockedBy = card({ slug: "x", deps: ["c1"] });
    const unblocked = card({ slug: "y", deps: ["c1d"] });
    const all = [inShip, inDone, blockedBy, unblocked];
    const empty = new Map<string, string>();
    expect(depStatus(blockedBy, all, empty).blocked).toBe(true); // `ship` ≠ `done`
    expect(depStatus(unblocked, all, empty).blocked).toBe(false); // `done` satisfies
  });

  test("only doing/review/done are gating (working) columns", () => {
    expect(isWorkingColumn("backlog")).toBe(false);
    expect(isWorkingColumn("todo")).toBe(false);
    expect(isWorkingColumn("doing")).toBe(true);
    expect(isWorkingColumn("review")).toBe(true);
    expect(isWorkingColumn("done")).toBe(true);
  });

  test("wouldCreateCycle rejects a direct mutual edge (a→b then b→a)", () => {
    // a already depends on b; adding b→a would close a 2-cycle.
    const all = [card({ slug: "a", deps: ["b"] }), card({ slug: "b" })];
    expect(wouldCreateCycle(all, "b", "a")).toEqual(["a", "b", "a"]);
  });

  test("wouldCreateCycle rejects a transitive cycle (a→b→c, then c→a)", () => {
    const all = [
      card({ slug: "a", deps: ["b"] }),
      card({ slug: "b", deps: ["c"] }),
      card({ slug: "c" }),
    ];
    // adding c→a: a reaches c (a→b→c), so the new edge closes a→b→c→a.
    expect(wouldCreateCycle(all, "c", "a")).toEqual(["a", "b", "c", "a"]);
  });

  test("wouldCreateCycle allows a valid DAG edge", () => {
    const all = [
      card({ slug: "a" }),
      card({ slug: "b", deps: ["a"] }),
      card({ slug: "c", deps: ["a"] }),
    ];
    // c→b is fine: b does not (transitively) depend on c.
    expect(wouldCreateCycle(all, "c", "b")).toBeNull();
  });

  test("wouldCreateCycle allows a forward/dangling dep (no such card)", () => {
    const all = [card({ slug: "a" })];
    // a→ghost: ghost has no outgoing edges, so it can never loop back to a.
    expect(wouldCreateCycle(all, "a", "ghost")).toBeNull();
  });

  test("wouldCreateCycle tolerates a pre-existing cycle in the data", () => {
    // x↔y already cycle (shouldn't happen, but don't hang): adding z→x is safe.
    const all = [
      card({ slug: "x", deps: ["y"] }),
      card({ slug: "y", deps: ["x"] }),
      card({ slug: "z" }),
    ];
    expect(wouldCreateCycle(all, "z", "x")).toBeNull();
  });
});

describe("search", () => {
  const corpus = [
    card({ slug: "ship-login", title: "Ship the login flow", tags: ["auth", "p1"] }),
    card({ slug: "fix-typo", title: "Fix a typo", body: "in the README", tags: ["docs"] }),
    card({ slug: "oauth", title: "OAuth support", assignee: "tom", body: "needs auth review" }),
  ];

  test("matches across slug, title, body, assignee, and tags (case-insensitive)", () => {
    expect(cardMatchesQuery(corpus[0]!, "LOGIN")).toBe(true); // title
    expect(cardMatchesQuery(corpus[0]!, "p1")).toBe(true); // tag
    expect(cardMatchesQuery(corpus[1]!, "readme")).toBe(true); // body
    expect(cardMatchesQuery(corpus[2]!, "tom")).toBe(true); // assignee
    expect(cardMatchesQuery(corpus[2]!, "oauth")).toBe(true); // slug
  });

  test("multi-word queries are AND-matched (every term must appear)", () => {
    expect(cardMatchesQuery(corpus[2]!, "oauth auth")).toBe(true); // slug + body
    expect(cardMatchesQuery(corpus[2]!, "oauth missing")).toBe(false);
  });

  test("queryTerms tokenizes, trimming and dropping empties", () => {
    expect(queryTerms("auth")).toEqual(["auth"]);
    expect(queryTerms("  OAuth   Auth  ")).toEqual(["oauth", "auth"]);
    // Truly-empty and whitespace-only queries yield zero effective terms —
    // `searchResult` treats that as a usage error (see search.ts guard test).
    expect(queryTerms("")).toEqual([]);
    expect(queryTerms("   ")).toEqual([]);
    expect(queryTerms("\t\n ")).toEqual([]);
  });

  test("cardMatchesQuery treats a zero-term query as match-all (entry-point guards it)", () => {
    // The low-level matcher keeps the empty=all wildcard; the authoritative
    // whitespace-only rejection lives at `searchResult` so both CLI + MCP error
    // uniformly. See search.ts for that guard.
    expect(cardMatchesQuery(corpus[0]!, "   ")).toBe(true);
  });

  test("searchCards returns the AND-matching subset", () => {
    expect(searchCards(corpus, "auth").map((c) => c.slug)).toEqual(["ship-login", "oauth"]);
    expect(searchCards(corpus, "nope")).toEqual([]);
  });

  test("renderSearchResults shows a count, location, and a no-match message", () => {
    const hits = searchCards(corpus, "auth");
    const out = renderSearchResults(hits, "auth", { color: false });
    expect(out).toContain('2 matches for "auth"');
    expect(out).toContain("[default/todo]");
    expect(out).toContain("ship-login");
    expect(renderSearchResults([], "ghost", { color: false })).toBe('No cards match "ghost".');
  });

  test("renderSearchResults caps rendered matches and prints an overflow line", () => {
    // 5 matching cards, capped at 2 → 2 bullet lines + a "… 3 more" overflow.
    const many = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `auth-${i}`, title: `auth ${i}`, column: "todo" }),
    );
    const out = renderSearchResults(many, "auth", { color: false, limit: 2 });
    const bullets = out.split("\n").filter((l) => l.trim().startsWith("•"));
    expect(bullets).toHaveLength(2);
    expect(out).toContain('5 matches for "auth"'); // header counts ALL matches
    expect(out).toContain("… 3 more (use --limit N or --all)");
  });

  test("renderSearchResults limit<=0 (--all) renders every match, no overflow line", () => {
    const many = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `auth-${i}`, title: `auth ${i}`, column: "todo" }),
    );
    const out = renderSearchResults(many, "auth", { color: false, limit: 0 });
    const bullets = out.split("\n").filter((l) => l.trim().startsWith("•"));
    expect(bullets).toHaveLength(5);
    expect(out).not.toContain("more (use --limit");
  });
});

describe("render", () => {
  test("renders columns with counts and a card line", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [card({ slug: "ship", title: "Ship it", column: "doing", tags: ["auth"] })], {
      color: false,
    });
    expect(out).toContain("DOING  (1)");
    expect(out).toContain("Ship it");
    expect(out).toContain("#auth");
    expect(out).toContain("BACKLOG  (0)");
  });

  test("limit caps a column and shows the overflow count", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const todo = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `t${i}`, title: `Todo ${i}`, column: "todo", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, todo, { color: false, limit: 2 });
    // Header still reports the true total.
    expect(out).toContain("TODO  (5)");
    // First 2 (top-of-column) shown; the rest collapse.
    expect(out).toContain("Todo 0");
    expect(out).toContain("Todo 1");
    expect(out).not.toContain("Todo 2");
    expect(out).toContain("… 3 more (--all)");
  });

  test("terminal column shows the most recent N (tail), not the first", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const done = Array.from({ length: 5 }, (_, i) =>
      card({ slug: `d${i}`, title: `Done ${i}`, column: "done", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, done, { color: false, limit: 2 });
    expect(out).toContain("DONE  (5)");
    // Tail (highest position = most recent) is kept; oldest are hidden.
    expect(out).toContain("Done 3");
    expect(out).toContain("Done 4");
    expect(out).not.toContain("Done 0");
    expect(out).toContain("… 3 earlier (--all)");
  });

  test("no limit (0) renders every card", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const done = Array.from({ length: 4 }, (_, i) =>
      card({ slug: `d${i}`, title: `Done ${i}`, column: "done", position: String((i + 1) * 10) }),
    );
    const out = renderBoard(board, done, { color: false, limit: 0 });
    for (let i = 0; i < 4; i++) expect(out).toContain(`Done ${i}`);
    expect(out).not.toContain("(--all)");
  });

  test("empty board renders the getting-started hint, not the — skeleton", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false });
    // Keeps the board heading.
    expect(out).toContain("Default board");
    // Friendly nudge with a copy-pasteable example.
    expect(out).toContain("No cards yet. Create your first:");
    expect(out).toContain(`fkanban add my-first-card --title "My first card"`);
    // No bare column skeleton.
    expect(out).not.toContain("  —");
    expect(out).not.toContain("BACKLOG  (0)");
  });

  test("empty-board hint is shim-aware — uses the injected invocation prefix", () => {
    // On a shim-less fresh clone the hint must print runnable
    // `bun run src/cli.ts …` commands, not bare `fkanban …` (which would
    // `command not found`). list.ts injects `fkanbanInvocation()`; here we pass
    // the shim-less form directly. Mirrors init's Next-steps behavior (PR #69).
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false, invocation: "bun run src/cli.ts" });
    expect(out).toContain(`bun run src/cli.ts add my-first-card --title "My first card"`);
    expect(out).toContain("`bun run src/cli.ts list`");
    expect(out).toContain("`bun run src/cli.ts mcp`");
    // No bare-`fkanban` form leaks through (it would `command not found`).
    expect(out).not.toContain("fkanban add my-first-card");
    expect(out).not.toContain("`fkanban list`");
  });

  test("a non-default empty board is equally welcoming", () => {
    const board = {
      slug: "sprint",
      title: "Sprint board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false });
    expect(out).toContain("Sprint board");
    expect(out).toContain("No cards yet. Create your first:");
    expect(out).not.toContain("  —");
  });

  test("non-default empty board: hint is board-aware — `add` carries --board <slug>", () => {
    // A dev viewing a custom board who copy-pastes the hint must land the card
    // on THAT board, not the default. So both the `add` and the follow-up
    // `list` suggestion carry `--board <slug>`.
    const board = {
      slug: "sprint",
      title: "Sprint board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false });
    expect(out).toContain(`fkanban add my-first-card --title "My first card" --board sprint`);
    expect(out).toContain("`fkanban list --board sprint`");
  });

  test("default empty board: hint carries NO --board flag (byte-for-byte unchanged)", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false });
    expect(out).toContain(`fkanban add my-first-card --title "My first card"`);
    expect(out).toContain("`fkanban list`");
    // No `--board` noise on the default board.
    expect(out).not.toContain("--board");
  });

  test("a board with ≥1 card renders the columns, not the hint", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [card({ slug: "ship", title: "Ship it", column: "doing" })], {
      color: false,
    });
    expect(out).not.toContain("No cards yet");
    expect(out).toContain("DOING  (1)");
    expect(out).toContain("Ship it");
  });

  test("--column on an empty board keeps the single-column — (no global hint)", () => {
    const board = {
      slug: "default",
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: "",
      updated_at: "",
    };
    const out = renderBoard(board, [], { color: false, column: "todo" });
    expect(out).not.toContain("No cards yet");
    expect(out).toContain("TODO  (0)");
    expect(out).toContain("  —");
  });
});

describe("doctor", () => {
  // Backs the fkanban_doctor MCP tool: it accumulates check lines through the
  // injected `print` callback and returns ok=false when a check fails. A
  // missing config short-circuits before any node call, so this stays pure.
  test("missing config → ok=false, prints the failed check + init hint", async () => {
    const lines: string[] = [];
    const ok = await doctor({ configPath: "/tmp/fkanban-doctor-nonexistent-config.json", print: (l) => lines.push(l) });
    expect(ok).toBe(false);
    const report = lines.join("\n");
    expect(report).toContain("✗ config present");
    expect(report).toContain("fkanban init");
  });
});

describe("mcp register helper (single source of truth)", () => {
  // doctor's "register with:" line and init's Next-steps register line MUST be
  // byte-identical — both come from mcpAddCommand(). The entrypoint that
  // mcpEntrypointPath() resolves to must be the same file mcpAddCommand() names
  // (in the bun+path form). See card `doctor-verify-mcp-entrypoint-fkanban`.
  test("mcpAddCommand uses the canonical `--` form", () => {
    expect(mcpAddCommand()).toMatch(
      /^claude mcp add fkanban -- (fkanban mcp|bun .+\/src\/mcp\/main\.ts)$/,
    );
  });

  test("entrypoint resolves and is consistent with the add command", () => {
    const entry = mcpEntrypointPath();
    expect(entry).not.toBeNull();
    const cmd = mcpAddCommand();
    if (cmd.endsWith(" mcp")) {
      // shim form — entrypoint is an installed bin, just assert it resolved.
      expect(entry!.length).toBeGreaterThan(0);
    } else {
      // bun+path form — the command must name the very file the entrypoint is.
      expect(cmd).toContain(entry!);
      expect(entry!.endsWith("/src/mcp/main.ts")).toBe(true);
    }
  });
});

describe("per-command help", () => {
  // Pull the command names out of TOP_HELP's "Commands:" section so the two
  // sources can't drift: every documented command must have a COMMAND_HELP entry.
  function commandsInTopHelp(): string[] {
    const lines = TOP_HELP.split("\n");
    const start = lines.findIndex((l) => l.trim() === "Commands:");
    expect(start).toBeGreaterThanOrEqual(0);
    const cmds: string[] = [];
    for (const line of lines.slice(start + 1)) {
      if (line.trim() === "") break; // section ends at the blank line
      const name = line.match(/^\s{2}([a-z]+)\b/)?.[1];
      if (name && name !== "help") cmds.push(name); // `help` is the global, not a per-command entry
    }
    return cmds;
  }

  test("every command in TOP_HELP has a COMMAND_HELP entry", () => {
    for (const cmd of commandsInTopHelp()) {
      expect(COMMAND_HELP[cmd], `missing COMMAND_HELP for "${cmd}"`).toBeDefined();
    }
  });

  test("COMMAND_HELP has no entries beyond TOP_HELP's commands", () => {
    const documented = new Set(commandsInTopHelp());
    for (const cmd of Object.keys(COMMAND_HELP)) {
      expect(documented.has(cmd), `COMMAND_HELP has stale entry "${cmd}"`).toBe(true);
    }
  });

  test("each entry names its command, shows a Usage line + an example, and the footer", () => {
    for (const [cmd, text] of Object.entries(COMMAND_HELP)) {
      expect(text).toContain(`fkanban ${cmd}`);
      expect(text).toContain("Usage:");
      expect(text).toContain("Run `fkanban help` for all commands.");
    }
  });

  test("init help tells the truth: the node loads schemas, --schema-service-url is diagnostic-only", () => {
    const init = COMMAND_HELP.init!;
    // The flag must NOT be described as the thing that resolves/loads schemas.
    expect(init).not.toContain("schema service to resolve fkanban schemas from");
    // It must name the node as the loader and the flag as informational/diagnostic.
    expect(init).toContain("loads schemas");
    expect(init).toMatch(/recorded in config|diagnostic/i);
  });

  test("resolveHelp returns command help for a known cmd with --help", () => {
    expect(resolveHelp("add", true)).toBe(COMMAND_HELP.add!);
    expect(resolveHelp("init", true)).toBe(COMMAND_HELP.init!);
  });

  test("resolveHelp returns global help for help/no-command/unknown", () => {
    expect(resolveHelp(undefined, true)).toBe(TOP_HELP); // `fkanban --help`
    expect(resolveHelp("help", false)).toBe(TOP_HELP); // `fkanban help`
    expect(resolveHelp("bogus", true)).toBe(TOP_HELP); // unknown cmd + --help
  });

  test("resolveHelp returns undefined when no help flag and a real command runs", () => {
    expect(resolveHelp("add", false)).toBeUndefined();
    expect(resolveHelp("list", false)).toBeUndefined();
  });

  test("resolveHelp routes `help <command>` to that command's help", () => {
    // `fkanban help add` is byte-identical to `fkanban add --help`.
    expect(resolveHelp("help", false, "add")).toBe(COMMAND_HELP.add!);
    expect(resolveHelp("help", false, "mcp")).toBe(COMMAND_HELP.mcp!);
    expect(resolveHelp("help", false, "move")).toBe(COMMAND_HELP.move!);
    expect(resolveHelp("help", false, "board")).toBe(COMMAND_HELP.board!);
  });

  test("`help <command>` matches `<command> --help` for every documented command", () => {
    for (const cmd of commandsInTopHelp()) {
      expect(resolveHelp("help", false, cmd)).toBe(resolveHelp(cmd, true));
    }
  });

  test("resolveHelp falls back to global help for `help <unknown-topic>` and bare `help`", () => {
    expect(resolveHelp("help", false, "bogus")).toBe(TOP_HELP); // unknown topic
    expect(resolveHelp("help", false, undefined)).toBe(TOP_HELP); // bare `help`
    expect(resolveHelp("help", false, "help")).toBe(TOP_HELP); // `help help` — no such per-command entry
  });

  test("TOP_HELP advertises per-command help discovery", () => {
    expect(TOP_HELP).toContain("fkanban help <command>");
    expect(TOP_HELP).toContain("fkanban <command> --help");
  });
});

describe("mutation result formatting (--json)", () => {
  test("human strings match the legacy one-liners", () => {
    expect(formatAdd({ slug: "ship", action: "created", board: "default", column: "todo" })).toBe(
      "created card ship → default/todo",
    );
    expect(formatMove({ slug: "ship", from: "todo", to: "doing" })).toBe("moved ship: todo → doing");
    expect(formatDep({ slug: "ui", dep: "api", action: "added", deps: ["api", "docs"] })).toBe(
      "ui now depends on api (deps: api, docs)",
    );
    expect(formatDep({ slug: "ui", dep: "api", action: "removed", deps: [] })).toBe(
      "ui no longer depends on api (deps: none)",
    );
    expect(formatTag({ slug: "ship", tag: ["p1"], action: "added", tags: ["auth", "p1"] })).toBe(
      "tagged ship p1 (tags: auth, p1)",
    );
    expect(formatTag({ slug: "ship", tag: ["p1"], action: "removed", tags: [] })).toBe(
      "untagged ship p1 (tags: none)",
    );
    expect(formatRm({ slug: "ship", orphanedDependents: [] })).toBe("removed card ship");
    expect(formatBoardCreate({ slug: "sprint", action: "updated" })).toBe("updated board sprint");
  });

  test("--json emits the raw result object, parseable back to the same shape", () => {
    const add = { slug: "ship", action: "created" as const, board: "default", column: "todo" };
    expect(JSON.parse(formatAdd(add, true))).toEqual(add);

    const move = { slug: "ship", from: "todo", to: "doing" };
    expect(JSON.parse(formatMove(move, true))).toEqual(move);

    const dep = { slug: "ui", dep: "api", action: "added" as const, deps: ["api"] };
    expect(JSON.parse(formatDep(dep, true))).toEqual(dep);

    const tag = { slug: "ui", tag: ["p1"], action: "added" as const, tags: ["p1"] };
    expect(JSON.parse(formatTag(tag, true))).toEqual(tag);

    expect(JSON.parse(formatRm({ slug: "ship", orphanedDependents: ["ui"] }, true))).toEqual({
      slug: "ship",
      orphanedDependents: ["ui"],
    });

    const board = { slug: "sprint", action: "created" as const };
    expect(JSON.parse(formatBoardCreate(board, true))).toEqual(board);
  });

  test("formatError emits a { error: { code, message, hint } } envelope", () => {
    const out = formatError({ code: "dep_cycle", message: "would cycle", hint: "a → b → a" });
    expect(JSON.parse(out)).toEqual({
      error: { code: "dep_cycle", message: "would cycle", hint: "a → b → a" },
    });
  });

  test("formatError omits hint when absent", () => {
    expect(JSON.parse(formatError({ code: "x", message: "m" }))).toEqual({
      error: { code: "x", message: "m" },
    });
  });

  test("orphanedDependentsWarning names the dangling dependents", () => {
    expect(orphanedDependentsWarning("api", ["ui", "docs"])).toBe(
      '  warning: 2 card(s) still depend on "api": ui, docs — their dependency is now dangling.',
    );
    expect(orphanedDependentsWarning("api", ["ui"])).toBe(
      '  warning: 1 card(s) still depend on "api": ui — their dependency is now dangling.',
    );
  });
});

describe("listCmd empty board", () => {
  // Stub node that returns an empty result set for every query — models a
  // brand-new board with no cards (and no board record, so the default-board
  // synthesis path is exercised).
  function emptyNode(): NodeClient {
    const empty: QueryResponse = { ok: true, results: [] };
    return {
      baseUrl: "http://stub",
      userHash: "stub",
      autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
      bootstrap: async () => ({ userHash: "stub" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      queryAll: async () => empty,
      rawCall: async () => ({ status: 200, body: "" }),
    } as unknown as NodeClient;
  }

  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://stub",
    schemaServiceUrl: "http://stub",
    userHash: "stub",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };

  test("default empty board (text) shows the getting-started hint", async () => {
    const out = await listCmd({ cfg, node: emptyNode() });
    expect(out).toContain("No cards yet. Create your first:");
    expect(out).not.toContain("  —");
  });

  test("--json on an empty board still returns []", async () => {
    const out = await listCmd({ cfg, node: emptyNode(), json: true });
    expect(JSON.parse(out)).toEqual([]);
    expect(out).not.toContain("No cards yet");
  });

  test("--column todo on an empty board shows the single-column — (no hint)", async () => {
    const out = await listCmd({ cfg, node: emptyNode(), column: "todo" });
    expect(out).not.toContain("No cards yet");
    expect(out).toContain("TODO  (0)");
    expect(out).toContain("  —");
  });
});

describe("listCmd --tag / --assignee filters", () => {
  // A populated stub: `queryAll` returns card rows for the card schema (and an
  // empty set for the board schema, exercising the default-board synthesis).
  function cardRow(c: Card): QueryRow {
    return {
      fields: {
        slug: c.slug,
        title: c.title,
        body: c.body,
        board: c.board,
        column: c.column,
        position: c.position,
        assignee: c.assignee,
        tags: c.tags,
        created_at: c.created_at,
        updated_at: c.updated_at,
      },
    } as unknown as QueryRow;
  }

  function populatedNode(cards: Card[]): NodeClient {
    const empty: QueryResponse = { ok: true, results: [] };
    return {
      baseUrl: "http://stub",
      userHash: "stub",
      autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
      bootstrap: async () => ({ userHash: "stub" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      // Cards live under `cardhash`; the board read (`boardhash`) returns empty,
      // so the default-board synthesis path is used.
      queryAll: async (q: { schemaHash: string }): Promise<QueryResponse> =>
        q.schemaHash === "cardhash" ? { ok: true, results: cards.map(cardRow) } : empty,
      rawCall: async () => ({ status: 200, body: "" }),
    } as unknown as NodeClient;
  }

  const corpus = [
    card({ slug: "a", column: "todo", tags: ["fkanban", "dx"], assignee: "tom" }),
    card({ slug: "b", column: "doing", tags: ["fkanban"], assignee: "ann" }),
    card({ slug: "c", column: "todo", tags: ["infra"], assignee: "tom" }),
  ];

  async function slugs(opts: Partial<ListOptions>): Promise<string[]> {
    const out = await listCmd({ cfg, node: populatedNode(corpus), json: true, ...opts });
    return (JSON.parse(out) as Card[]).map((c) => c.slug).sort();
  }

  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://stub",
    schemaServiceUrl: "http://stub",
    userHash: "stub",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };

  test("--tag is an exact membership filter (not fuzzy)", async () => {
    expect(await slugs({ tag: "fkanban" })).toEqual(["a", "b"]);
  });

  test("--tag with no matching card renders empty cleanly (exit 0, no error)", async () => {
    // Must NOT throw — a tag need not pre-exist (unlike --column, which is
    // validated against the board's columns). It just yields zero cards.
    const out = await listCmd({ cfg, node: populatedNode(corpus), tag: "nonexistent-xyz" });
    expect(typeof out).toBe("string");
    const json = await listCmd({ cfg, node: populatedNode(corpus), tag: "nonexistent-xyz", json: true });
    expect(JSON.parse(json)).toEqual([]);
  });

  test("--assignee is an exact equality filter", async () => {
    expect(await slugs({ assignee: "tom" })).toEqual(["a", "c"]);
  });

  test("--column and --tag compose (both applied)", async () => {
    expect(await slugs({ column: "todo", tag: "fkanban" })).toEqual(["a"]);
  });

  test("--tag and --assignee compose (both applied)", async () => {
    expect(await slugs({ tag: "fkanban", assignee: "ann" })).toEqual(["b"]);
  });
});

describe("listCmd --json honors an explicit --limit (per-column cap)", () => {
  // A corpus spanning two columns with distinct positions so the per-column
  // head/tail slice is deterministic. `todo` is a non-terminal column (head
  // slice); `done` is the terminal column (tail slice — most recent kept).
  const corpus: Card[] = [
    card({ slug: "t1", column: "todo", position: "1" }),
    card({ slug: "t2", column: "todo", position: "2" }),
    card({ slug: "t3", column: "todo", position: "3" }),
    card({ slug: "d1", column: "done", position: "1" }),
    card({ slug: "d2", column: "done", position: "2" }),
    card({ slug: "d3", column: "done", position: "3" }),
  ];

  function cardRow(c: Card): QueryRow {
    return {
      fields: {
        slug: c.slug,
        title: c.title,
        body: c.body,
        board: c.board,
        column: c.column,
        position: c.position,
        assignee: c.assignee,
        tags: c.tags,
        created_at: c.created_at,
        updated_at: c.updated_at,
      },
    } as unknown as QueryRow;
  }

  function populatedNode(cards: Card[]): NodeClient {
    const empty: QueryResponse = { ok: true, results: [] };
    return {
      baseUrl: "http://stub",
      userHash: "stub",
      autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
      bootstrap: async () => ({ userHash: "stub" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      queryAll: async (q: { schemaHash: string }): Promise<QueryResponse> =>
        q.schemaHash === "cardhash" ? { ok: true, results: cards.map(cardRow) } : empty,
      rawCall: async () => ({ status: 200, body: "" }),
    } as unknown as NodeClient;
  }

  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://stub",
    schemaServiceUrl: "http://stub",
    userHash: "stub",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };

  async function jsonSlugs(opts: Partial<ListOptions>): Promise<string[]> {
    const out = await listCmd({ cfg, node: populatedNode(corpus), json: true, ...opts });
    return (JSON.parse(out) as Card[]).map((c) => c.slug);
  }

  test("no --limit → JSON is uncapped (full filtered board, no implicit 12-cap)", async () => {
    expect((await jsonSlugs({})).sort()).toEqual(["d1", "d2", "d3", "t1", "t2", "t3"]);
  });

  test("explicit --limit caps a single column to N (matches the text head slice)", async () => {
    // `done --limit 2` is the terminal column → keeps the most recent 2 (tail).
    expect(await jsonSlugs({ column: "done", limit: 2 })).toEqual(["d2", "d3"]);
    // `todo --limit 2` is non-terminal → keeps the first 2 (head).
    expect(await jsonSlugs({ column: "todo", limit: 2 })).toEqual(["t1", "t2"]);
  });

  test("explicit --limit caps EACH column across a multi-column view", async () => {
    // At most 2 per column: todo head (t1,t2) + done tail (d2,d3).
    expect((await jsonSlugs({ limit: 2 })).sort()).toEqual(["d2", "d3", "t1", "t2"]);
  });

  test("--all → JSON is uncapped (no-op, even with a limit)", async () => {
    expect((await jsonSlugs({ all: true, limit: 1 })).sort()).toEqual([
      "d1",
      "d2",
      "d3",
      "t1",
      "t2",
      "t3",
    ]);
  });
});

describe("otherBoardsFooter (multi-board discoverability hint)", () => {
  test("names each OTHER board with its live-card count, sorted by slug", () => {
    const cards = [
      card({ slug: "x", board: "roadmap" }),
      card({ slug: "y", board: "roadmap" }),
      card({ slug: "z", board: "roadmap" }),
      card({ slug: "b1", board: "bugs" }),
      card({ slug: "d1", board: "default" }), // current board — excluded
    ];
    const out = otherBoardsFooter(cards, "default", "fkanban");
    expect(out).toBe(
      "ℹ 2 other boards have cards: bugs (1), roadmap (3). View with `fkanban list --board bugs`.",
    );
  });

  test("singular grammar + count for a single other board", () => {
    const cards = [card({ slug: "x", board: "roadmap" }), card({ slug: "d1", board: "default" })];
    expect(otherBoardsFooter(cards, "default", "fkanban")).toBe(
      "ℹ 1 other board has cards: roadmap (1). View with `fkanban list --board roadmap`.",
    );
  });

  test("empty string (no footer) when no OTHER board holds a live card", () => {
    const cards = [card({ slug: "a", board: "default" }), card({ slug: "b", board: "default" })];
    expect(otherBoardsFooter(cards, "default", "fkanban")).toBe("");
    expect(otherBoardsFooter([], "default", "fkanban")).toBe("");
  });

  test("excludes the board being viewed (works for a non-default --board too)", () => {
    const cards = [
      card({ slug: "r1", board: "roadmap" }),
      card({ slug: "d1", board: "default" }),
      card({ slug: "d2", board: "default" }),
    ];
    // Viewing `roadmap` → only `default` is "other".
    expect(otherBoardsFooter(cards, "roadmap", "fkanban")).toBe(
      "ℹ 1 other board has cards: default (2). View with `fkanban list --board default`.",
    );
  });

  test("caps the enumerated boards and collapses the rest to +K more (one line)", () => {
    const cards = ["b1", "b2", "b3", "b4", "b5", "b6", "b7"].map((b) =>
      card({ slug: `c-${b}`, board: b }),
    );
    const out = otherBoardsFooter(cards, "default", "fkanban");
    // First 5 enumerated, remaining 2 collapsed.
    expect(out).toContain("b1 (1), b2 (1), b3 (1), b4 (1), b5 (1), +2 more.");
    expect(out).not.toContain("b6 (1)");
    expect(out.split("\n")).toHaveLength(1);
  });

  test("uses the injected invocation prefix in the copy-paste hint", () => {
    const cards = [card({ slug: "x", board: "roadmap" })];
    expect(otherBoardsFooter(cards, "default", "bun run src/cli.ts")).toContain(
      "View with `bun run src/cli.ts list --board roadmap`.",
    );
  });
});

describe("listCmd multi-board footer", () => {
  function cardRow(c: Card): QueryRow {
    return {
      fields: {
        slug: c.slug,
        title: c.title,
        body: c.body,
        board: c.board,
        column: c.column,
        position: c.position,
        assignee: c.assignee,
        tags: c.tags,
        created_at: c.created_at,
        updated_at: c.updated_at,
      },
    } as unknown as QueryRow;
  }

  function populatedNode(cards: Card[]): NodeClient {
    const empty: QueryResponse = { ok: true, results: [] };
    return {
      baseUrl: "http://stub",
      userHash: "stub",
      autoIdentity: async () => ({ provisioned: true, userHash: "stub" }),
      bootstrap: async () => ({ userHash: "stub" }),
      loadSchemas: async () => ({ available_schemas_loaded: 0, schemas_loaded_to_db: 0, failed_schemas: [] }),
      listSchemas: async () => [],
      createRecord: async () => {},
      updateRecord: async () => {},
      deleteRecord: async () => {},
      queryAll: async (q: { schemaHash: string }): Promise<QueryResponse> =>
        q.schemaHash === "cardhash" ? { ok: true, results: cards.map(cardRow) } : empty,
      rawCall: async () => ({ status: 200, body: "" }),
    } as unknown as NodeClient;
  }

  const cfg: Config = {
    configVersion: 1,
    nodeUrl: "http://stub",
    schemaServiceUrl: "http://stub",
    userHash: "stub",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };

  const multiBoard = [
    card({ slug: "d1", board: "default", column: "todo" }),
    card({ slug: "r1", board: "roadmap", column: "todo" }),
    card({ slug: "r2", board: "roadmap", column: "doing" }),
    card({ slug: "b1", board: "bugs", column: "todo" }),
  ];

  test("default list surfaces the footer naming OTHER boards + counts", async () => {
    const out = await listCmd({ cfg, node: populatedNode(multiBoard) });
    expect(out).toContain("ℹ 2 other boards have cards: bugs (1), roadmap (2).");
  });

  test("no footer when only the viewed board has cards", async () => {
    const only = [card({ slug: "d1", board: "default" }), card({ slug: "d2", board: "default" })];
    const out = await listCmd({ cfg, node: populatedNode(only) });
    expect(out).not.toContain("other board");
  });

  test("--json never carries the footer (machine surface untouched)", async () => {
    const out = await listCmd({ cfg, node: populatedNode(multiBoard), json: true });
    expect(out).not.toContain("other board");
    // And the JSON array is exactly the viewed board's cards.
    expect((JSON.parse(out) as Card[]).map((c) => c.slug).sort()).toEqual(["d1"]);
  });

  test("tombstoned other-board cards are excluded from the count", async () => {
    const withDeleted = [
      card({ slug: "d1", board: "default" }),
      card({ slug: "r1", board: "roadmap" }),
      card({ slug: "r-gone", board: "roadmap", tags: [TOMBSTONE_TAG] }),
    ];
    const out = await listCmd({ cfg, node: populatedNode(withDeleted) });
    // listCards drops the tombstoned card → roadmap counts 1, not 2.
    expect(out).toContain("ℹ 1 other board has cards: roadmap (1).");
  });

  test("a current-board filter (--tag) does not suppress the other-board count", async () => {
    // The current view is filtered to nothing on `default`, but other boards
    // still hold cards — the footer reflects an unfiltered other-board count.
    const out = await listCmd({ cfg, node: populatedNode(multiBoard), tag: "nonexistent-xyz" });
    expect(out).toContain("ℹ 2 other boards have cards: bugs (1), roadmap (2).");
  });
});

describe("command suggestion (did-you-mean)", () => {
  const commands = Object.keys(COMMAND_HELP);

  test("levenshtein computes standard edit distance", () => {
    expect(levenshtein("list", "list")).toBe(0);
    expect(levenshtein("lst", "list")).toBe(1); // one insertion
    expect(levenshtein("mvoe", "move")).toBe(2); // transposition = 2 edits
    expect(levenshtein("", "add")).toBe(3);
  });

  test("a close typo suggests the nearest command", () => {
    expect(suggestClosest("lst", commands)).toBe("list");
    expect(suggestClosest("ad", commands)).toBe("add");
    expect(suggestClosest("serach", commands)).toBe("search");
    expect(suggestClosest("mvoe", commands)).toBe("move");
  });

  test("a far-off token yields no suggestion (falls back to full help)", () => {
    expect(suggestClosest("frobnicate", commands)).toBeNull();
    expect(suggestClosest("", commands)).toBeNull();
  });

  test("a flag typo suggests the closest valid flag for that command", () => {
    // suggestFlag drives the new "Did you mean \"--title\"?" line in the
    // unknown-OPTION catch branch (mirrors the unknown-command path above).
    expect(suggestFlag("add", "titel")).toBe("title");
    expect(suggestFlag("list", "collumn")).toBe("column");
  });

  test("a far-off flag token yields no suggestion (no false positive)", () => {
    expect(suggestFlag("add", "frobnicate")).toBeNull();
    // An unknown command never suggests a flag.
    expect(suggestFlag("nosuchcmd", "titel")).toBeNull();
  });
});
