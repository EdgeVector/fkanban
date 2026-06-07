// Typed HTTP wrappers for fold_db_node + schema_service.
//
// Every node endpoint sends X-User-Hash (missing → 401 MISSING_USER_CONTEXT).
// Writes go in as NodeOwner (no capability token) — fine for a local /
// ephemeral node with app_identity enforcement off. All errors flow through
// a single mapper so each failure mode maps to one actionable message.

import type { AddSchemaRequest } from "./schemas.ts";

export type Verbose = (msg: string) => void;
const noopVerbose: Verbose = () => {};

export class FkanbanError extends Error {
  readonly code: string;
  readonly hint?: string;
  override readonly cause?: unknown;
  constructor(opts: { code: string; message: string; hint?: string; cause?: unknown }) {
    super(opts.message);
    this.name = "FkanbanError";
    this.code = opts.code;
    this.hint = opts.hint;
    this.cause = opts.cause;
  }
}

export type QueryRow = {
  fields: Record<string, unknown>;
  key: { hash: string | null; range: string | null };
};

export type QueryResponse = {
  ok: boolean;
  results: QueryRow[];
  total_count?: number;
  returned_count?: number;
};

export type RawResponse = {
  status: number;
  headers: Headers;
  body: string;
  json: unknown;
};

// Single-request page size for the /api/query pagination loop — the node caps
// individual pages at 1000. fkanban boards stay well under that, so in
// practice one round trip resolves the whole schema.
export const QUERY_PAGE_SIZE = 1000;
const QUERY_PAGE_LIMIT = 1000;

export type RegisteredSchema = {
  name: string;
  descriptive_name: string;
  fields: string[];
};

export type LoadedSchema = {
  // The canonical identity hash — what mutations/queries pin to.
  name: string;
  descriptive_name: string;
  owner_app_id: string;
};

export type SchemaServiceClient = {
  baseUrl: string;
  registerSchema(req: AddSchemaRequest): Promise<{ canonicalHash: string; status: number }>;
  getSchemaByHash(hash: string): Promise<RegisteredSchema | null>;
};

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  bootstrap(name: string): Promise<{ userHash: string }>;
  loadSchemas(): Promise<{
    available_schemas_loaded: number;
    schemas_loaded_to_db: number;
    failed_schemas: string[];
  }>;
  // GET /api/schemas — every schema currently loaded in the node, each with
  // its canonical `name` (the identity hash mutations/queries pin to), its
  // human `descriptive_name`, and its `owner_app_id`. fkanban uses this to
  // resolve `fkanban/<Name>` → canonical hash after the schemas are published
  // out-of-band via the exemem app-creation flow.
  listSchemas(): Promise<LoadedSchema[]>;
  createRecord(opts: { schemaHash: string; fields: Record<string, unknown>; keyHash: string }): Promise<void>;
  updateRecord(opts: { schemaHash: string; fields: Record<string, unknown>; keyHash: string }): Promise<void>;
  deleteRecord(opts: { schemaHash: string; keyHash: string }): Promise<void>;
  queryAll(opts: { schemaHash: string; fields: string[] }): Promise<QueryResponse>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
};

