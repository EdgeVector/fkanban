// Regression for fbrain `papercut-lastdbd-post-cutover-board-mutation-500`:
// the minimal node (lastdb_node without fold_db_node's unknown-fields gate)
// rejects a mutation naming a field its schema lacks with a bare, content-free
// HTTP 500 — NOT the structured `unknown_fields` 400 the legacy-surfaces
// fallback in createCardRecord/updateCardRecord matched on. Against such a
// node every `add`/`move` died with "node_http_500" even though retrying
// without optional body-mirrored fields (`surfaces`, `db`) succeeds. These
// tests pin the fallback contract for BOTH node behaviors, plus the rethrow
// semantics when the retry itself fails.

import { describe, expect, test } from "bun:test";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient } from "../src/client.ts";
import type { Config } from "../src/config.ts";
import { createCardRecord, updateCardRecord, nowIso, type Card } from "../src/record.ts";

// Fresh per test: a first optional-field miss now stamps
// `cfg.cardLegacyWriteHash` (the legacy-write memo, see
// test/card-legacy-write-memo.test.ts), and a shared cfg would leak that memo
// into the happy-path tests.
function freshCfg(): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    schemaServiceUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes: { card: "cardhash", board: "boardhash" },
  };
}

function testCard(): Card {
  const ts = nowIso();
  return {
    slug: "fallback-test-card",
    title: "t",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\nbody",
    board: "default",
    column: "todo",
    position: "1",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: ["src/record.ts"],
    created_at: ts,
    updated_at: ts,
    done_at: "",
    db: "lastdb://personal",
    repo: "EdgeVector/fkanban",
    base: "main",
    kind: "pr",
    block_status: "none",
    block_reason: "",
    north_star: "",
    pr_url: "",
    branch: "",
  };
}

const bare500 = () =>
  new FkanbanError({
    code: "node_http_500",
    message: "Node /api/mutation returned HTTP 500: Internal Server Error.",
  });

const structured400 = () =>
  new FkanbanError({
    code: "unknown_fields",
    message: "Node rejected /api/mutation: Field 'surfaces' not writable on schema 'cardhash'.",
  });

const unrelated404 = () =>
  new FkanbanError({ code: "node_http_404", message: "Schema not found" });

// A node stub whose create/update rejects any payload carrying optional fields
// with `err`, and records every accepted payload.
function strictNode(err: () => FkanbanError, alwaysFail = false) {
  const writes: Array<Record<string, unknown>> = [];
  const write = async ({ fields }: { fields: Record<string, unknown> }) => {
    if (alwaysFail || "surfaces" in fields || "db" in fields) throw err();
    writes.push(fields);
  };
  const node = {
    createRecord: write,
    updateRecord: write,
  } as unknown as NodeClient;
  return { node, writes };
}

for (const [name, writeFn] of [
  ["createCardRecord", createCardRecord],
  ["updateCardRecord", updateCardRecord],
] as const) {
  describe(name, () => {
    test("bare minimal-node 500 → retries once without optional fields, mirroring them into body headers", async () => {
      const { node, writes } = strictNode(bare500);
      await writeFn({ cfg: freshCfg(), node }, testCard());
      expect(writes.length).toBe(1);
      const accepted = writes[0]!;
      expect("surfaces" in accepted).toBe(false);
      expect("db" in accepted).toBe(false);
      expect(String(accepted.body)).toContain("Surfaces: src/record.ts");
      expect(String(accepted.body)).toContain("Db: lastdb://personal");
    });

    test("structured unknown_fields 400 still triggers the fallback (existing contract)", async () => {
      const { node, writes } = strictNode(structured400);
      await writeFn({ cfg: freshCfg(), node }, testCard());
      expect(writes.length).toBe(1);
      expect("surfaces" in writes[0]!).toBe(false);
      expect("db" in writes[0]!).toBe(false);
    });

    test("a 500 with a different cause surfaces the ORIGINAL error after the retry also fails", async () => {
      const { node } = strictNode(bare500, /* alwaysFail */ true);
      const err = await writeFn({ cfg: freshCfg(), node }, testCard()).then(
        () => null,
        (e: unknown) => e,
      );
      expect(err).toBeInstanceOf(FkanbanError);
      expect((err as FkanbanError).code).toBe("node_http_500");
    });

    test("non-500, non-unknown_fields errors are NOT retried", async () => {
      let calls = 0;
      const node = {
        createRecord: async () => {
          calls++;
          throw unrelated404();
        },
        updateRecord: async () => {
          calls++;
          throw unrelated404();
        },
      } as unknown as NodeClient;
      const err = await writeFn({ cfg: freshCfg(), node }, testCard()).then(
        () => null,
        (e: unknown) => e,
      );
      expect((err as FkanbanError).code).toBe("node_http_404");
      expect(calls).toBe(1);
    });

    test("happy path writes surfaces as a structured field, no retry", async () => {
      const writes: Array<Record<string, unknown>> = [];
      const node = {
        createRecord: async ({ fields }: { fields: Record<string, unknown> }) => {
          writes.push(fields);
        },
        updateRecord: async ({ fields }: { fields: Record<string, unknown> }) => {
          writes.push(fields);
        },
      } as unknown as NodeClient;
      await writeFn({ cfg: freshCfg(), node }, testCard());
      expect(writes.length).toBe(1);
      expect(writes[0]!.surfaces).toEqual(["src/record.ts"]);
      expect(writes[0]!.db).toBe("lastdb://personal");
    });
  });
}
