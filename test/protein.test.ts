/**
 * Honest protein multi-key tests.
 *
 * These drive the shipped writeMembershipViaProtein entry point against a
 * NodeClient fake that implements the real protein + query surfaces used on
 * Mini. The coherence gate must fail closed: usedProtein=true only when
 * BoardCards and MilestoneCards partitions agree on shared fields.
 */
import { describe, expect, test, beforeEach } from "bun:test";
import { createHash } from "node:crypto";
import type { NodeClient, QueryFilter, QueryResponse, QueryRow, RawResponse } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import {
  moleculeUuid,
  membershipPartitionsAgree,
  proteinAvailable,
  dualWriteFallbackEnabled,
  ProteinMembershipError,
  applyMembershipAfterProtein,
  PROTEIN_SCHEMA_MARKER,
  resetProteinCaches,
  SHARED_COHERENCE_FIELDS,
  writeMembershipViaProtein,
} from "../src/protein.ts";
import { BOARD_CARDS_LAYOUT, MILESTONE_CARDS_LAYOUT, BOARD_CARDS_FIELDS, MILESTONE_CARDS_FIELDS } from "../src/schemas.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";
import { boardCardSk } from "../src/board-cards.ts";

const BOARD_HASH = "board-cards-test-hash";
const MS_HASH = "milestone-cards-test-hash";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    board_cards: BOARD_HASH,
    milestone_cards: MS_HASH,
  },
};

function mol(schema: string, field: string): string {
  return createHash("sha256").update(`${schema}:${field}`).digest("hex");
}

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "protein-card",
    title: "Protein card",
    body: "body not on thin index",
    board: "default",
    column: "todo",
    position: "3",
    assignee: "tom",
    tags: ["protein", "t"],
    deps: ["dep-a"],
    surfaces: ["src/**"],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-02T00:00:00.000Z",
    done_at: "",
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "EdgeVector/fkanban",
    milestone: "ms-1",
    ...partial,
  };
}

type Tip = { content: unknown };
type MolTips = Map<string, Tip>; // key = hash\0range

/**
 * Fake Mini that implements protein create/member/write + schema/query for the
 * two membership schemas. Tips are stored per molecule UUID under (hash, range).
 * queryAll reconstructs thin rows by co-keying field tips — the same shape
 * listBoardCardsPartition / listMilestoneCardsPartition consume.
 */