export function newSchemaServiceClient(
  baseUrl: string,
  verbose: Verbose = noopVerbose,
): SchemaServiceClient {
  const url = stripTrailingSlash(baseUrl);
  return {
    baseUrl: url,
    async registerSchema(req) {
      const path = "/v1/schemas";
      const res = await verboseFetch({ baseUrl: url, path, method: "POST", body: req, verbose, service: "schema", headers: {} });
      const body = await readJson(res);
      if (res.status !== 200 && res.status !== 201) {
        throw mapSchemaServiceError(res.status, body, path);
      }
      const schemaObj =
        body && typeof body === "object"
          ? ((body as Record<string, unknown>).schema as Record<string, unknown> | undefined)
          : undefined;
      const canonicalHash =
        schemaObj && typeof schemaObj.name === "string" ? (schemaObj.name as string) : null;
      if (!canonicalHash) {
        throw new FkanbanError({
          code: "schema_register_no_hash",
          message: `Schema service did not return a canonical hash for ${req.schema.descriptive_name}.`,
          hint: "fkanban expects `schema.name` to carry the identity hash in the response.",
        });
      }
      return { canonicalHash, status: res.status };
    },
    async getSchemaByHash(hash) {
      const path = `/v1/schema/${encodeURIComponent(hash)}`;
      const res = await verboseFetch({ baseUrl: url, path, method: "GET", body: undefined, verbose, service: "schema", headers: {} });
      if (res.status === 404) {
        await res.text();
        return null;
      }
      const body = await readJson(res);
      if (res.status !== 200) throw mapSchemaServiceError(res.status, body, path);
      const obj = body && typeof body === "object" ? (body as Record<string, unknown>) : null;
      if (!obj) return null;
      const wrapped = obj.schema as Record<string, unknown> | undefined;
      const schemaObj = wrapped && typeof wrapped === "object" ? wrapped : obj;
      return {
        name: typeof schemaObj.name === "string" ? schemaObj.name : "",
        descriptive_name:
          typeof schemaObj.descriptive_name === "string" ? schemaObj.descriptive_name : "",
        fields: Array.isArray(schemaObj.fields)
          ? (schemaObj.fields as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
      };
    },
  };
}

export function newNodeClient(opts: { baseUrl: string; userHash: string; verbose?: Verbose }): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const userHash = opts.userHash;

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    const res = await verboseFetch({
      baseUrl: url,
      path,
      method,
      body,
      verbose,
      service: "node",
      headers: { "X-User-Hash": userHash },
    });
    const parsed = await readJson(res);
    return { status: res.status, body: parsed };
  };

  const mutate = async (
    kind: "create" | "update" | "delete",
    schemaHash: string,
    fields: Record<string, unknown>,
    keyHash: string,
  ): Promise<void> => {
    const { status, body } = await callJson("/api/mutation", "POST", {
      type: "mutation",
      schema: schemaHash,
      fields_and_values: fields,
      key_value: { hash: keyHash, range: null },
      mutation_type: kind,
    });
    if (status !== 200) throw mapNodeError(status, body, "/api/mutation");
  };

  return {
    baseUrl: url,
    userHash,
    async autoIdentity() {
      const { status, body } = await callJson("/api/system/auto-identity", "GET");
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        return { provisioned: true, userHash: typeof uh === "string" ? uh : userHash };
      }
      if (status === 503) {
        return { provisioned: false, reason: bodyError(body) ?? "node_not_provisioned" };
      }
      throw mapNodeError(status, body, "/api/system/auto-identity");
    },
    async bootstrap(name) {
      const { status, body } = await callJson("/api/setup/bootstrap", "POST", { name });
      if (status === 200) {
        const uh = body && typeof body === "object" ? (body as Record<string, unknown>).user_hash : undefined;
        if (typeof uh !== "string" || uh.length === 0) {
          throw new FkanbanError({
            code: "bootstrap_no_user_hash",
            message: "Bootstrap succeeded but the node did not return a user_hash.",
          });
        }
        return { userHash: uh };
      }
      throw mapNodeError(status, body, "/api/setup/bootstrap");
    },
    async loadSchemas() {
      const { status, body } = await callJson("/api/schemas/load", "POST");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas/load");
      const b = body as Record<string, unknown>;
      const failed = Array.isArray(b.failed_schemas) ? (b.failed_schemas as string[]) : [];
      return {
        available_schemas_loaded: numField(b, "available_schemas_loaded"),
        schemas_loaded_to_db: numField(b, "schemas_loaded_to_db"),
        failed_schemas: failed,
      };
    },
    async listSchemas() {
      const { status, body } = await callJson("/api/schemas", "GET");
      if (status !== 200) throw mapNodeError(status, body, "/api/schemas");
      const b = body as Record<string, unknown>;
      const raw = Array.isArray(b.schemas) ? (b.schemas as Record<string, unknown>[]) : [];
      return raw.map((s) => ({
        name: typeof s.name === "string" ? s.name : "",
        descriptive_name: typeof s.descriptive_name === "string" ? s.descriptive_name : "",
        owner_app_id: typeof s.owner_app_id === "string" ? s.owner_app_id : "",
      }));
    },
    async createRecord({ schemaHash, fields, keyHash }) {
      await mutate("create", schemaHash, fields, keyHash);
    },
    async updateRecord({ schemaHash, fields, keyHash }) {
      await mutate("update", schemaHash, fields, keyHash);
    },
    async deleteRecord({ schemaHash, keyHash }) {
      await mutate("delete", schemaHash, {}, keyHash);
    },
    async queryAll({ schemaHash, fields }) {
      // Paginate up to QUERY_PAGE_SIZE rows per request, deduping by record
      // key across pages (fold_db_node's offset pagination is unstable above
      // one page — dedupe keeps us correct if a board ever exceeds the page).
      const allResults: QueryRow[] = [];
      const seenKeys = new Set<string>();
      let offset = 0;
      for (let page = 0; page < QUERY_PAGE_LIMIT; page++) {
        const { status, body } = await callJson("/api/query", "POST", {
          schema_name: schemaHash,
          fields,
          limit: QUERY_PAGE_SIZE,
          offset,
        });
        if (status !== 200) throw mapNodeError(status, body, "/api/query");
        const b = body as Record<string, unknown>;
        const pageResults = Array.isArray(b.results) ? (b.results as QueryRow[]) : [];
        let newOnPage = 0;
        for (const row of pageResults) {
          const k = recordDedupKey(row);
          if (seenKeys.has(k)) continue;
          seenKeys.add(k);
          allResults.push(row);
          newOnPage++;
        }
        if (b.has_more !== true) break;
        if (newOnPage === 0 || pageResults.length === 0) break;
        offset += pageResults.length;
      }
      return { ok: true, results: allResults, returned_count: allResults.length, total_count: allResults.length };
    },
    async rawCall(method, path, body) {
      const res = await verboseFetch({
        baseUrl: url,
        path,
        method,
        body,
        verbose,
        service: "node",
        headers: { "X-User-Hash": userHash },
      });
      const text = await res.text();
      return { status: res.status, headers: res.headers, body: text, json: parseJsonSafe(text) };
    },
  };
}

