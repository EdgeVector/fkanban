#!/usr/bin/env bun
/**
 * Catalog-only registration of fkanban BoardCards on LastDB Mini.
 * SOP: sop-register-app-schemas-on-lastdb-node
 *
 *   bun scripts/register-board-cards-schema.ts
 */
import { copyFileSync, readFileSync, writeFileSync } from "fs";
import { homedir } from "os";
import { join } from "path";
import { boardCardsSchema } from "../src/schemas.ts";

const DATA_SOCK = join(homedir(), ".lastdb/data/folddb.sock");
const FULL_SOCK = join(homedir(), ".lastdb/data/folddb-full.sock");
const SS_URL =
  process.env.LASTGIT_SCHEMA_SERVICE_URL ||
  process.env.SCHEMA_SERVICE_URL ||
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";
const CONFIG = join(homedir(), ".fkanban/config.json");

async function sockJson(
  sock: string,
  method: string,
  path: string,
  body?: unknown,
  userHash?: string,
): Promise<{ status: number; json: any; text: string }> {
  const headers: Record<string, string> = { Host: "localhost" };
  if (userHash) headers["X-User-Hash"] = userHash;
  if (body !== undefined) headers["Content-Type"] = "application/json";
  const res = await fetch(`http://localhost${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    // bun: unix domain socket
    unix: sock,
  } as RequestInit & { unix: string });
  const text = await res.text();
  let json: any = null;
  try {
    json = JSON.parse(text);
  } catch {
    /* raw */
  }
  return { status: res.status, json, text };
}

function pickHash(obj: any): string | null {
  if (!obj || typeof obj !== "object") return null;
  const candidates = [
    obj.canonical,
    obj.identity_hash,
    obj.schema?.identity_hash,
    obj.schema?.name,
    obj.data?.canonical,
    obj.data?.identity_hash,
  ];
  for (const c of candidates) {
    if (typeof c === "string" && /^[a-f0-9]{64}$/i.test(c)) return c.toLowerCase();
    // some services return identity as schema.name (64 hex)
    if (typeof c === "string" && c.length >= 32) return c;
  }
  return null;
}

async function main() {
  const schema = boardCardsSchema.schema;
  console.log("=== 1) propose BoardCards ===");
  console.log(
    JSON.stringify(
      {
        name: schema.name,
        schema_type: schema.schema_type,
        key: schema.key,
        field_count: schema.fields.length,
        owner_app_id: schema.owner_app_id,
      },
      null,
      2,
    ),
  );

  console.log("\n=== auto-identity ===");
  const id = await sockJson(DATA_SOCK, "GET", "/api/system/auto-identity");
  if (id.status !== 200 || !id.json?.user_hash) {
    console.error("auto-identity failed", id.status, id.text.slice(0, 500));
    process.exit(1);
  }
  const UH = String(id.json.user_hash);
  console.log("user_hash", UH);

  console.log("\n=== 2) soft declare on data sock (prefer reuse) ===");
  const declare = await sockJson(
    DATA_SOCK,
    "POST",
    "/api/apps/declare-schema",
    { app_id: "fkanban", schema },
    UH,
  );
  console.log("declare status", declare.status);
  console.log(declare.text.slice(0, 900));

  let hash = pickHash(declare.json);
  const resolution =
    declare.json?.resolution ?? declare.json?.data?.resolution ?? "";
  const declareReuse =
    declare.status === 200 && hash && String(resolution).includes("reuse");

  if (declareReuse) {
    console.log("REUSE path, hash=", hash);
  } else {
    console.log("\n=== 3) novel → Schema Service POST /v1/schemas ===");
    const body = {
      schema: { ...schema, owner_app_id: "fkanban" },
      mutation_mappers: {},
      offer_to_shared_discovery: false,
    };
    const ssRes = await fetch(`${SS_URL.replace(/\/$/, "")}/v1/schemas`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const ssText = await ssRes.text();
    console.log("SS status", ssRes.status);
    console.log(ssText.slice(0, 1500));
    if (!ssRes.ok) {
      console.error("Schema Service register failed");
      process.exit(1);
    }
    const ssJson = JSON.parse(ssText);
    hash = pickHash(ssJson);
    if (!hash) {
      console.error("no identity_hash from Schema Service");
      process.exit(1);
    }
    console.log("registered identity_hash=", hash);
  }

  console.log("\n=== 4) load on FULL sock ===");
  const load = await sockJson(
    FULL_SOCK,
    "POST",
    "/api/schemas/load",
    { schemas: [hash] },
    UH,
  );
  console.log("load status", load.status);
  console.log(load.text.slice(0, 900));
  if (load.status !== 200) {
    console.error("load failed on full sock");
    process.exit(1);
  }

  console.log("\n=== 5) verify on DATA sock ===");
  const get = await sockJson(DATA_SOCK, "GET", `/api/schema/${hash}`, undefined, UH);
  console.log("get status", get.status);
  const g = get.json?.schema ?? get.json ?? {};
  console.log(
    JSON.stringify(
      {
        name: g.name,
        descriptive_name: g.descriptive_name,
        schema_type: g.schema_type,
        key: g.key,
        fields: Array.isArray(g.fields) ? g.fields.length : undefined,
      },
      null,
      2,
    ),
  );
  if (get.status !== 200) {
    console.error("verify GET /api/schema failed");
    process.exit(1);
  }

  console.log("\n=== 6) bind ~/.fkanban/config.json ===");
  const bak =
    CONFIG +
    `.bak-pre-board-cards-${new Date().toISOString().replace(/[:.]/g, "")}`;
  copyFileSync(CONFIG, bak);
  console.log("backup", bak);
  const cfg = JSON.parse(readFileSync(CONFIG, "utf8"));
  cfg.schemaHashes = cfg.schemaHashes || {};
  cfg.schemaHashes.board_cards = hash;
  writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + "\n");
  console.log("bound schemaHashes.board_cards →", hash);
  console.log(JSON.stringify(cfg.schemaHashes, null, 2));

  console.log("\nOK BoardCards registered + loaded + bound");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