function proteinFakeNode(opts?: {
  /** When true, protein writes to milestone-keyed members silently no-op. */
  dropMilestoneWrites?: boolean;
}): NodeClient & {
  tips: Map<string, MolTips>;
  proteins: Map<string, { members: Array<{ molecule_uuid: string; hash_field: string; range_field?: string }> }>;
  molToProtein: Map<string, string>;
} {
  const tips = new Map<string, MolTips>();
  const proteins = new Map<
    string,
    { members: Array<{ molecule_uuid: string; hash_field: string; range_field?: string }> }
  >();
  const molToProtein = new Map<string, string>();
  let proteinSeq = 0;

  const boardMols: Record<string, string> = {};
  const msMols: Record<string, string> = {};
  for (const f of BOARD_CARDS_FIELDS) boardMols[f] = mol(BOARD_HASH, f);
  for (const f of MILESTONE_CARDS_FIELDS) msMols[f] = mol(MS_HASH, f);

  const tipKey = (hash: string, range: string) => `${hash}\0${range}`;

  function setTip(molecule: string, hash: string, range: string, content: unknown) {
    let m = tips.get(molecule);
    if (!m) {
      m = new Map();
      tips.set(molecule, m);
    }
    m.set(tipKey(hash, range), { content });
  }

  function getTip(molecule: string, hash: string, range: string): unknown {
    return tips.get(molecule)?.get(tipKey(hash, range))?.content;
  }

  function reconstruct(
    schemaHash: string,
    fields: string[],
    hashKey: string,
  ): QueryRow[] {
    const fieldMols = schemaHash === BOARD_HASH ? boardMols : msMols;
    // Discover range keys from the sk molecule tips under this hash.
    const skMol = fieldMols.sk;
    const skTips = tips.get(skMol);
    if (!skTips) return [];
    const rows: QueryRow[] = [];
    for (const [k, tip] of skTips) {
      const [h, range] = k.split("\0");
      if (h !== hashKey) continue;
      const fieldVals: Record<string, unknown> = {};
      for (const f of fields) {
        const m = fieldMols[f];
        if (!m) continue;
        const v = getTip(m, h, range);
        if (v !== undefined) fieldVals[f] = v;
      }
      // Require slug so empty partial rows are dropped (matches list filters).
      if (!fieldVals.slug) continue;
      rows.push({
        key: { hash: h, range },
        fields: fieldVals,
      } as QueryRow);
    }
    return rows;
  }

  const rawCall = async (method: string, path: string, body?: unknown): Promise<RawResponse> => {
    const jsonBody = (body ?? {}) as Record<string, unknown>;

    if (method === "POST" && path === "/api/protein/fold") {
      return { status: 200, headers: new Headers(), body: "{}", json: { folds_applied: 0, schema: PROTEIN_SCHEMA_MARKER } };
    }
    if (method === "POST" && path === "/api/protein") {
      // UUID-shaped so adoption parsers and Mini-shaped ids match.
      const uuid = `00000000-0000-4000-8000-${String(++proteinSeq).padStart(12, "0")}`;
      proteins.set(uuid, { members: [] });
      return {
        status: 200,
        headers: new Headers(),
        body: "{}",
        json: { uuid, members: [], schema: PROTEIN_SCHEMA_MARKER, ok: true },
      };
    }
    if (method === "POST" && path === "/api/protein/member") {
      const proteinUuid = String(jsonBody.protein_uuid ?? "");
      const moleculeUuid = String(jsonBody.molecule_uuid ?? "");
      const hashField = String(jsonBody.hash_field ?? "");
      const rangeField = jsonBody.range_field ? String(jsonBody.range_field) : undefined;
      const existing = molToProtein.get(moleculeUuid);
      if (existing && existing !== proteinUuid) {
        return {
          status: 400,
          headers: new Headers(),
          body: `already bound to protein ${existing}`,
          json: { message: `Invalid data: molecule ${moleculeUuid} already bound to protein ${existing}, not ${proteinUuid}` },
        };
      }
      const p = proteins.get(proteinUuid);
      if (!p) {
        return { status: 400, headers: new Headers(), body: "protein not found", json: { message: "protein not found" } };
      }
      const already = p.members.find(
        (m) =>
          m.molecule_uuid === moleculeUuid &&
          m.hash_field === hashField &&
          m.range_field === rangeField,
      );
      if (!already) {
        p.members.push({ molecule_uuid: moleculeUuid, hash_field: hashField, range_field: rangeField });
      }
      molToProtein.set(moleculeUuid, proteinUuid);
      return {
        status: 200,
        headers: new Headers(),
        body: "{}",
        json: { uuid: proteinUuid, members: p.members, schema: PROTEIN_SCHEMA_MARKER, ok: true },
      };
    }
    if (method === "POST" && path === "/api/protein/write") {
      const entry = String(jsonBody.entry_molecule_uuid ?? "");
      const fields = (jsonBody.fields ?? {}) as Record<string, string>;
      const content = jsonBody.content;
      const proteinUuid = molToProtein.get(entry);
      if (!proteinUuid) {
        return {
          status: 400,
          headers: new Headers(),
          body: "not a member",
          json: { message: `molecule ${entry} is not a protein member` },
        };
      }
      const p = proteins.get(proteinUuid)!;
      const entryMember = p.members.find((m) => m.molecule_uuid === entry);
      if (!entryMember) {
        return { status: 400, headers: new Headers(), body: "missing member", json: {} };
      }
      const hash = fields[entryMember.hash_field] ?? "";
      const range = entryMember.range_field ? (fields[entryMember.range_field] ?? "") : "";
      if (!hash) {
        return { status: 400, headers: new Headers(), body: "missing hash", json: {} };
      }

      const isMsKey = entryMember.hash_field === "milestone";
      if (opts?.dropMilestoneWrites && isMsKey) {
        // Simulate partial path: write reports success but does not land tips.
        return {
          status: 200,
          headers: new Headers(),
          body: "{}",
          json: {
            used_protein_path: true,
            fold_jobs_enqueued: 0,
            folds_applied: 0,
            schema: PROTEIN_SCHEMA_MARKER,
            ok: true,
          },
        };
      }

      setTip(entry, hash, range, content);

      // Fold: repoint sibling members that can derive coords.
      let folds = 0;
      for (const sib of p.members) {
        if (sib.molecule_uuid === entry) continue;
        const sh = fields[sib.hash_field];
        const sr = sib.range_field ? fields[sib.range_field] : "";
        if (!sh) continue;
        if (opts?.dropMilestoneWrites && sib.hash_field === "milestone") continue;
        setTip(sib.molecule_uuid, sh, sr ?? "", content);
        folds += 1;
      }

      return {
        status: 200,
        headers: new Headers(),
        body: "{}",
        json: {
          used_protein_path: true,
          fold_jobs_enqueued: folds,
          folds_applied: folds,
          schema: PROTEIN_SCHEMA_MARKER,
          ok: true,
          entry_molecule_uuid: entry,
        },
      };
    }
    if (method === "GET" && path.startsWith("/api/schema/")) {
      const hash = decodeURIComponent(path.slice("/api/schema/".length));
      const field_molecule_uuids = hash === BOARD_HASH ? boardMols : hash === MS_HASH ? msMols : {};
      return {
        status: 200,
        headers: new Headers(),
        body: "{}",
        json: {
          ok: true,
          schema: {
            name: hash,
            field_molecule_uuids,
            key: {
              hash_field: hash === MS_HASH ? "milestone" : "board",
              range_field: "sk",
            },
            fields: Object.keys(field_molecule_uuids),
          },
        },
      };
    }
    return { status: 404, headers: new Headers(), body: "Not Found", json: null };
  };

  const queryAll = async (q: {
    schemaHash: string;
    fields: string[];
    filter?: QueryFilter;
  }): Promise<QueryResponse> => {
    const filter = q.filter as Record<string, unknown> | undefined;
    const hashKey =
      typeof filter?.HashKey === "string"
        ? filter.HashKey
        : typeof (filter?.HashRangePrefix as { hash?: string } | undefined)?.hash === "string"
          ? (filter!.HashRangePrefix as { hash: string }).hash
          : "";
    const results = reconstruct(q.schemaHash, q.fields, hashKey);
    return {
      schema: q.schemaHash,
      rowCount: results.length,
      results,
      page: null,
    };
  };

  return {
    tips,
    proteins,
    molToProtein,
    baseUrl: "http://127.0.0.1:9",
    userHash: "user",
    autoIdentity: async () => ({ provisioned: true as const, userHash: "user" }),
    bootstrap: async () => ({ userHash: "user" }),
    loadSchemas: async () => ({
      available_schemas_loaded: 0,
      schemas_loaded_to_db: 0,
      failed_schemas: [],
    }),
    listSchemas: async () => [],
    createRecord: async () => {},
    updateRecord: async () => {},
    deleteRecord: async () => {},
    queryAll,
    rawCall,
    nodeTransport: () => ({ transport: "socket" as const, socketPath: "/tmp/fake.sock" }),
  };
}

