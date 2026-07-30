/**
 * fkanban must not reach into LastDB's protein layer.
 *
 * Multi-key coherence is the node's job: it recognises BoardCards and
 * MilestoneCards as one product under two keys and folds a write on one key
 * onto the other's tip. When the app drove that itself it owned a storage
 * invariant it could not see, and `POST /api/protein/*` no longer exists to
 * drive. This is the regression guard for the whole arrangement — a reasonable
 * next step when a partition looks stale is to "just poke the protein", and it
 * needs to fail here rather than in someone's board.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type {
  NodeClient,
  QueryFilter,
  QueryResponse,
  QueryRow,
} from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { emptyStructuredFields, type Card } from "../src/record.ts";

const cfg: Config = {
  configVersion: 1,
  nodeUrl: "http://127.0.0.1:9",
  userHash: "user",
  schemaServiceUrl: "http://127.0.0.1:9",
  schemaHashes: {
    board: "board-hash",
    card: "card-hash",
    board_cards: "board-cards-hash",
    milestone_cards: "milestone-cards-hash",
  },
};

function card(partial: Partial<Card> = {}): Card {
  return {
    slug: "no-protein",
    title: "No protein",
    body: "body",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    created_at: "2026-01-01T00:00:00.000Z",
    created_by: "test",
    updated_at: "2026-01-01T00:00:00.000Z",
    ...emptyStructuredFields(),
    kind: "pr",
    repo: "EdgeVector/fkanban",
    milestone: "ms-1",
    ...partial,
  };
}

/** Records every raw path the app asks for, and stores records in memory. */
function recordingNode(): NodeClient & { paths: string[] } {
  type StoredRecord = { keyHash: string; rangeKey: string | null; fields: Record<string, unknown> };
  const paths: string[] = [];
  const store = new Map<string, Map<string, StoredRecord>>();
  const storeKey = (keyHash: string, rangeKey?: string | null) => `${keyHash}\0${rangeKey ?? ""}`;
  const tableFor = (schemaHash: string) => {
    let t = store.get(schemaHash);
    if (!t) {
      t = new Map();
      store.set(schemaHash, t);
    }
    return t;
  };
  const rowsFor = (schemaHash: string, filter?: QueryFilter): QueryRow[] => {
    const t = tableFor(schemaHash);
    const entries = filter?.HashKey
      ? [...t.values()].filter((rec) => rec.keyHash === filter.HashKey)
      : [...t.values()];
    return entries.map(({ keyHash, rangeKey, fields }) => ({
      fields,
      key: { hash: keyHash, range: rangeKey },
    }));
  };
  const notImpl = (m: string) => async (): Promise<never> => {
    throw new Error(`recordingNode.${m} not implemented`);
  };
  return {
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    autoIdentity: notImpl("autoIdentity"),
    bootstrap: notImpl("bootstrap"),
    loadSchemas: notImpl("loadSchemas"),
    listSchemas: notImpl("listSchemas"),
    async createRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey }) {
      tableFor(schemaHash).set(storeKey(keyHash, rangeKey), {
        keyHash,
        rangeKey: rangeKey ?? null,
        fields: { ...fields },
      });
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      tableFor(schemaHash).delete(storeKey(keyHash, rangeKey));
    },
    async queryAll({ schemaHash, filter }): Promise<QueryResponse> {
      const results = rowsFor(schemaHash, filter);
      return { ok: true, results, returned_count: results.length, total_count: results.length };
    },
    rawCall: (async (_method: string, path: string) => {
      paths.push(path);
      return { status: 404, headers: new Headers(), body: "", json: null };
    }) as unknown as NodeClient["rawCall"],
    nodeTransport: () => ({ transport: "unavailable" as const }),
    paths,
  };
}

function sourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...sourceFiles(full));
    else if (entry.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("fkanban does not reach into proteins", () => {
  test("writing a card touches no protein route", async () => {
    const node = recordingNode();
    const { createCardRecord, updateCardRecord } = await import("../src/record.ts");

    await createCardRecord({ cfg, node }, card());
    await updateCardRecord(
      { cfg, node },
      card({ column: "doing", position: "9" }),
      undefined,
      card(),
    );

    const proteinPaths = node.paths.filter((p) => p.includes("/api/protein"));
    expect(proteinPaths).toEqual([]);
  });

  test("no source file names a protein route", () => {
    const offenders = sourceFiles(join(import.meta.dir, "..", "src"))
      .filter((f) => readFileSync(f, "utf8").includes("/api/protein"))
      .map((f) => f.replace(`${join(import.meta.dir, "..")}/`, ""));
    expect(offenders).toEqual([]);
  });
});
