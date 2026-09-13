/**
 * Fresh-install identity resolution: what a node with NO config hands back.
 *
 * Card `kanban-catalog-boardcards-resolves-milestone-hash-on-fresh-install-20260913`
 * asked whether the `BoardCards_hashrange_v1` catalog entry resolves to a
 * milestone-keyed hash on a fresh install. Measured 2026-09-13 on a fresh HOME
 * against host daemon 0.23.3-1908 and prod Schema Service: it does not. The
 * entry declares HashRange(board, sk) and the node returned `e2bc8e6d`
 * (board/sk). The milestone-keyed `39a0424f` only reaches a daemon that hashes
 * the proposal without its key (public bottle 0.23.3), and that is a node
 * defect fold PR 1993 already guards; fkanban's refusal there is correct.
 *
 * The same probe exposed two things a fresh node lists that no existing
 * install ever showed `init`, both pinned here:
 *
 *   1. `/api/schemas` carries a local ALIAS row `fkanban/<Name>` beside the
 *      hash-named identity. It matches every name/key filter, and the identity
 *      correction adopted it: config read `"milestone": "fkanban/Milestone"`.
 *   2. Schema Service de-collides a colliding descriptive_name to
 *      `"<name> (<Type>)"`. `Milestone` registered as `Milestone (Hash)`, the
 *      exact-string name check called the node's own answer a mismatch, and
 *      that is what pushed `init` onto the alias in (1).
 */
import { describe, expect, test } from "bun:test";

import {
  boardCardsSchema,
  boardMilestonesSchema,
  checkPinnedSchemaIdentity,
  correctResolvedSchemaIdentity,
  descriptiveNameMatches,
  duplicateDeclaredSchemaNames,
  isCatalogHashName,
  milestoneSchema,
  resolveLoadedSchema,
  stripDecollisionSuffix,
  type LoadedSchemaCandidate,
} from "../src/schemas.ts";

const MS_ENTRY = { key: "milestone", schema: milestoneSchema };
const MS_DEF = milestoneSchema.schema;
const BM_ENTRY = { key: "board_milestones", schema: boardMilestonesSchema };
const BM_DEF = boardMilestonesSchema.schema;
const BC_ENTRY = { key: "board_cards", schema: boardCardsSchema };
const BC_DEF = boardCardsSchema.schema;

function row(
  def: typeof MS_DEF,
  name: string,
  over: Partial<LoadedSchemaCandidate> = {},
): LoadedSchemaCandidate {
  return {
    name,
    descriptive_name: def.descriptive_name,
    owner_app_id: def.owner_app_id,
    fields: [...def.fields],
    key: { hash_field: def.key.hash_field, range_field: def.key.range_field ?? null },
    state: "Available",
    ...over,
  };
}

// The rows the fresh node listed for `Milestone` on 2026-09-13 (hashes
// shortened): the node's declare answered `a18925aa`, registered under the
// de-collided name; the alias row carries the plain name and a DIFFERENT
// identity.
const MS_REGISTERED = row(MS_DEF, "a18925aac7c0de83", { descriptive_name: "Milestone (Hash)" });
const MS_ALIAS = row(MS_DEF, "fkanban/Milestone");

const BM_REGISTERED = row(BM_DEF, "6d25e6825485638e", {
  descriptive_name: "FkanbanMilestonePortfolioByBoardIndex (HashRange)",
});
const BM_ALIAS = row(BM_DEF, "fkanban/BoardMilestones");

describe("stripDecollisionSuffix", () => {
  test("strips Schema Service's `<name> (<Type>)` and `<name> (<Type> N)` grammar", () => {
    expect(stripDecollisionSuffix("Milestone (Hash)")).toBe("Milestone");
    expect(stripDecollisionSuffix("Milestone (HashRange)")).toBe("Milestone");
    expect(stripDecollisionSuffix("Milestone (Range 2)")).toBe("Milestone");
    expect(stripDecollisionSuffix("Contacts (Single)")).toBe("Contacts");
  });

  test("leaves any other trailing parenthetical alone", () => {
    expect(stripDecollisionSuffix("Milestone")).toBe("Milestone");
    expect(stripDecollisionSuffix("Milestone (legacy)")).toBe("Milestone (legacy)");
    expect(stripDecollisionSuffix("Milestone (Hash legacy)")).toBe("Milestone (Hash legacy)");
    expect(stripDecollisionSuffix("Milestone (Hash 2 3)")).toBe("Milestone (Hash 2 3)");
    expect(stripDecollisionSuffix("Milestone(Hash)")).toBe("Milestone(Hash)");
  });

  test("descriptiveNameMatches accepts the de-collided form of the declared name only", () => {
    expect(descriptiveNameMatches("Milestone", "Milestone")).toBe(true);
    expect(descriptiveNameMatches("Milestone", "Milestone (Hash)")).toBe(true);
    expect(descriptiveNameMatches("Milestone", "Milestone (legacy)")).toBe(false);
    expect(descriptiveNameMatches("Milestone", "Card (Hash)")).toBe(false);
    // The declared name is never stripped: a declaration IS its exact string.
    expect(descriptiveNameMatches("Milestone (Hash)", "Milestone")).toBe(false);
  });
});

describe("isCatalogHashName", () => {
  test("a local alias `<app>/<Name>` is not a catalog identity", () => {
    expect(isCatalogHashName("fkanban/Milestone")).toBe(false);
    expect(isCatalogHashName("")).toBe(false);
    expect(isCatalogHashName("a18925aac7c0de839cc3d4c5bcd975770aa5064b0ddb48ae8f8b5812c867d47e")).toBe(
      true,
    );
  });
});

