// The live node's adopted Card schema can lack the optional card fields
// (CARD_OPTIONAL_SCHEMA_FIELDS) — current nodes reject that full-shape write
// with structured `unknown_fields`, and fkanban retries with the legacy
// body-header shape. Without a memo, EVERY card write pays that failed
// mutation: 203 of 447 card mutations (~45%) in one lastdbd session were
// these first-attempt failures (2026-07-17 request-ops investigation, fbrain
// `papercut-lastdbd-post-cutover-board-mutation-500`).
//
// These tests pin the memo behavior: first miss → legacy retry + remembered
// (and persisted when the config came from disk); later writes go straight to
// the legacy shape; a different adopted hash invalidates the memo; unrelated
// errors never trigger it.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { FkanbanError } from "../src/client.ts";
import type { NodeClient } from "../src/client.ts";
import { writeConfig, type Config } from "../src/config.ts";
import { createCardRecord, updateCardRecord, type Card } from "../src/record.ts";

function testCard(): Card {
  return {
    slug: "memo-card",
    title: "memo card",
    body: "Repo: EdgeVector/fkanban\nBase: main\n\nfixture",
    board: "default",
    column: "todo",
    position: "10",
    assignee: "",
    tags: [],
    deps: [],
    surfaces: ["src/record.ts"],
    created_at: "2026-07-17T00:00:00.000Z",
    updated_at: "2026-07-17T00:00:00.000Z",
    done_at: "",
    repo: "EdgeVector/fkanban",
    db: "",
    base: "main",
    kind: "pr",
    block_status: "",
    block_reason: "",
    north_star: "",
    pr_url: "",
    branch: "",
  };
}

function baseCfg(overrides: Partial<Config> = {}): Config {
  return {
    configVersion: 1,
    nodeUrl: "http://unused.invalid",
    schemaServiceUrl: "http://unused.invalid",
    userHash: "test-user",
    schemaHashes: { card: "cardhash", board: "boardhash" },
    ...overrides,
  };
}

type WriteCall = { fields: Record<string, unknown> };

// Node whose card schema lacks the optional fields: any write naming
// `surfaces` fails with the current structured unknown-fields shape, and the
// legacy shape succeeds. Records every mutation so tests can count attempts.
function optionalFieldRejectingNode(calls: WriteCall[]): NodeClient {
  const write = async ({ fields }: { fields: Record<string, unknown> }) => {
    calls.push({ fields });
    if ("surfaces" in fields) {
      throw new FkanbanError({
        code: "unknown_fields",
        message: "Node rejected /api/mutation: Field 'surfaces' not writable on schema 'cardhash'.",
      });
    }
  };
  return { createRecord: write, updateRecord: write } as unknown as NodeClient;
}

describe("card legacy-write memo", () => {
  test("first optional-field miss retries legacy and remembers the hash", async () => {
    const calls: WriteCall[] = [];
    const cfg = baseCfg();
    await createCardRecord({ cfg, node: optionalFieldRejectingNode(calls) }, testCard());

    expect(calls.length).toBe(2);
    expect("surfaces" in calls[0]!.fields).toBe(true);
    expect("surfaces" in calls[1]!.fields).toBe(false);
    // The dropped fields survive as body headers, not silent loss.
    expect(String(calls[1]!.fields.body)).toContain("Surfaces: src/record.ts");
    expect(cfg.cardLegacyWriteHash).toBe("cardhash");
  });

  test("a remembered hash writes the legacy shape directly (one mutation)", async () => {
    const calls: WriteCall[] = [];
    const cfg = baseCfg({ cardLegacyWriteHash: "cardhash" });
    await updateCardRecord({ cfg, node: optionalFieldRejectingNode(calls) }, testCard());

    expect(calls.length).toBe(1);
    expect("surfaces" in calls[0]!.fields).toBe(false);
  });

  test("a memo for a different (stale) hash is ignored — full shape first", async () => {
    const calls: WriteCall[] = [];
    const cfg = baseCfg({ cardLegacyWriteHash: "old-retired-hash" });
    await createCardRecord({ cfg, node: optionalFieldRejectingNode(calls) }, testCard());

    expect(calls.length).toBe(2);
    expect("surfaces" in calls[0]!.fields).toBe(true);
    expect(cfg.cardLegacyWriteHash).toBe("cardhash");
  });

  test("unrelated write errors do not trigger the memo", async () => {
    const calls: WriteCall[] = [];
    const cfg = baseCfg();
    const node = {
      createRecord: async ({ fields }: { fields: Record<string, unknown> }) => {
        calls.push({ fields });
        throw new FkanbanError({ code: "cas_conflict", message: "expected column mismatch" });
      },
    } as unknown as NodeClient;

    await expect(createCardRecord({ cfg, node }, testCard())).rejects.toThrow("expected column mismatch");
    expect(calls.length).toBe(1);
    expect(cfg.cardLegacyWriteHash).toBeUndefined();
  });

  test("memo persists to the config file the cfg was loaded from", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fkanban-memo-"));
    const path = join(dir, "config.json");
    const cfg = baseCfg({ configPath: path });
    writeConfig(cfg, path);

    await createCardRecord({ cfg, node: optionalFieldRejectingNode([]) }, testCard());

    const onDisk = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    expect(onDisk.cardLegacyWriteHash).toBe("cardhash");
    // The read-path bookkeeping field never lands in the file.
    expect("configPath" in onDisk).toBe(false);
  });
});
