// `groom parity-check` learned on 2026-08-05 that a green must mean "I looked
// and everything agreed", never "I did not look"
// (`parity-check-vacuous-green.test.ts`). Its sibling did not.
//
// `kanban doctor` is the command CLAUDE.md points every agent at first, and it
// runs the SAME three projection-parity checks. Two of them handle a skip
// honestly: an unbound `board_cards` / `board_milestones` prints
// `· … not bound — skipped` and emits NO verdict for that partition. The third
// does not, and the difference is structural rather than stylistic:
//
//   * BoardCards / BoardMilestones skip with a `continue` AT the call site, so
//     the skip is the line that gets printed.
//   * MilestoneCards fans out over candidate partitions and folds the results.
//     `sweepMilestoneCardsPartition` returns `null` on an unresolvable schema
//     hash, the fan-out maps that to `{ skipped: true }`, and then all three
//     filters — `refused`, `unreadable`, `measured` — drop it. Nothing counts
//     it, nothing prints it, and the aggregate falls through to the success
//     arm, which renders `measured.length` as its coverage:
//
//       ✓ MilestoneCards projection parity — 0 rows across 0 milestone
//         partition(s), every lead agrees
//
// "every lead agrees" over zero leads, on an index nothing read, as a PASS.
//
// This is reachable, not theoretical. `doctor` deliberately treats an unpinned
// index as a supported degraded mode (`· milestone_cards not pinned`, info,
// never red — the policy at the `identity.kind === "unset"` arm), so NOTHING
// upstream flips `ok` first. And `milestone_cards` is precisely the pin this
// system keeps failing to resolve: it is pinned under the *Milestone* entity
// identity on the live primary today
// (`papercut-kanban-primary-milestone-cards-pinned-under-the-milestone-identity`),
// carried as an accepted deviation. The repin that fixes that is an open,
// designed change — and the run it lands, doctor starts asserting health for an
// index it stopped reading, while `groom parity-check` on the same node reports
// `✗ MilestoneCards — NOT CHECKED`. Two commands, one node, opposite verdicts.
//
// ## What is fixed here, and what is deliberately NOT
//
// NOT the verdict. Making doctor red on an unpinned index would contradict its
// own documented degraded-mode policy and fail doctor on every config predating
// a catalog entry — the "a red no operator action can clear" failure this file's
// neighbours already argue against. `parity-check` may go red because refusing
// to check parity IS its one job; doctor's job is broader.
//
// What is fixed is the LIE: a skipped partition must leave a trace, and a line
// that says `every lead agrees` must be backed by a lead that was actually read.
// After the fix all three indexes behave the same way on a skip — a `·` naming
// what went unchecked, and no verdict claimed over it.
//
// Matched pairs throughout: every "must not claim coverage" has a twin that must
// keep reporting a real pass. A gate that fails safe by failing always gets
// muted, and a muted gate is the unstaffed detector again.

import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { type DoctorCheck, runDoctorStructured } from "../src/commands/doctor.ts";
import { boardCardSk } from "../src/board-cards.ts";
import {
  BOARD_CARDS_LAYOUT,
  MILESTONE_CARDS_LAYOUT,
  allPinnedSchemas,
} from "../src/schemas.ts";

// Every pinned key at its DECLARED identity and layout, so pin-identity and
// key-layout are green for the right reason and the only thing that can move
// `report.ok` in these tests is the subject under test.
const HASH_FOR: Record<string, string> = Object.fromEntries(
  allPinnedSchemas().map((e) => [e.key, `hash-${e.key}`]),
);

function schemaRowFor(key: string) {
  const def = allPinnedSchemas().find((e) => e.key === key)!.schema.schema;
  return {
    name: HASH_FOR[key],
    descriptive_name: def.descriptive_name,
    owner_app_id: def.owner_app_id,
    fields: [...def.fields],
    key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
  };
}

const CARD_HASH = HASH_FOR.card!;
const BOARD_HASH = HASH_FOR.board!;
const MILESTONE_HASH = HASH_FOR.milestone!;
const BOARD_CARDS_HASH = HASH_FOR.board_cards!;
const MILESTONE_CARDS_HASH = HASH_FOR.milestone_cards!;

const BOARD = "default";
const CHECK = "MilestoneCards projection parity";