describe("checkPinnedSchemaIdentity on a de-collided registration", () => {
  test("the node's own de-collided answer IS the declared identity", () => {
    expect(checkPinnedSchemaIdentity(MS_ENTRY, MS_REGISTERED.name, [MS_REGISTERED, MS_ALIAS])).toEqual(
      { kind: "ok" },
    );
    expect(checkPinnedSchemaIdentity(BM_ENTRY, BM_REGISTERED.name, [BM_REGISTERED, BM_ALIAS])).toEqual(
      { kind: "ok" },
    );
  });

  test("a de-collided name still does not waive the key layout", () => {
    // `Milestone (HashRange)` with key milestone/sk exists on the primary. It
    // answers to the name after stripping, and it is still the wrong record
    // type for the `milestone` entity pin.
    const wrongType = row(MS_DEF, "aad5769510c052a1", {
      descriptive_name: "Milestone (HashRange)",
      key: { hash_field: "milestone", range_field: "sk" },
    });
    const check = checkPinnedSchemaIdentity(MS_ENTRY, wrongType.name, [wrongType]);
    expect(check.kind).toBe("mismatch");
    expect(check.kind === "mismatch" && check.mismatches.map((m) => m.what)).toEqual(["key"]);
  });
});

describe("correctResolvedSchemaIdentity on a fresh node", () => {
  test("keeps the node's de-collided registration instead of moving onto the alias", () => {
    expect(correctResolvedSchemaIdentity(MS_ENTRY, MS_REGISTERED.name, [MS_ALIAS, MS_REGISTERED])).toEqual(
      { kind: "resolved-ok" },
    );
    expect(correctResolvedSchemaIdentity(BM_ENTRY, BM_REGISTERED.name, [BM_ALIAS, BM_REGISTERED])).toEqual(
      { kind: "resolved-ok" },
    );
  });

  test("never adopts an alias row, even when it is the only name match", () => {
    // The node answered something that is not the declared identity and the
    // only loaded row wearing the plain name is the alias. The alias is not a
    // pin; the identity guard refuses downstream (`no-candidate`), which is
    // loud and correct. Adopting the alias would pass the write probe and
    // pin config to a string that is not a catalog hash.
    const other = row(MS_DEF, "0000000000000000", { descriptive_name: "Something Else" });
    expect(correctResolvedSchemaIdentity(MS_ENTRY, other.name, [MS_ALIAS, other])).toEqual({
      kind: "no-candidate",
      from: other.name,
    });
  });

  test("a hash-named claimant with the declared identity is still adopted over a wrong answer", () => {
    const declared = row(MS_DEF, "614c4f47ab8c3af8");
    const other = row(MS_DEF, "0000000000000000", { descriptive_name: "Something Else" });
    const choice = correctResolvedSchemaIdentity(MS_ENTRY, other.name, [MS_ALIAS, declared, other]);
    expect(choice.kind).toBe("corrected");
    expect(choice.kind === "corrected" && choice.hash).toBe(declared.name);
    expect(choice.kind === "corrected" && choice.compatible).toEqual([declared.name]);
  });
});

describe("resolveLoadedSchema on a fresh node", () => {
  test("resolves to the hash-named identity, never the alias", () => {
    const r = resolveLoadedSchema("milestone", [MS_ALIAS, MS_REGISTERED]);
    expect(r.kind === "ok" && r.hash).toBe(MS_REGISTERED.name);
    expect(r.kind === "ok" && r.compatible).toEqual([MS_REGISTERED.name]);
    expect(r.kind === "ok" && r.ambiguous).toBe(false);
  });

  test("an alias alone is `missing`, not a pin", () => {
    expect(resolveLoadedSchema("milestone", [MS_ALIAS])).toEqual({ kind: "missing" });
  });
});

describe("duplicateDeclaredSchemaNames on a fresh node", () => {
  test("the alias row is a second address, not a second claimant", () => {
    const bc = row(BC_DEF, "e2bc8e6d4b0f63b2");
    const bcAlias = row(BC_DEF, "fkanban/BoardCards");
    expect(duplicateDeclaredSchemaNames([bc, bcAlias, MS_REGISTERED, MS_ALIAS])).toEqual([]);
  });
});

describe("the BoardCards catalog entry (the card's literal claim)", () => {
  test("declares the board-keyed layout, and a milestone-keyed claimant is never adopted", () => {
    expect(BC_DEF.descriptive_name).toBe("BoardCards_hashrange_v1");
    expect(BC_DEF.schema_type).toBe("HashRange");
    expect(BC_DEF.key).toEqual({ hash_field: "board", range_field: "sk" });

    // What the public bottle's daemon hands a fresh install: the no-key hash,
    // stamped milestone/sk. With nothing board-keyed loaded there is nothing
    // to correct to, and `init` refuses — that refusal is the guard this card
    // is told not to loosen.
    const predecessor = row(BC_DEF, "39a0424fa08536a6", {
      key: { hash_field: "milestone", range_field: "sk" },
    });
    expect(checkPinnedSchemaIdentity(BC_ENTRY, predecessor.name, [predecessor]).kind).toBe("mismatch");
    expect(correctResolvedSchemaIdentity(BC_ENTRY, predecessor.name, [predecessor])).toEqual({
      kind: "no-candidate",
      from: predecessor.name,
    });

    // What the current daemon hands it: the keyed hash, board/sk. Nothing to
    // correct.
    const keyed = row(BC_DEF, "e2bc8e6d4b0f63b2");
    expect(correctResolvedSchemaIdentity(BC_ENTRY, keyed.name, [predecessor, keyed])).toEqual({
      kind: "resolved-ok",
    });
  });
});