function recordDedupKey(row: QueryRow): string {
  const key = row.key;
  if (!key || typeof key !== "object") return `__no_key__|${JSON.stringify(row.fields ?? null)}`;
  return `h:${key.hash ?? ""}|r:${key.range ?? ""}`;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function bodyError(body: unknown): string | undefined {
  if (body && typeof body === "object" && "error" in body) {
    const e = (body as Record<string, unknown>).error;
    if (typeof e === "string") return e;
  }
  return undefined;
}

function bodyMessage(body: unknown): string | undefined {
  if (body && typeof body === "object" && "message" in body) {
    const m = (body as Record<string, unknown>).message;
    if (typeof m === "string") return m;
  }
  return undefined;
}

function stripTrailingSlash(url: string): string {
  return url.endsWith("/") ? url.slice(0, -1) : url;
}

async function verboseFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
  verbose: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
}): Promise<Response> {
  const url = `${opts.baseUrl}${opts.path}`;
  const tag = opts.service === "node" ? "NODE" : "SCHEMA";
  const headers = { ...opts.headers };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  const bodyStr =
    opts.body === undefined
      ? undefined
      : typeof opts.body === "string"
        ? opts.body
        : JSON.stringify(opts.body);
  opts.verbose(`→ ${tag} ${opts.method} ${url}` + (bodyStr !== undefined ? ` body=${bodyStr}` : ""));
  try {
    const res = await fetch(url, { method: opts.method, headers, body: bodyStr });
    opts.verbose(`← ${tag} ${opts.method} ${url} status=${res.status}`);
    return res;
  } catch (err) {
    throw connectionError(opts.baseUrl, opts.service, err);
  }
}

function parseJsonSafe(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

async function readJson(res: Response): Promise<unknown> {
  const text = await res.text();
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

function connectionError(baseUrl: string, service: "node" | "schema", cause: unknown): FkanbanError {
  const which = service === "node" ? "node" : "schema service";
  return new FkanbanError({
    code: "service_unreachable",
    message: `${which} not reachable at ${baseUrl} — run \`fkanban doctor\` for a diagnosis.`,
    hint:
      service === "node"
        ? "Start a fold node, e.g. `cd fold/fold_db_node && ./run.sh --local --dev`, then re-run `fkanban init`."
        : "Check the schema-service URL in ~/.fkanban/config.json.",
    cause,
  });
}

function mapNodeError(status: number, body: unknown, path: string): FkanbanError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  if (status === 401 && (errCode === "MISSING_USER_CONTEXT" || msg?.includes("Authentication"))) {
    return new FkanbanError({
      code: "missing_user_context",
      message: `Node rejected ${path}: missing X-User-Hash.`,
      hint: "Re-run `fkanban init` so the config's userHash is regenerated.",
    });
  }
  if (status === 503 && errCode === "node_not_provisioned") {
    return new FkanbanError({
      code: "node_not_provisioned",
      message: `Node not set up.`,
      hint: "Run `fkanban init` to bootstrap the node.",
    });
  }
  if (status === 400 && (errCode === "unknown_fields" || msg?.includes("unknown"))) {
    return new FkanbanError({
      code: "unknown_fields",
      message: `Node rejected ${path}: ${msg ?? "unknown field name"}.`,
      hint: "Schema drift — re-run `fkanban init` to re-register schemas.",
    });
  }
  return new FkanbanError({
    code: `node_http_${status}`,
    message: `Node ${path} returned HTTP ${status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""}.`,
    hint: status >= 500 ? "Check the node log; this looks like a node-side bug." : undefined,
  });
}

function mapSchemaServiceError(status: number, body: unknown, path: string): FkanbanError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  return new FkanbanError({
    code: `schema_http_${status}`,
    message: `Schema service ${path} returned HTTP ${status}${msg ? `: ${msg}` : ""}${errCode ? ` [${errCode}]` : ""}.`,
  });
}
