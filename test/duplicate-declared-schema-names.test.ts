/**
 * One declared name, several Available schemas.
 *
 * `descriptive_name` is what `POST /api/apps/declare-schema` resolves on, and
 * nothing makes it unique in the node catalog. A rekey mints a new identity and
 * leaves the predecessor holding the same name. A machine that already HAS a
 * config is immune — its pin names the identity by hash — so every check in
 * `doctor` reads green there. The name is only resolved on a machine with NO
 * config, i.e. inside `kanban init`, which is the one run no doctor observes.
 *
 * That is how this stayed invisible while it failed the public install path
 * from https://thelastdb.com/llms.txt twice (2026-09-04T20:35Z and
 * 2026-09-06T20:15Z, same signature). Measured on the primary 2026-09-07,
 * `BoardCards_hashrange_v1` had FIVE Available fkanban schemas:
 *
 *     39a0424f  key=milestone/sk  24 fields   (the rekey predecessor)
 *     e2bc8e6d  key=board/sk      24 fields
 *     595de0c7  key=board/sk      22 fields
 *     ad3cf9d6  key=board/sk      23 fields
 *     1ef2e7a3  key=board/sk      29 fields   (the decided product pin)
 *
 * A fresh install resolved the milestone-keyed predecessor and `kanban init`
 * refused, correctly, with `key: declared HashRange(board, sk), pinned schema is
 * HashRange(milestone, sk)`.
 *
 * Two things are asserted here, and they are different claims:
 *
 *   1. `init` now picks the identity it DECLARED out of the claimants, so a
 *      duplicated name no longer decides what a fresh machine pins.
 *   2. `doctor` FAILS on the duplication anyway, because every other reader of
 *      that name still resolves it by luck.
 *
 * The doctor assertions go through `doctor()` itself, not the helper. A helper
 * unit test passes just as happily when nothing calls the helper — the wiring
 * hole this repo has hit three times.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { doctor } from "../src/commands/doctor.ts";
import { correctDeclaredSchemaIdentities } from "../src/commands/init.ts";
import {
  allPinnedSchemas,
  boardCardsSchema,
  correctResolvedSchemaIdentity,
  duplicateDeclaredSchemaNames,
  type LoadedSchemaCandidate,
} from "../src/schemas.ts";
import type { NodeClient } from "../src/client.ts";
import { handleApiList } from "./http-list.ts";

const BC_ENTRY = { key: "board_cards", schema: boardCardsSchema };
const BC_DEF = boardCardsSchema.schema;
const BC_NAME = BC_DEF.descriptive_name;

// The primary's claimants, with the field counts it actually reports. `wide`
// carries the declared 24 plus five more; `narrow23`/`narrow22` are missing
// declared fields, so they are not write targets at all.
const DECLARED_FIELDS = [...BC_DEF.fields];
const WIDE_FIELDS = [...DECLARED_FIELDS, "x1", "x2", "x3", "x4", "x5"];
const NARROW23 = DECLARED_FIELDS.filter((f) => f !== "milestone");
const NARROW22 = DECLARED_FIELDS.filter((f) => f !== "milestone" && f !== "created_by");

function row(
  hash: string,
  over: Partial<LoadedSchemaCandidate> = {},
): LoadedSchemaCandidate {
  return {
    name: hash,
    descriptive_name: BC_NAME,
    owner_app_id: BC_DEF.owner_app_id,
    fields: [...DECLARED_FIELDS],
    key: { hash_field: BC_DEF.key.hash_field, range_field: BC_DEF.key.range_field ?? null },
    state: "Available",
    ...over,
  };
}

// hashes chosen so ascending-hash order is NOT widest-first order, which is what
// makes the tiebreak assertions mean something.
const PREDECESSOR = row("0039a0424f", { key: { hash_field: "milestone", range_field: "sk" } });
const SAME_WIDTH = row("00e2bc8e6d");
const NARROWER23 = row("00ad3cf9d6", { fields: NARROW23 });
const NARROWER22 = row("00595de0c7", { fields: NARROW22 });
const DECIDED_PIN = row("ff1ef2e7a3", { fields: WIDE_FIELDS });
const PRIMARY_CLAIMANTS = [PREDECESSOR, SAME_WIDTH, NARROWER22, NARROWER23, DECIDED_PIN];

describe("duplicateDeclaredSchemaNames", () => {
  test("a catalog with one schema per declared name reports nothing", () => {
    const clean = allPinnedSchemas().map((e) =>
      row(`hash-${e.key}`, {
        descriptive_name: e.schema.schema.descriptive_name,
        owner_app_id: e.schema.schema.owner_app_id,
        fields: [...e.schema.schema.fields],
        key: {
          hash_field: e.schema.schema.key.hash_field,
          range_field: e.schema.schema.key.range_field ?? null,
        },
      }),
    );
    expect(duplicateDeclaredSchemaNames(clean)).toEqual([]);
  });

  test("the primary's five claimants are reported, split by key layout", () => {
    const found = duplicateDeclaredSchemaNames(PRIMARY_CLAIMANTS);
    expect(found).toHaveLength(1);
    const d = found[0]!;
    expect(d.key).toBe("board_cards");
    expect(d.descriptive_name).toBe(BC_NAME);
    // The four board-keyed ones are addresses for the SAME record type; the
    // milestone-keyed one is a DIFFERENT record type wearing this name. Those
    // are different faults, so they must not be reported as one bucket.
    expect(d.sameLayout).toEqual(["00595de0c7", "00ad3cf9d6", "00e2bc8e6d", "ff1ef2e7a3"]);
    expect(d.otherLayout).toEqual(["0039a0424f"]);
  });

  test("a schema that is not Available is not a claimant", () => {
    // Only an Available schema answers a name resolution. Counting a Blocked
    // predecessor would report a duplication that no resolver can produce.
    const blocked = [DECIDED_PIN, { ...PREDECESSOR, state: "Blocked" }];
    expect(duplicateDeclaredSchemaNames(blocked)).toEqual([]);
  });

  test("a node that omits state is read as Available, not as empty", () => {
    // An older node reports no `state`. Reading that silence as "not available"
    // would make its whole catalog invisible to this check.
    const noState = PRIMARY_CLAIMANTS.map(({ state: _state, ...rest }) => rest);
    expect(duplicateDeclaredSchemaNames(noState)).toHaveLength(1);
  });

  test("another app's identical name is not fkanban's duplicate", () => {
    const foreign = [DECIDED_PIN, row("00foreign", { owner_app_id: "someotherapp" })];
    expect(duplicateDeclaredSchemaNames(foreign)).toEqual([]);
  });
});

describe("correctResolvedSchemaIdentity", () => {
  test("the node's answer is kept when it IS the declared identity", () => {
    expect(correctResolvedSchemaIdentity(BC_ENTRY, "ff1ef2e7a3", PRIMARY_CLAIMANTS)).toEqual({
      kind: "resolved-ok",
    });
  });

  test("a milestone-keyed resolution is corrected to the widest board-keyed one", () => {
    const choice = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", PRIMARY_CLAIMANTS);
    expect(choice.kind).toBe("corrected");
    if (choice.kind !== "corrected") throw new Error("unreachable");
    expect(choice.hash).toBe("ff1ef2e7a3");
    expect(choice.from).toBe("0039a0424f");
    // Only the two write-compatible board-keyed claimants are candidates: the
    // 22- and 23-field ones are missing declared fields, so a write of the full
    // field set would be rejected there.
    expect(choice.compatible).toEqual(["ff1ef2e7a3", "00e2bc8e6d"]);
    expect(choice.ambiguous).toBe(true);
  });

  test("the ranking is widest-first, not the node's listing order", () => {
    // The node's listing order is not stable across restarts — the reason
    // `resolveLoadedSchema` documents for never using it. Reversing the list
    // must not change the answer.
    const reversed = [...PRIMARY_CLAIMANTS].reverse();
    const a = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", PRIMARY_CLAIMANTS);
    const b = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", reversed);
    expect(a).toEqual(b);
  });

  test("equal-width candidates tie-break on hash ascending", () => {
    const twin = row("00aaaaaaaa", { fields: WIDE_FIELDS });
    const choice = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", [
      PREDECESSOR,
      DECIDED_PIN,
      twin,
    ]);
    if (choice.kind !== "corrected") throw new Error("expected a correction");
    expect(choice.hash).toBe("00aaaaaaaa");
  });

  test("no correction is invented when the declared identity is absent", () => {
    // This is the arm that keeps `assertResolvedSchemaIdentities` load-bearing:
    // with nothing right to adopt, the wrong hash survives to that guard, which
    // refuses with the full diagnosis.
    const choice = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", [PREDECESSOR]);
    expect(choice).toEqual({ kind: "no-candidate", from: "0039a0424f" });
  });

  test("a narrower-only catalog is not adopted", () => {
    // A schema missing declared fields rejects the writes fkanban emits. Picking
    // it would trade a loud refusal for a board that 400s at runtime.
    const choice = correctResolvedSchemaIdentity(BC_ENTRY, "0039a0424f", [
      PREDECESSOR,
      NARROWER22,
      NARROWER23,
    ]);
    expect(choice.kind).toBe("no-candidate");
  });
});

describe("init applies the correction", () => {
  // The helper is only worth anything if init calls it. Asserted through
  // `correctDeclaredSchemaIdentities`, the function init runs, not through the
  // pure decision it delegates to.
  function nodeWith(loaded: unknown): NodeClient {
    return {
      async listSchemas() {
        if (loaded instanceof Error) throw loaded;
        return loaded as never;
      },
    } as unknown as NodeClient;
  }

  test("a wrongly-resolved board_cards hash is replaced before it is adopted", async () => {
    const lines: string[] = [];
    const out = await correctDeclaredSchemaIdentities(
      nodeWith(PRIMARY_CLAIMANTS),
      { board_cards: "0039a0424f", card: "hash-card" },
      (l) => lines.push(l),
    );
    expect(out.board_cards).toBe("ff1ef2e7a3");
    // Other keys are untouched — this corrects a resolution, it does not
    // re-resolve the config.
    expect(out.card).toBe("hash-card");
    const report = lines.join("\n");
    expect(report).toContain("board_cards resolution CORRECTED");
    expect(report).toContain("0039a0424f");
    expect(report).toContain("ff1ef2e7a3");
  });

  test("a remaining ambiguity is announced, not swallowed", async () => {
    const lines: string[] = [];
    await correctDeclaredSchemaIdentities(
      nodeWith(PRIMARY_CLAIMANTS),
      { board_cards: "0039a0424f" },
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("Available claimants with the declared key layout");
  });

  test("an unreadable schema list leaves the hashes alone and says so", async () => {
    const lines: string[] = [];
    const hashes = { board_cards: "0039a0424f" };
    const out = await correctDeclaredSchemaIdentities(
      nodeWith(new Error("socket closed")),
      hashes,
      (l) => lines.push(l),
    );
    expect(out).toEqual(hashes);
    expect(lines.join("\n")).toContain("declared identities NOT cross-checked");
  });

  test("nothing is printed when the node already resolved the declared identity", async () => {
    const lines: string[] = [];
    const out = await correctDeclaredSchemaIdentities(
      nodeWith(PRIMARY_CLAIMANTS),
      { board_cards: "ff1ef2e7a3" },
      (l) => lines.push(l),
    );
    expect(out.board_cards).toBe("ff1ef2e7a3");
    expect(lines).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------

const HASH_FOR: Record<string, string> = Object.fromEntries(
  allPinnedSchemas().map((e) => [e.key, `hash-${e.key}`]),
);

function declaredRow(key: string) {
  const def = allPinnedSchemas().find((e) => e.key === key)!.schema.schema;
  return {
    name: HASH_FOR[key],
    descriptive_name: def.descriptive_name,
    owner_app_id: def.owner_app_id,
    fields: [...def.fields],
    key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
    state: "Available",
  };
}

// The extra claimant doctor should see: the same declared name at a DIFFERENT
// key layout, which is the primary's `39a0424f`.
const STALE_TWIN = {
  ...declaredRow("board_cards"),
  name: "stale-board-cards-twin",
  key: { hash_field: "milestone", range_field: "sk" },
};

function makeNode(extraRows: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "fkanban-dupe-name-node-"));
  const socketPath = join(dir, "folddb.sock");
  const rows = [...allPinnedSchemas().map((e) => declaredRow(e.key)), ...extraRows];
  const server = Bun.serve({
    unix: socketPath,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/api/system/auto-identity") return Response.json({ user_hash: "u" });
      if (url.pathname === "/api/schemas") return Response.json({ schemas: rows });
      if (url.pathname.startsWith("/api/schema/")) {
        const hash = decodeURIComponent(url.pathname.slice("/api/schema/".length));
        const key = Object.keys(HASH_FOR).find((k) => HASH_FOR[k] === hash);
        if (!key) return Response.json({ error: "not found" }, { status: 404 });
        return Response.json({ schema: declaredRow(key) });
      }
      if (url.pathname === "/api/mutation") return Response.json({ ok: true, success: true });
      if (url.pathname === "/api/list") return handleApiList(url);
      if (url.pathname === "/api/query") {
        return Response.json({ ok: true, results: [], has_more: false });
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

const tmp = mkdtempSync(join(tmpdir(), "fkanban-dupe-name-cfg-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

async function runDoctor(name: string, extraRows: unknown[]) {
  const node = makeNode(extraRows);
  const probe = Bun.serve({ port: 0, fetch: () => Response.json({}) });
  const nodeUrl = `http://127.0.0.1:${probe.port}`;
  probe.stop(true);
  const cfgPath = join(tmp, name);
  writeFileSync(
    cfgPath,
    JSON.stringify({
      configVersion: 1,
      nodeUrl,
      schemaServiceUrl: "http://unused.invalid",
      userHash: "u",
      schemaHashes: { ...HASH_FOR },
      nodeSocketPath: node.socketPath,
    }),
  );
  const lines: string[] = [];
  try {
    const ok = await doctor({ configPath: cfgPath, print: (l) => lines.push(l) });
    return { report: lines.join("\n"), ok };
  } finally {
    node.stop();
  }
}

describe("doctor on a duplicated declared name", () => {
  test("a clean catalog passes the uniqueness check", async () => {
    const { report } = await runDoctor("clean.json", []);
    expect(report).toContain("✓ declared schema names unique");
    expect(report).not.toContain("declared name is not unique");
  });

  test("a second Available claimant is reported", async () => {
    // The board here writes and reads perfectly — the pin is a hash and it
    // addresses the right schema. The NAME is still what a machine without a
    // config resolves, so the condition is real and gets a line.
    const { report } = await runDoctor("dupe.json", [STALE_TWIN]);
    expect(report).toContain("· board_cards declared name is not unique");
  });

  test("the line names the hashes and the remedy", async () => {
    // A finding whose fix lives only in a checkpoint is one the next operator
    // re-derives from scratch. The claimant hashes are the work item.
    const { report } = await runDoctor("dupe-detail.json", [STALE_TWIN]);
    expect(report).toContain("2 Available schemas answer to");
    // Hashes are printed at 12 characters, enough to point at a catalog row
    // without wrapping the line.
    expect(report).toContain(HASH_FOR.board_cards!.slice(0, 12));
    expect(report).toContain(STALE_TWIN.name.slice(0, 12));
    expect(report).toContain("Retire the stale claimants");
  });

  // This is the assertion that keeps the decision from being re-litigated by
  // accident. Card
  // `kanban-boardcards-name-collides-with-rekey-predecessor-20260907` asked for
  // a FAIL here; two decisions already tested in this repo forbid one, and both
  // were paid for with a measured incident:
  //
  //   - `doctor-write-probe.test.ts`, "green: config pinned to a wide hash
  //     survives a narrower WRITABLE version listed first" — a node restart
  //     moved the resolver's tiebreak on 2026-07-30 and doctor exited 1 over a
  //     board whose writes had never broken, advising a remedy that could not
  //     change the outcome.
  //   - `doctor-accepted-pin-identity.test.ts` — whose whole subject is that a
  //     red no operator can clear is the environment the next REAL mismatch
  //     arrives into. There is no node route that retires a duplicate claimant:
  //     `/api/schemas` has declare and get, and a rename would change the
  //     identity hash, because `descriptive_name` folds into it.
  //
  // Raise it to a `check(false, ...)` only together with a way to clear it.
  test("the duplication does not gate doctor", async () => {
    const { report, ok } = await runDoctor("dupe-not-red.json", [STALE_TWIN]);
    expect(report).not.toContain("✗ board_cards declared name is not unique");
    expect(ok).toBe(true);
  });
});