beforeEach(() => {
  resetProteinCaches();
});

describe("protein multi-key helpers", () => {
  test("moleculeUuid matches fold_db deterministic_molecule_uuid", () => {
    const schema = "deadbeef_board_cards_pin";
    const field = "title";
    const expected = createHash("sha256")
      .update(`${schema}:${field}`)
      .digest("hex");
    expect(moleculeUuid(schema, field)).toBe(expected);
    expect(moleculeUuid(schema, "title")).not.toBe(moleculeUuid(schema, "slug"));
  });

  test("PROTEIN_SCHEMA_MARKER is the core contract string", () => {
    expect(PROTEIN_SCHEMA_MARKER).toBe("lastdb.protein.v1");
  });

  test("membershipPartitionsAgree requires matching shared fields", () => {
    const a = card({ column: "todo", tags: ["x"], kind: "pr" });
    const b = card({ column: "todo", tags: ["x"], kind: "pr" });
    expect(membershipPartitionsAgree(a, b, { requireMilestone: true })).toBe(true);
    expect(
      membershipPartitionsAgree(a, { ...b, column: "" }, { requireMilestone: true }),
    ).toBe(false);
    expect(
      membershipPartitionsAgree(a, { ...b, tags: [] }, { requireMilestone: true }),
    ).toBe(false);
    expect(membershipPartitionsAgree(a, null, { requireMilestone: true })).toBe(false);
    expect(membershipPartitionsAgree(a, null, { requireMilestone: false })).toBe(true);
  });
});

