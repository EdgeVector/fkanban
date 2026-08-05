/**
 * A schema hash is the ADDRESS of a record type, and nothing downstream checks
 * that the address belongs to the type fkanban thinks it does.
 *
 * `resolveLoadedSchema` and `probeSchemaWritable` both read `RECORDS[type]`, so
 * neither can be CALLED for the four `EXTRA_SCHEMAS` — `card_list_index`,
 * `board_cards`, `board_milestones`, `milestone_cards`. Those four are the
 * membership/projection indexes, i.e. the exact surface that has needed repair.
 * They had no identity check at all, while doctor printed key-layout and parity
 * lines over them that read as coverage.
 *
 * Live consequence, measured on the primary 2026-08-04: config pins
 * `milestone_cards` to a hash the node has registered under `descriptive_name:
 * "Milestone"` — the Hash entity, not the HashRange membership index. Partition
 * reads on a milestone slug return the Milestone record with `range` coerced to
 * `""`. That is the "phantom row" three runs spent time on, and no check in the
 * codebase could see it, because every check asked what the pinned schema LOOKS
 * LIKE and none asked WHICH schema it is.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import {
  EXTRA_SCHEMAS,
  UNIQUE_SCHEMAS,
  allPinnedSchemas,
  cardSchema,
  checkPinnedSchemaIdentity,
  formatSchemaIdentityMismatch,
  boardCardsSchema,
  milestoneCardsSchema,
  milestoneSchema,
  type LoadedSchemaCandidate,
} from "../src/schemas.ts";
import { assertResolvedSchemaIdentities } from "../src/commands/init.ts";
import type { NodeClient } from "../src/client.ts";

// A loaded-schema row shaped the way `/api/schemas` reports one.
function loadedFrom(
  hash: string,
  def: { owner_app_id: string; descriptive_name: string; fields: string[]; key: { hash_field: string; range_field?: string } },
): LoadedSchemaCandidate {
  return {
    name: hash,
    descriptive_name: def.descriptive_name,
    owner_app_id: def.owner_app_id,
    fields: [...def.fields],
    key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
  };
}

// Catalog entries as `allPinnedSchemas()` yields them — the check reads the
// config key off the entry to find its multi-key-expand allowance.
const MC_ENTRY = { key: "milestone_cards", schema: milestoneCardsSchema };
const MS_ENTRY = { key: "milestone", schema: milestoneSchema };
const CARD_ENTRY = { key: "card", schema: cardSchema };
const BC_ENTRY = { key: "board_cards", schema: boardCardsSchema };

const MILESTONE_ROW = loadedFrom("614cmilestone", milestoneSchema.schema);
const MILESTONE_CARDS_ROW = loadedFrom("511bmilestonecards", milestoneCardsSchema.schema);

// The live primary's row: the MilestoneCards FIELD/KEY SET registered under the
// entity's `descriptive_name`. Reproduced on an isolated node 2026-08-04 and it
// produced the phantom lead-for-lead.
const MISPINNED_ROW: LoadedSchemaCandidate = {
  ...loadedFrom("69e76079", milestoneCardsSchema.schema),
  descriptive_name: "Milestone",
};

describe("checkPinnedSchemaIdentity", () => {
  test("the declared schema at its own hash is ok", () => {
    expect(
      checkPinnedSchemaIdentity(MC_ENTRY, "511bmilestonecards", [
        MILESTONE_ROW,
        MILESTONE_CARDS_ROW,
      ]),
    ).toEqual({ kind: "ok" });
  });

  test("the primary's mispinned milestone_cards is a descriptive_name mismatch", () => {
    // The whole point. Field set matches, key layout matches, every parity and
    // key-layout check in the codebase passes — and the pin still addresses
    // another record type.
    const check = checkPinnedSchemaIdentity(MC_ENTRY, "69e76079", [MISPINNED_ROW]);
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") throw new Error("unreachable");
    expect(check.loadedDescriptiveName).toBe("Milestone");
    expect(check.mismatches.map((m) => m.what)).toEqual(["descriptive_name"]);
    const rendered = formatSchemaIdentityMismatch(check);
    expect(rendered).toContain("MilestoneCards_hashrange_v1_children_20260723");
    expect(rendered).toContain("Milestone");
  });

  test("a Hash entity pinned where a HashRange index belongs mismatches on BOTH axes", () => {
    // `milestone_cards` pointed at the real Milestone entity: wrong name AND
    // wrong key layout. Reported together so the operator sees the whole fault.
    const check = checkPinnedSchemaIdentity(MC_ENTRY, "614cmilestone", [MILESTONE_ROW]);
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") throw new Error("unreachable");
    expect(check.mismatches.map((m) => m.what).sort()).toEqual(["descriptive_name", "key"]);
    const rendered = formatSchemaIdentityMismatch(check);
    expect(rendered).toContain("HashRange(milestone, sk)");
    expect(rendered).toContain("Hash(slug)");
  });

  test("another app's schema at our hash is a mismatch", () => {
    const foreign = { ...MILESTONE_CARDS_ROW, owner_app_id: "someone_else" };
    const check = checkPinnedSchemaIdentity(MC_ENTRY, "511bmilestonecards", [foreign]);
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") throw new Error("unreachable");
    expect(check.mismatches.map((m) => m.what)).toEqual(["owner_app_id"]);
  });

  test("a node that does not report a key layout is unknown, NOT mismatched", () => {
    // Older nodes omit `key`. Turning every pin red on them would make the
    // check unusable exactly where an operator most needs the rest of doctor —
    // and it is the same rule the resolver's candidate filter already uses.
    const noKey: LoadedSchemaCandidate = { ...MILESTONE_CARDS_ROW, key: null };
    expect(checkPinnedSchemaIdentity(MC_ENTRY, "511bmilestonecards", [noKey])).toEqual({
      kind: "ok",
    });
  });

  test("the live multi-key expand is the DESIGNED state, not a crossed identity", () => {
    // Measured on the primary 2026-08-04: `board_cards` is pinned to a schema
    // the catalog reports as `HashRange(milestone, sk)` — because the 2026-07-23
    // expand bound both lookups to one schema and the catalog reports whichever
    // key was declared last. `HashKey=default` still returns every board row.
    //
    // A first cut of this check flagged it, which is the exact false red doctor
    // was already taught out of once (`alsoAccepts`). Two independent opinions
    // about which key layouts are legal is how one check calls the designed
    // state a poisoning while its neighbour passes it.
    const expanded: LoadedSchemaCandidate = {
      ...loadedFrom("39a0boardcards", boardCardsSchema.schema),
      key: { hash_field: "milestone", range_field: "sk" },
    };
    expect(checkPinnedSchemaIdentity(BC_ENTRY, "39a0boardcards", [expanded])).toEqual({ kind: "ok" });
  });

  test("a hash field belonging to NEITHER lookup is still a mismatch", () => {
    // The allowance is the sibling key, not "any key". Widening it to anything
    // would retire the check.
    const poisoned: LoadedSchemaCandidate = {
      ...loadedFrom("39a0boardcards", boardCardsSchema.schema),
      key: { hash_field: "assignee", range_field: "sk" },
    };
    const check = checkPinnedSchemaIdentity(BC_ENTRY, "39a0boardcards", [poisoned]);
    expect(check.kind).toBe("mismatch");
  });

  test("range_field is compared strictly even where hash_field is not", () => {
    // `range_field` is what separates a Hash ENTITY from a HashRange INDEX over
    // that same entity — the confusion the whole check exists to catch. The
    // multi-key allowance must not leak onto this axis.
    const asEntity: LoadedSchemaCandidate = {
      ...loadedFrom("39a0boardcards", boardCardsSchema.schema),
      key: { hash_field: "milestone", range_field: null },
    };
    const check = checkPinnedSchemaIdentity(BC_ENTRY, "39a0boardcards", [asEntity]);
    expect(check.kind).toBe("mismatch");
    if (check.kind !== "mismatch") throw new Error("unreachable");
    expect(check.mismatches.map((m) => m.what)).toContain("key");
  });

  test("identity does not depend on the field set", () => {
    // Deliberately NOT a field check: that is `resolveLoadedSchema`'s job and it
    // answers a different question. A narrower-but-correctly-identified schema
    // is a version problem, not a crossed address, and must not be reported as
    // one — conflating them would make the write-probe diagnosis unreachable.
    const narrow: LoadedSchemaCandidate = { ...loadedFrom("614cmilestone", milestoneSchema.schema), fields: ["slug"] };
    expect(checkPinnedSchemaIdentity(MS_ENTRY, "614cmilestone", [narrow])).toEqual({ kind: "ok" });
  });

  test("an unloaded hash and an unset hash are distinguished from a mismatch", () => {
    expect(checkPinnedSchemaIdentity(CARD_ENTRY, "nosuchhash", [MILESTONE_ROW])).toEqual({
      kind: "not_loaded",
    });
    expect(checkPinnedSchemaIdentity(CARD_ENTRY, undefined, [MILESTONE_ROW])).toEqual({
      kind: "unset",
    });
  });
});

describe("allPinnedSchemas", () => {
  test("covers all seven config keys — the three record types AND the four indexes", () => {
    const keys = allPinnedSchemas().map((e) => e.key);
    expect(keys.length).toBe(UNIQUE_SCHEMAS.length + EXTRA_SCHEMAS.length);
    for (const k of ["card", "board", "milestone", "card_list_index", "board_cards", "board_milestones", "milestone_cards"]) {
      expect(keys).toContain(k);
    }
  });
});

// A node client that answers exactly one question.
function fakeNode(loaded: LoadedSchemaCandidate[] | Error): NodeClient {
  return {
    async listSchemas() {
      if (loaded instanceof Error) throw loaded;
      return loaded as never;
    },
  } as unknown as NodeClient;
}

describe("init refuses to adopt a crossed identity", () => {
  const goodHashes = { milestone: "614cmilestone", milestone_cards: "511bmilestonecards" };

  test("adopts hashes whose identities check out", async () => {
    const lines: string[] = [];
    await assertResolvedSchemaIdentities(
      fakeNode([MILESTONE_ROW, MILESTONE_CARDS_ROW]),
      goodHashes,
      (l) => lines.push(l),
    );
    expect(lines).toEqual([]);
  });

  test("refuses the primary's crossed milestone_cards pin, naming the schema it actually is", async () => {
    let err: unknown;
    try {
      await assertResolvedSchemaIdentities(
        fakeNode([MISPINNED_ROW]),
        { milestone_cards: "69e76079" },
        () => {},
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeDefined();
    expect((err as { code?: string }).code).toBe("schema_identity_crossed");
    const msg = String((err as { message?: string }).message ?? "");
    expect(msg).toContain("milestone_cards");
    expect(msg).toContain("69e76079");
    expect(msg).toContain("Milestone");
    // The remedy is a catalog repair, not a retry — and the config must still
    // be usable, because the board is reading and writing fine through the pin
    // it already has.
    const hint = String((err as { hint?: string }).hint ?? "");
    expect(hint).toContain("left untouched");
  });

  test("an unreadable schema list says so instead of passing quietly", async () => {
    // The waiver that CAN be read. A socket-only control plane genuinely cannot
    // be checked; a check that returns silently in that case is indistinguishable
    // from one that verified something, which is the shape this codebase keeps
    // finding in its own guards.
    const lines: string[] = [];
    await assertResolvedSchemaIdentities(
      fakeNode(new Error("control plane unavailable")),
      goodHashes,
      (l) => lines.push(l),
    );
    expect(lines.join("\n")).toContain("NOT verified");
  });

  test("an unset or not-yet-loaded hash is not a crossed identity", async () => {
    // First-run init: nothing is loaded yet and the write probe owns that case.
    // Refusing here would make a fresh init impossible.
    await assertResolvedSchemaIdentities(fakeNode([]), goodHashes, () => {});
    await assertResolvedSchemaIdentities(fakeNode([MILESTONE_ROW]), {}, () => {});
  });
});

// Every unit test above passes with both call sites deleted. Pin the wiring.
describe("the identity check is wired into init and doctor", () => {
  const init = readFileSync(new URL("../src/commands/init.ts", import.meta.url), "utf8");
  const doctor = readFileSync(new URL("../src/commands/doctor.ts", import.meta.url), "utf8");

  // Offset of the first LIVE occurrence — an occurrence inside a `//` comment
  // does not count. Written after a plain `indexOf` version of these tests
  // stayed green against a build whose only call site was commented out: a
  // wiring test that a comment satisfies is not a wiring test.
  function liveIndexOf(src: string, needle: string): number {
    let from = 0;
    for (;;) {
      const at = src.indexOf(needle, from);
      if (at === -1) return -1;
      const lineStart = src.lastIndexOf("\n", at) + 1;
      if (!src.slice(lineStart, at).trimStart().startsWith("//")) return at;
      from = at + needle.length;
    }
  }

  test("the comment-blind guard in these wiring tests actually works", () => {
    expect(liveIndexOf("// x = call()\nx = call()\n", "call()")).toBe(18);
    expect(liveIndexOf("  // only a comment mentions call()\n", "call()")).toBe(-1);
  });

  test("runInit calls it, and BEFORE config is written", () => {
    const callAt = liveIndexOf(init, "await assertResolvedSchemaIdentities(node, schemaHashes, print)");
    const writeAt = liveIndexOf(init, "writeConfig(config, configPath)");
    expect(callAt).toBeGreaterThan(-1);
    expect(writeAt).toBeGreaterThan(-1);
    expect(callAt).toBeLessThan(writeAt);
  });

  test("it runs BEFORE the repin guard, which has an operator override it must not inherit", () => {
    // `--accept-schema-repin` means "yes, re-point this pin". It has never meant
    // "yes, point it at a different record type", and an operator clearing the
    // move guard must still hit this one.
    const identityAt = liveIndexOf(init, "await assertResolvedSchemaIdentities(");
    const repinAt = liveIndexOf(init, "assertNoSilentSchemaRepin({");
    expect(identityAt).toBeGreaterThan(-1);
    expect(repinAt).toBeGreaterThan(-1);
    expect(identityAt).toBeLessThan(repinAt);
  });

  test("doctor checks every pinned key, not the three it can resolve", () => {
    // The failure being repaired: doctor's schema loop iterates UNIQUE_SCHEMAS,
    // so the four index pins got no identity check while three key-layout and
    // parity lines printed green above them.
    expect(doctor).toContain("for (const entry of allPinnedSchemas())");
    expect(doctor).toContain("checkPinnedSchemaIdentity(entry, configHash, loaded)");
  });

  test("doctor reports a crossed identity as a FAILURE, not an info line", () => {
    // A pin that addresses another record type makes an index read as empty.
    // That is a red — `info(` never flips doctor's exit code, and this block
    // does use `info(` for the unpinned-index case, so assert the MISMATCH
    // branch specifically rather than the absence of `info(` anywhere in it.
    //
    // This asserted the ordering "the first thing the mismatch branch reaches
    // for is `check(false, …)`" until 2026-08-05, when the branch gained an
    // acknowledgement gate ahead of it (`acceptedSchemaPinIdentities`). That
    // gate is why the ordering form no longer holds and must not simply be
    // relaxed: the invariant it stood for — an UNACKNOWLEDGED crossed identity
    // is a red — is unchanged, so it is asserted directly instead.
    //
    // The behavioural counterpart, which runs doctor against a node reproducing
    // the primary's mispin and asserts on the exit code rather than the source
    // text, is `test/doctor-accepted-pin-identity.test.ts`. Kept here too
    // because a source-shape check catches an `info(` that a behavioural test
    // would only catch if someone remembered to write the matching case.
    const block = doctor.slice(
      doctor.indexOf("for (const entry of allPinnedSchemas())"),
      doctor.indexOf("for (const entry of UNIQUE_SCHEMAS)"),
    );
    const branchAt = block.indexOf(`identity.kind === "mismatch"`);
    expect(branchAt).toBeGreaterThan(-1);
    const afterBranch = block.slice(branchAt);

    // The red path exists and is a `check(false, …)`, not an info line.
    expect(afterBranch).toMatch(/check\(\s*false,/);

    // Every `info(` in this branch is downstream of the acknowledgement gate.
    // Without this, "make the mismatch an info line" — the exact regression the
    // original test was written to stop — passes again by deleting the gate's
    // condition and keeping its `info(`.
    const gateAt = afterBranch.indexOf("isAcceptedPinDeviation(");
    expect(gateAt).toBeGreaterThan(-1);
    expect(afterBranch.indexOf("info(")).toBeGreaterThan(gateAt);
  });

  test("an unpinned index is an info line, not a red", () => {
    // `boardCardsHash` returns null when unset and its callers fall back to the
    // unindexed path — a supported degraded mode. A doctor that hard-fails on an
    // optional feature being off is a doctor operators learn to ignore.
    const block = doctor.slice(
      doctor.indexOf("for (const entry of allPinnedSchemas())"),
      doctor.indexOf("for (const entry of UNIQUE_SCHEMAS)"),
    );
    const unsetAt = block.indexOf(`identity.kind === "unset"`);
    expect(unsetAt).toBeGreaterThan(-1);
    expect(block.slice(unsetAt)).toContain("info(");
  });
});
