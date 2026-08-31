/**
 * `kanban init` must not silently change a schema pin.
 *
 * A schema hash is the ADDRESS of a record type. Every row fkanban wrote under
 * the old hash lives under the old hash; a config holding the new one cannot
 * see any of them, and — this is what makes it dangerous rather than merely
 * wrong — an index re-pointed this way reads exactly like an index that is
 * empty. Nothing downstream errors. No later run can tell the difference.
 *
 * Measured on an isolated node 2026-08-04: with `milestone_cards` pinned to a
 * hash other than the one Mini resolves, init rewrote it and its output never
 * mentioned the change (it prints the RESOLVED hash and never the incumbent, so
 * a move looks identical to a no-op). On the live primary, `milestone_cards` is
 * pinned to a schema the node registered under `descriptive_name: "Milestone"`,
 * while the catalog's declared name resolves to zero loaded schemas — so the
 * next unguarded init there would orphan every live MilestoneCards row.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  schemaPinMoves,
  assertNoSilentSchemaRepin,
  type SchemaPinMove,
} from "../src/commands/init.ts";
import type { Config } from "../src/config.ts";

function cfg(hashes: Record<string, string>): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://127.0.0.1",
    schemaServiceUrl: "https://schema.example",
    userHash: "u",
    schemaHashes: hashes,
  } as unknown as Config;
}

describe("schemaPinMoves", () => {
  test("a changed hash on an EXISTING pin is a move", () => {
    const moves = schemaPinMoves(cfg({ milestone_cards: "old" }), { milestone_cards: "new" });
    expect(moves).toEqual([{ key: "milestone_cards", from: "old", to: "new" }]);
  });

  test("an unchanged hash is not a move", () => {
    expect(schemaPinMoves(cfg({ card: "same" }), { card: "same" })).toEqual([]);
  });

  test("a first declaration is not a move", () => {
    // No incumbent — the normal path on a fresh node and on a newly added
    // catalog entry. Treating this as a move would make first-run init refuse.
    expect(schemaPinMoves(cfg({}), { milestone_cards: "new" })).toEqual([]);
    expect(schemaPinMoves(cfg({ milestone_cards: "" }), { milestone_cards: "new" })).toEqual([]);
  });

  test("no existing config at all is not a move", () => {
    expect(schemaPinMoves(null, { card: "new" })).toEqual([]);
  });

  test("moves are reported for INDEX schemas, not just record types", () => {
    // The five EXTRA_SCHEMAS are exactly the ones doctor's identity check and
    // init's write probe cannot run on (`resolveLoadedSchema`/`probeSchemaWritable`
    // are keyed on RecordType). If this guard shared that blind spot it would
    // miss the only pin known to be at risk on the live primary.
    const moves = schemaPinMoves(
      cfg({ card: "c", board_cards: "bc-old", board_milestones: "bm", milestone_cards: "mc-old" }),
      { card: "c", board_cards: "bc-new", board_milestones: "bm", milestone_cards: "mc-new" },
    );
    expect(moves.map((m) => m.key).sort()).toEqual(["board_cards", "milestone_cards"]);
  });
});

describe("assertNoSilentSchemaRepin", () => {
  const moves: SchemaPinMove[] = [{ key: "milestone_cards", from: "69e76079", to: "511b23e9" }];

  test("refuses a move, and names the schema and both hashes", () => {
    let err: unknown;
    try {
      assertNoSilentSchemaRepin({ moves, accepted: false, configPath: "/tmp/c.json" });
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    const msg = String((err as { message?: string }).message ?? "");
    expect((err as { code?: string }).code).toBe("schema_pin_would_move");
    // An operator who cannot see WHICH pin moved and WHERE cannot act on this.
    expect(msg).toContain("milestone_cards");
    expect(msg).toContain("69e76079");
    expect(msg).toContain("511b23e9");
  });

  test("the refusal states that config was left untouched", () => {
    // The remedy is a data migration, not a retry. An operator who reads this
    // as "init failed, run it again" is one --force away from the data loss.
    try {
      assertNoSilentSchemaRepin({ moves, accepted: false, configPath: "/tmp/c.json" });
      throw new Error("expected a refusal");
    } catch (e) {
      const hint = String((e as { hint?: string }).hint ?? "");
      expect(hint).toContain("left untouched");
      expect(hint).toContain("--accept-schema-repin");
    }
  });

  test("allows the move when the operator accepted it", () => {
    expect(() =>
      assertNoSilentSchemaRepin({ moves, accepted: true, configPath: "/tmp/c.json" }),
    ).not.toThrow();
  });

  test("allows an init with no moves", () => {
    expect(() =>
      assertNoSilentSchemaRepin({ moves: [], accepted: false, configPath: "/tmp/c.json" }),
    ).not.toThrow();
  });
});

// Everything above passes with the guard sitting in the file UNCALLED — the
// shape this codebase keeps finding in its own checks. Pin the wiring at the
// only two places it exists.
describe("the repin guard is wired into the init path", () => {
  const init = readFileSync(new URL("../src/commands/init.ts", import.meta.url), "utf8");
  const cli = readFileSync(new URL("../src/cli.ts", import.meta.url), "utf8");

  test("runInit computes the moves and asserts on them", () => {
    expect(init).toContain("schemaPinMoves(existing, schemaHashes)");
    expect(init).toContain("assertNoSilentSchemaRepin({");
  });

  test("the guard runs BEFORE config is written", () => {
    // Order is the whole property. A guard that fires after `writeConfig` has
    // already replaced the pins reports a loss it just caused.
    const guardAt = init.indexOf("assertNoSilentSchemaRepin({");
    const writeAt = init.indexOf("writeConfig(config, configPath)");
    expect(guardAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(guardAt).toBeLessThan(writeAt);
  });

  test("the write probe still gets first say when a hash is BOTH a move and unwritable", () => {
    // Both guards refuse and both leave config untouched, so ordering decides
    // only which diagnosis is printed — and "the node will not accept these
    // fields, here are the missing ones" (fkanban #94) beats "the pin moved".
    // `test/init-write-probe-guard.test.ts` asserts the resulting code; this
    // pins the ordering that produces it, which that test cannot see.
    const probeAt = init.indexOf(`code: "schema_not_writable"`);
    const guardAt = init.indexOf("assertNoSilentSchemaRepin({");
    expect(probeAt).toBeGreaterThan(-1);
    expect(probeAt).toBeLessThan(guardAt);
  });

  test("the CLI flag reaches runInit and is an accepted init flag", () => {
    // Declared in parse + forwarded + allow-listed. Miss the allow-list and the
    // flag is rejected as unknown; miss the forward and it silently does nothing
    // — which for THIS flag means init refuses forever with no way to proceed.
    expect(cli).toContain(`"accept-schema-repin": { type: "boolean" }`);
    expect(cli).toContain(`acceptSchemaRepin: values["accept-schema-repin"] === true`);
    expect(cli).toContain(`"accept-schema-repin"]`);
  });
});