describe("writeMembershipViaProtein (shipped multi-key path)", () => {
  test("returns true and both partitions agree on shared fields", async () => {
    const node = proteinFakeNode();
    const c = card({
      slug: "agree-card",
      title: "Agree",
      column: "doing",
      position: "7",
      tags: ["a", "b"],
      kind: "pr",
      milestone: "ms-1",
      assignee: "tom",
    });
    expect(await proteinAvailable(node)).toBe(true);
    const used = await writeMembershipViaProtein(node, cfg, c);
    expect(used).toBe(true);

    // Drive the same list helpers production uses.
    const { listBoardCardsPartition } = await import("../src/board-cards.ts");
    const { listMilestoneCardsPartition } = await import("../src/milestone-cards.ts");
    const boardPart = await listBoardCardsPartition(node, cfg, "default");
    const msPart = await listMilestoneCardsPartition(node, cfg, "ms-1");
    const boardRow = (boardPart ?? []).find((r) => r.slug === c.slug);
    const msRow = (msPart ?? []).find((r) => r.slug === c.slug);
    expect(boardRow).toBeTruthy();
    expect(msRow).toBeTruthy();
    expect(membershipPartitionsAgree(boardRow, msRow, { requireMilestone: true })).toBe(true);
    for (const f of SHARED_COHERENCE_FIELDS) {
      if (f === "milestone") continue;
      expect(normalize(boardRow![f as keyof typeof boardRow])).toBe(
        normalize(msRow![f as keyof typeof msRow]),
      );
    }
    expect(boardRow!.column).toBe("doing");
    expect(msRow!.column).toBe("doing");
    expect(boardRow!.tags).toEqual(["a", "b"]);
    expect(msRow!.tags).toEqual(["a", "b"]);
    expect(boardRow!.kind).toBe("pr");
    expect(msRow!.kind).toBe("pr");
  });

  test("returns false (do not skip dual-write) when milestone tips fail to land", async () => {
    const node = proteinFakeNode({ dropMilestoneWrites: true });
    const c = card({
      slug: "partial-card",
      title: "Partial",
      column: "todo",
      tags: ["protein-skeptic"],
      kind: "pr",
      milestone: "ms-1",
    });
    const used = await writeMembershipViaProtein(node, cfg, c);
    // Partial protein path must NOT claim success — caller dual-writes.
    expect(used).toBe(false);

    const { listBoardCardsPartition } = await import("../src/board-cards.ts");
    const { listMilestoneCardsPartition } = await import("../src/milestone-cards.ts");
    const boardPart = await listBoardCardsPartition(node, cfg, "default");
    const msPart = await listMilestoneCardsPartition(node, cfg, "ms-1");
    const boardRow = (boardPart ?? []).find((r) => r.slug === c.slug);
    const msRow = (msPart ?? []).find((r) => r.slug === c.slug);
    // Board may have landed; milestone must not fully agree — gate failed closed.
    expect(
      membershipPartitionsAgree(boardRow, msRow, { requireMilestone: true }),
    ).toBe(false);
  });

  test("molecules already on different proteins still get both keys written", async () => {
    const node = proteinFakeNode();
    // Pre-bind title field molecules to different proteins (the live failure mode).
    const bTitle = mol(BOARD_HASH, "title");
    const mTitle = mol(MS_HASH, "title");
    const p1 = await node.rawCall("POST", "/api/protein", {});
    const p2 = await node.rawCall("POST", "/api/protein", {});
    await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: (p1.json as { uuid: string }).uuid,
      molecule_uuid: bTitle,
      hash_field: "board",
      range_field: "sk",
    });
    await node.rawCall("POST", "/api/protein/member", {
      protein_uuid: (p2.json as { uuid: string }).uuid,
      molecule_uuid: mTitle,
      hash_field: "milestone",
      range_field: "sk",
    });

    const c = card({
      slug: "split-protein-card",
      title: "Split proteins",
      column: "review",
      tags: ["split"],
      kind: "pr",
      milestone: "ms-1",
    });
    const used = await writeMembershipViaProtein(node, cfg, c);
    expect(used).toBe(true);

    const { listBoardCardsPartition } = await import("../src/board-cards.ts");
    const { listMilestoneCardsPartition } = await import("../src/milestone-cards.ts");
    const boardRow = ((await listBoardCardsPartition(node, cfg, "default")) ?? []).find(
      (r) => r.slug === c.slug,
    );
    const msRow = ((await listMilestoneCardsPartition(node, cfg, "ms-1")) ?? []).find(
      (r) => r.slug === c.slug,
    );
    expect(membershipPartitionsAgree(boardRow, msRow, { requireMilestone: true })).toBe(true);
    expect(boardRow!.title).toBe("Split proteins");
    expect(msRow!.title).toBe("Split proteins");
    expect(boardRow!.column).toBe("review");
    expect(msRow!.column).toBe("review");
  });

  test("boardCardSk used for partition keys matches list sk shape", () => {
    const c = card({ column: "todo", position: "3", slug: "x" });
    expect(boardCardSk(c.column, c.position, c.slug)).toBe("todo#00000003#x");
  });
});