type CardSpec = { slug: string; milestone: string };

/**
 * A node that answers every projection with every row of the partition. Drift
 * is not what these tests are about — coverage is — so parity always agrees
 * where it is actually measured, and any non-pass verdict is the skip talking.
 */
function makeNode(cards: CardSpec[]) {
  const dir = mkdtempSync(join(tmpdir(), "fkanban-doctor-skip-node-"));
  const socketPath = join(dir, "folddb.sock");

  const rows = cards.map((c, i) => {
    const sk = boardCardSk("todo", String(i + 1), c.slug);
    return {
      sk,
      slug: c.slug,
      milestone: c.milestone,
      fields: {
        board: BOARD,
        milestone: c.milestone,
        sk,
        slug: c.slug,
        title: c.slug,
        column: "todo",
        position: String(i + 1),
        created_at: "2026-01-01T00:00:00.000Z",
        updated_at: "2026-01-01T00:00:00.000Z",
      } as Record<string, unknown>,
    };
  });

  // Card truth, so the multi-field smoke check's point-read resolves and its
  // ✗ cannot be mistaken for the one under test.
  const store = new Map<string, Record<string, unknown>>();
  for (const r of rows) store.set(`${CARD_HASH}::${r.slug}`, { ...r.fields, body: "" });
  store.set(`${BOARD_HASH}::${BOARD}`, {
    slug: BOARD,
    title: "Default",
    body: "",
    columns: "backlog,todo,doing,done",
    created_at: "2026-01-01T00:00:00.000Z",
    updated_at: "2026-01-01T00:00:00.000Z",
  });

  const server = Bun.serve({
    unix: socketPath,
    async fetch(req) {
      const url = new URL(req.url);
      let body: Record<string, unknown> | undefined;
      if (req.method === "POST") {
        const text = await req.text();
        body = text.length > 0 ? (JSON.parse(text) as Record<string, unknown>) : {};
      }
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") {
        return Response.json({ schemas: allPinnedSchemas().map((e) => schemaRowFor(e.key)) });
      }
      // The key-layout checks read the live layout from here. Without it they go
      // red for a reason unrelated to this file's subject, which would make the
      // `report.ok` twins assert against a board state that does not exist.
      if (url.pathname.startsWith("/api/schema/")) {
        const hash = decodeURIComponent(url.pathname.slice("/api/schema/".length));
        const key = Object.keys(HASH_FOR).find((k) => HASH_FOR[k] === hash);
        if (!key) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ schema: schemaRowFor(key) });
      }
      if (url.pathname === "/api/mutation") {
        const schema = body!.schema as string;
        const keyHash = (body!.key_value as { hash: string }).hash;
        if ((body!.mutation_type as string) === "delete") store.delete(`${schema}::${keyHash}`);
        else store.set(`${schema}::${keyHash}`, (body!.fields_and_values ?? {}) as Record<string, unknown>);
        return Response.json({ ok: true, success: true });
      }
      if (url.pathname === "/api/query") {
        const schema = body!.schema_name as string;
        const filter = body!.filter as { HashKey?: string; HashRange?: { hash?: string } } | undefined;
        const hashKey = filter?.HashKey ?? filter?.HashRange?.hash ?? null;

        if (schema === BOARD_CARDS_HASH) {
          return Response.json({
            ok: true,
            has_more: false,
            results: rows
              .filter(() => hashKey === null || hashKey === BOARD)
              .map((r) => ({
                fields: { ...r.fields, layout: BOARD_CARDS_LAYOUT },
                key: { hash: BOARD, range: r.sk },
              })),
          });
        }
        if (schema === MILESTONE_CARDS_HASH) {
          return Response.json({
            ok: true,
            has_more: false,
            results: rows
              .filter((r) => hashKey === null || r.milestone === hashKey)
              .map((r) => ({
                fields: { ...r.fields, layout: MILESTONE_CARDS_LAYOUT },
                key: { hash: r.milestone, range: r.sk },
              })),
          });
        }
        return Response.json({
          ok: true,
          has_more: false,
          results: [...store.entries()]
            .filter(([k]) => k.startsWith(`${schema}::`))
            .map(([k, f]) => ({ fields: f, key: { hash: k.split("::")[1]!, range: null } }))
            .filter((r) => hashKey === null || r.key.hash === hashKey),
        });
      }
      return Response.json({ error: "unexpected", path: url.pathname }, { status: 500 });
    },
  });

  return {
    socketPath,
    stop: () => {
      server.stop(true);
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

const tmp = mkdtempSync(join(tmpdir(), "fkanban-doctor-skip-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

/** A closed TCP port, so the socket path is the only transport that works. */
function closedTcpUrl(): string {
  const server = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const url = `http://127.0.0.1:${server.port}`;
  server.stop(true);
  return url;
}

// `board_milestones` is deliberately absent from the base: these tests are
// about MilestoneCards, and leaving that index unbound keeps the fixture
// honest about which skip each assertion is reading.
function writeCfg(
  name: string,
  socketPath: string,
  extra: Record<string, string>,
  omit: string[] = [],
): string {
  const p = join(tmp, name);
  const schemaHashes: Record<string, string> = {
    card: CARD_HASH,
    board: BOARD_HASH,
    milestone: MILESTONE_HASH,
    board_cards: BOARD_CARDS_HASH,
    ...extra,
  };
  for (const k of omit) delete schemaHashes[k];
  writeFileSync(
    p,
    JSON.stringify({
      configVersion: 1,
      nodeUrl: closedTcpUrl(),
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes,
      nodeSocketPath: socketPath,
    }),
  );
  return p;
}

async function run(name: string, cards: CardSpec[], extra: Record<string, string>) {
  const node = makeNode(cards);
  try {
    const cfgPath = writeCfg(`${name}.json`, node.socketPath, extra);
    const report = await runDoctorStructured({ configPath: cfgPath });
    return { report, milestoneCards: report.checks.filter((c) => c.name === CHECK) };
  } finally {
    node.stop();
  }
}

/** The exact phrase the operator reads as "this index was verified". */
function claimsCoverage(c: DoctorCheck): boolean {
  return c.status === "pass" && (c.detail ?? "").includes("every lead agrees");
}

const NAMED = [
  { slug: "card-a", milestone: "ms-one" },
  { slug: "card-b", milestone: "ms-two" },
];

describe("doctor — a skipped index must not report a verdict (RED)", () => {
  test("milestone_cards unbound: no pass claiming `every lead agrees` over 0 partitions", async () => {
    const { milestoneCards } = await run("unbound", NAMED, {});

    // The defect, stated as the operator experiences it: a ✓ on an index whose
    // partitions were never opened.
    expect(milestoneCards.filter(claimsCoverage)).toEqual([]);
  });

  test("milestone_cards unbound: the skipped partitions are still NAMED", async () => {
    const { milestoneCards } = await run("unbound-named", NAMED, {});

    // Silence is the other half of the bug. `parity-check` reports the skipped
    // partition list; doctor must at minimum say the index went unchecked, or a
    // reader triaging the report cannot tell coverage from health.
    expect(milestoneCards.length).toBeGreaterThan(0);
    const detail = milestoneCards.map((c) => c.detail ?? "").join(" ");
    expect(detail.toLowerCase()).toContain("not checked");
    expect(detail).toContain("milestone_cards");
  });

  test("milestone_cards unbound: coverage loss does not silently shrink the count", async () => {
    // One candidate is whitespace-only. `milestonesNamedByCards` admits it
    // (`ms.length > 0`) and the sweep refuses it (`!milestone.trim()`), so this
    // is the MIXED case: real coverage on one partition, none on the other.
    // `measured.length` alone renders that as full coverage of one partition.
    const { milestoneCards } = await run(
      "mixed",
      [
        { slug: "card-a", milestone: "ms-one" },
        { slug: "card-b", milestone: "   " },
      ],
      { milestone_cards: MILESTONE_CARDS_HASH },
    );

    const detail = milestoneCards.map((c) => c.detail ?? "").join(" ");
    // Whatever the verdict, the report must disclose that a candidate partition
    // went unchecked rather than let the readable one vouch for it.
    expect(detail.toLowerCase()).toMatch(/skip|not checked|unchecked/);
  });
});

describe("doctor — a claim about the data needs a read (RED)", () => {
  test("board_cards unbound: must not report `no card names a milestone`", async () => {
    // The candidate list for MilestoneCards is harvested from the BoardCards
    // wide read. Skip that read and the set is empty — and doctor turned an
    // empty set into a statement about the board: `no card names a milestone —
    // nothing to check`. Here two cards name two milestones, and the only
    // reason doctor cannot see them is that it did not look.
    //
    // Found by the NOT-CHECKED vocabulary test above, not by inspection: it is
    // the same defect as the ✓ this file opens with, one dependency upstream,
    // and it survived the first fix.
    const node = makeNode(NAMED);
    try {
      const cfgPath = writeCfg("unharvested.json", node.socketPath, {
        milestone_cards: MILESTONE_CARDS_HASH,
      }, ["board_cards"]);
      const report = await runDoctorStructured({ configPath: cfgPath });
      const mc = report.checks.filter((c) => c.name === CHECK);

      const detail = mc.map((c) => c.detail ?? "").join(" ");
      expect(detail).not.toContain("no card names a milestone");
      expect(detail).toContain("NOT CHECKED");
      // Still advisory — the degraded-mode policy is unchanged.
      expect(mc.every((c) => c.status !== "fail")).toBe(true);
    } finally {
      node.stop();
    }
  });
});

describe("doctor — one vocabulary for a coverage gap", () => {
  test("every skipped index says NOT CHECKED, so the gap is greppable", async () => {
    // All three projection indexes unbound at once. Before this change the
    // three skips were phrased three different ways — `board_cards not bound
    // — skipped`, `board_milestones not bound or partition unreadable —
    // skipped` (a condition that cannot occur: the sweeps return null ONLY on
    // an unresolvable hash), and a ✓ claiming `every lead agrees`. An operator
    // asking "what did this run not look at" had no single answer to grep for.
    const node = makeNode(NAMED);
    try {
      const cfgPath = writeCfg("all-unbound.json", node.socketPath, {}, ["board_cards"]);
      const report = await runDoctorStructured({ configPath: cfgPath });
      const gaps = report.checks.filter((c) => (c.detail ?? "").includes("NOT CHECKED"));
      const names = gaps.map((c) => c.name).join(" | ");

      expect(names).toContain("BoardCards");
      expect(names).toContain("BoardMilestones");
      expect(names).toContain("MilestoneCards");
      // Advisory, all of them — the degraded-mode policy is unchanged.
      expect(gaps.every((c) => c.status === "info")).toBe(true);
    } finally {
      node.stop();
    }
  });
});

describe("doctor — the twins that must stay green (NEGATIVE)", () => {
  test("milestone_cards unbound is still not a FAILURE — degraded mode is supported", async () => {
    const { report, milestoneCards } = await run("unbound-not-red", NAMED, {});

    // The fix removes a false claim; it must not invent a red that no operator
    // action can clear. An unpinned index remains a supported degraded mode,
    // exactly as the `identity.kind === "unset"` arm documents.
    expect(milestoneCards.every((c) => c.status !== "fail")).toBe(true);
    expect(report.ok).toBe(true);
  });

  test("milestone_cards bound and agreeing: a REAL pass, still saying `every lead agrees`", async () => {
    const { report, milestoneCards } = await run("bound", NAMED, {
      milestone_cards: MILESTONE_CARDS_HASH,
    });

    // The positive control. If this stops passing, the fix has broken the check
    // rather than the lie: two partitions were read, both agreed, and the line
    // that says so is the one the whole block exists to print.
    expect(milestoneCards.filter(claimsCoverage).length).toBe(1);
    expect(milestoneCards.find(claimsCoverage)!.detail).toContain("2 milestone partition(s)");
    expect(report.ok).toBe(true);
  });

  test("no card names a milestone: the existing honest skip, unchanged", async () => {
    const { report, milestoneCards } = await run(
      "no-candidates",
      [{ slug: "card-a", milestone: "" }],
      { milestone_cards: MILESTONE_CARDS_HASH },
    );

    // A partition nothing points at has no row to lose. This branch was already
    // honest ("nothing to check") and must not be swept into the new wording.
    expect(milestoneCards.length).toBe(1);
    expect(milestoneCards[0]!.status).toBe("info");
    expect(milestoneCards[0]!.detail).toContain("no card names a milestone");
    expect(report.ok).toBe(true);
  });
});