describe("protein-primary dual-write policy", () => {
  const prevFallback = process.env.FKANBAN_DUAL_WRITE_FALLBACK;
  const prevRequire = process.env.FKANBAN_REQUIRE_PROTEIN;
  beforeEach(() => {
    delete process.env.FKANBAN_DUAL_WRITE_FALLBACK;
    delete process.env.FKANBAN_REQUIRE_PROTEIN;
  });
  // restore after suite
  test("default: dual-write off when protein routes exist, on when missing", () => {
    expect(dualWriteFallbackEnabled(true)).toBe(false);
    expect(dualWriteFallbackEnabled(false)).toBe(true);
  });
  test("FKANBAN_DUAL_WRITE_FALLBACK=1 forces dual-write on", () => {
    process.env.FKANBAN_DUAL_WRITE_FALLBACK = "1";
    expect(dualWriteFallbackEnabled(true)).toBe(true);
  });
  test("FKANBAN_REQUIRE_PROTEIN=1 forces dual-write off even without protein routes", () => {
    process.env.FKANBAN_REQUIRE_PROTEIN = "1";
    expect(dualWriteFallbackEnabled(false)).toBe(false);
  });
  test("applyMembershipAfterProtein throws when protein available and fallback off", async () => {
    const node = proteinFakeNode({ dropMilestoneWrites: true });
    // protein routes available, write will fail closed
    expect(await proteinAvailable(node)).toBe(true);
    await expect(
      applyMembershipAfterProtein(node, cfg, card({ milestone: "ms-1" }), null),
    ).rejects.toBeInstanceOf(ProteinMembershipError);
  });
  test("cleanup env", () => {
    if (prevFallback === undefined) delete process.env.FKANBAN_DUAL_WRITE_FALLBACK;
    else process.env.FKANBAN_DUAL_WRITE_FALLBACK = prevFallback;
    if (prevRequire === undefined) delete process.env.FKANBAN_REQUIRE_PROTEIN;
    else process.env.FKANBAN_REQUIRE_PROTEIN = prevRequire;
    expect(true).toBe(true);
  });
});

function normalize(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return JSON.stringify([...v].map(String).sort());
  return String(v);
}
