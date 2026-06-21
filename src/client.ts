// Typed HTTP wrappers for fold_db_node + schema_service.
//
// Every node endpoint sends X-User-Hash (missing → 401 MISSING_USER_CONTEXT).
// Writes go in as NodeOwner (no capability token) — fine for a local /
// ephemeral node with app_identity enforcement off. All errors flow through
// a single mapper so each failure mode maps to one actionable message.
//
// Owner-session attestation (app-isolation default-on, fold#739): when the
// node enforces app-isolation, owner-authority verbs (schema load, control
// plane) demand an *attested transport* and reject bare loopback TCP with
// `403 transport_not_attested`. fkanban attests exactly like the CLI's
// `attest_owner_session`: mint a one-time pairing code over the node's
// Unix-domain control socket, exchange it over TCP for a session token, and
// present that token as `X-Folddb-Session` on every request. Against a node
// with no control socket (the device-trust :9001 brain today) the mint fails,
// no token is obtained, and fkanban works exactly as before — the change is
// fully backward-compatible.

import { existsSync } from "node:fs";

import type { AddSchemaRequest } from "./schemas.ts";

export type Verbose = (msg: string) => void;
const noopVerbose: Verbose = () => {};

// A non-verbose, always-visible warning line (distinct from `verbose`, which is
// gated behind --verbose). Used to surface an attestation skip the moment it
// happens, so a user isn't blind to it before the owner verb 403s. Defaults to
// a no-op so library callers stay silent unless they opt in.
export type Warn = (msg: string) => void;
const noopWarn: Warn = () => {};

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

// fold's /api/query `filter` — fkanban only ever needs the exact-key form,
// which the node resolves as an indexed point read (no scan).
export type QueryFilter = { HashKey: string };

// Every request gets a deadline so a contended node can never hang the CLI
// (an unbounded `add` is what used to orphan backgrounded processes).
const DEFAULT_TIMEOUT_MS = 30_000;

function defaultTimeoutMs(): number {
  const raw = process.env.FKANBAN_HTTP_TIMEOUT_MS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

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
  queryAll(opts: { schemaHash: string; fields: string[]; filter?: QueryFilter }): Promise<QueryResponse>;
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
      const { res, readBody } = await verboseFetch({ baseUrl: url, path, method: "POST", body: req, verbose, service: "schema", headers: {} });
      const body = await readBody();
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
      const { res, readBody } = await verboseFetch({ baseUrl: url, path, method: "GET", body: undefined, verbose, service: "schema", headers: {} });
      if (res.status === 404) {
        await readBody();
        return null;
      }
      const body = await readBody();
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

// The outcome of one attestation attempt. On failure it carries enough context
// (whether the socket file even existed, plus the human-readable reason) for the
// caller to build an actionable error if an owner verb later 403s.
export type AttestationOutcome =
  | { ok: true; token: string }
  | { ok: false; socketPath: string; socketExists: boolean; reason: string };

// Mint a one-time pairing code over the node's Unix-domain control socket and
// exchange it over TCP for an owner-session token — the TypeScript twin of the
// CLI's `attest_owner_session` (fold_db_node/src/bin/folddb/commands/ui.rs).
//
// Returns a structured outcome: `{ ok: true, token }` on success, or
// `{ ok: false, ... }` on ANY failure (socket missing, mint or exchange
// non-2xx, parse error) with the reason + whether the socket existed. A failed
// outcome means "proceed unattested": on a device-trust node nothing is
// governed, so an unattested transport works fully — exactly fkanban's behavior
// before app-isolation existed. Only when the node *does* enforce app-isolation
// does the failure later surface (a `transport_not_attested` 403), and the
// captured reason is what turns that into an actionable error.
export async function attestOwnerSessionDetailed(
  nodeUrl: string,
  socketPath: string,
  verbose: Verbose = noopVerbose,
): Promise<AttestationOutcome> {
  const socketExists = existsSync(socketPath);
  const fail = (reason: string): AttestationOutcome => ({ ok: false, socketPath, socketExists, reason });

  // Mint over the UDS control socket. Bun speaks unix-socket fetch directly;
  // the `/control/*` verbs exist ONLY on this owner-attested channel.
  let pairingCode: string;
  try {
    const mintRes = await fetch("http://localhost/control/browser-pairing-code", {
      method: "POST",
      unix: socketPath,
      signal: AbortSignal.timeout(5_000),
    });
    if (!mintRes.ok) {
      verbose(`attest: mint refused (HTTP ${mintRes.status}) — proceeding unattested`);
      return fail(`the control socket refused the pairing-code mint (HTTP ${mintRes.status})`);
    }
    const minted = (await mintRes.json()) as Record<string, unknown>;
    const code = minted.pairing_code;
    if (typeof code !== "string" || code.length === 0) {
      verbose("attest: mint response missing pairing_code — proceeding unattested");
      return fail("the control socket's mint response carried no pairing_code");
    }
    pairingCode = code;
  } catch (err) {
    // Socket missing / connect refused / timeout → not an app-isolation node.
    const detail = err instanceof Error ? err.message : String(err);
    verbose(`attest: mint over socket ${socketPath} failed (${detail}) — proceeding unattested`);
    return fail(
      socketExists
        ? `the mint over the control socket failed (${detail})`
        : `no control socket exists at that path`,
    );
  }

  // Exchange the code over TCP for a session token.
  try {
    const exchangeRes = await fetch(`${stripTrailingSlash(nodeUrl)}/api/session/browser-pair`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!exchangeRes.ok) {
      verbose(`attest: exchange refused (HTTP ${exchangeRes.status}) — proceeding unattested`);
      return fail(`the pairing-code exchange over TCP was refused (HTTP ${exchangeRes.status})`);
    }
    const exchanged = (await exchangeRes.json()) as Record<string, unknown>;
    const token = exchanged.session_token;
    if (typeof token !== "string" || token.length === 0) {
      verbose("attest: exchange response missing session_token — proceeding unattested");
      return fail("the pairing-code exchange returned no session_token");
    }
    verbose("attest: owner session established");
    return { ok: true, token };
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    verbose(`attest: exchange failed (${detail}) — proceeding unattested`);
    return fail(`the pairing-code exchange over TCP failed (${detail})`);
  }
}

// Token-or-null wrapper around `attestOwnerSessionDetailed`. Kept for callers
// (and tests) that only need the session token; `null` means "proceed
// unattested". New code that needs the failure reason should call the detailed
// form directly.
export async function attestOwnerSession(
  nodeUrl: string,
  socketPath: string,
  verbose: Verbose = noopVerbose,
): Promise<string | null> {
  const outcome = await attestOwnerSessionDetailed(nodeUrl, socketPath, verbose);
  return outcome.ok ? outcome.token : null;
}

export function newNodeClient(opts: {
  baseUrl: string;
  userHash: string;
  verbose?: Verbose;
  // A non-verbose, always-visible warning sink. When attestation is skipped
  // because the derived control socket doesn't exist, the client emits one line
  // here so an app-isolation node's owner-verb 403 doesn't arrive out of the
  // blue. Omit to stay silent.
  warn?: Warn;
  timeoutMs?: number;
  // When set, the node's Unix-domain control socket. fkanban attests an owner
  // session over it once (lazily, on the first request) and re-attests once if
  // a request later 403s with `transport_not_attested` (a restarted node drops
  // the in-memory session). Omit to talk to the node unattested.
  socketPath?: string;
}): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const warn = opts.warn ?? noopWarn;
  const userHash = opts.userHash;
  const timeoutMs = opts.timeoutMs;
  const socketPath = opts.socketPath;

  // Owner-session token, established lazily on the first request and shared
  // across every subsequent call. `attesting` dedupes concurrent first-hits so
  // we mint exactly one pairing code. `null` token = unattested (fine on a
  // device-trust node). `lastAttestFailure` retains WHY the last attempt failed
  // so a later `transport_not_attested` 403 can be turned into an actionable
  // error instead of leaking the raw folddb message. `warnedNoSocket` makes the
  // one-line skip warning fire at most once.
  let sessionToken: string | null = null;
  let attesting: Promise<void> | null = null;
  let lastAttestFailure: (AttestationOutcome & { ok: false }) | null = null;
  let warnedNoSocket = false;

  const ensureAttested = async (force = false): Promise<void> => {
    if (!socketPath) return;
    if (sessionToken !== null && !force) return;
    if (force) {
      sessionToken = null;
      attesting = null;
    }
    if (attesting === null) {
      attesting = (async () => {
        const outcome = await attestOwnerSessionDetailed(url, socketPath, verbose);
        if (outcome.ok) {
          sessionToken = outcome.token;
          lastAttestFailure = null;
        } else {
          sessionToken = null;
          lastAttestFailure = outcome;
          // Surface a non-verbose skip warning the moment the socket is missing
          // (the most common misconfiguration), so the user sees a hint before
          // any owner verb 403s. Fire it once.
          if (!outcome.socketExists && !warnedNoSocket) {
            warnedNoSocket = true;
            warn(
              `fkanban: control socket not found at ${outcome.socketPath}; proceeding ` +
                "unattested — owner verbs (e.g. loading schemas) will fail on an " +
                "app-isolation node. Point fkanban at the node's control socket with " +
                "--node-socket-path <path> or FOLDDB_SOCKET_PATH=<path>.",
            );
          }
        }
      })();
    }
    await attesting;
  };

  // Build the actionable error for a `transport_not_attested` 403 on an owner
  // verb when fkanban never established an owner session. It names the cause
  // (this node enforces app-isolation) and the remedy (point fkanban at the
  // control socket), threading in the socket path it tried, whether that path
  // exists, and the mint/exchange failure reason captured during attestation.
  const attestationUnavailableError = (path: string): FkanbanError => {
    const failure = lastAttestFailure;
    const triedSocket = failure?.socketPath ?? socketPath;
    let why: string;
    if (failure) {
      why = `fkanban tried the control socket ${failure.socketPath} but ${failure.reason}.`;
    } else if (triedSocket) {
      why = `fkanban tried the control socket ${triedSocket} but could not establish an owner session.`;
    } else {
      why = "fkanban did not have a control socket to attest over.";
    }
    return new FkanbanError({
      code: "node_attestation_unavailable",
      message:
        `This node enforces app-isolation, so owner verbs (here: ${path}) require an ` +
        `attested owner session over the node's control socket — bare loopback TCP can't ` +
        `drive them. ${why}`,
      hint:
        "The control socket lives at <node data-dir>/folddb.sock. Point fkanban at it with " +
        "`--node-socket-path <path>` or `FOLDDB_SOCKET_PATH=<path>` and re-run `fkanban init` " +
        "(by default fkanban looks under $FOLDDB_HOME/data, which only matches a node started " +
        "with --data-dir $FOLDDB_HOME/data). Alternatively, drive the node via the desktop app " +
        "or a browser paired with `folddb ui`.",
    });
  };

  const nodeHeaders = (): Record<string, string> => {
    const h: Record<string, string> = { "X-User-Hash": userHash };
    if (sessionToken !== null) h["X-Folddb-Session"] = sessionToken;
    return h;
  };

  // True when a node response is the app-isolation "your transport isn't
  // attested" rejection — the signal to (re-)pair and retry once.
  const isNotAttested = (status: number, body: unknown): boolean =>
    status === 403 && bodyError(body) === "transport_not_attested";

  const callJson = async (
    path: string,
    method: "GET" | "POST",
    body?: unknown,
  ): Promise<{ status: number; body: unknown }> => {
    await ensureAttested();
    const doFetch = async () => {
      const { res, readBody } = await verboseFetch({
        baseUrl: url,
        path,
        method,
        body,
        verbose,
        service: "node",
        headers: nodeHeaders(),
        timeoutMs,
      });
      const parsed = await readBody();
      return { status: res.status, body: parsed };
    };
    let result = await doFetch();
    if (isNotAttested(result.status, result.body) && socketPath) {
      // Stale in-memory session (node restarted) — re-pair once and retry.
      verbose("node: transport_not_attested — re-pairing owner session and retrying");
      await ensureAttested(true);
      result = await doFetch();
    }
    // Still rejected as un-attested after any re-pair: fkanban could not stand up
    // an owner session for this app-isolation node. Replace the raw folddb 403
    // with an actionable error that names the socket + the --node-socket-path /
    // FOLDDB_SOCKET_PATH remedy (instead of leaking transport_not_attested).
    if (isNotAttested(result.status, result.body) && sessionToken === null) {
      throw attestationUnavailableError(path);
    }
    return result;
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
    async queryAll({ schemaHash, fields, filter }) {
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
          ...(filter !== undefined ? { filter } : {}),
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
      await ensureAttested();
      const doFetch = async () =>
        verboseFetch({
          baseUrl: url,
          path,
          method,
          body,
          verbose,
          service: "node",
          headers: nodeHeaders(),
          timeoutMs,
        });
      let { res, readBody } = await doFetch();
      let text = await readBody({ asText: true });
      if (res.status === 403 && bodyError(parseJsonSafe(text)) === "transport_not_attested" && socketPath) {
        verbose("node: transport_not_attested — re-pairing owner session and retrying");
        await ensureAttested(true);
        ({ res, readBody } = await doFetch());
        text = await readBody({ asText: true });
      }
      if (
        res.status === 403 &&
        bodyError(parseJsonSafe(text)) === "transport_not_attested" &&
        sessionToken === null
      ) {
        throw attestationUnavailableError(path);
      }
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

// The result of a bounded request: the response headers, plus a `readBody`
// closure that drains the response body UNDER THE SAME DEADLINE as the fetch.
// The body read must be deadline-bounded too: the node returns headers as soon
// as it accepts the request, then can stall for the whole cold-schema-init
// window while streaming the body. A plain `await res.text()` after the fetch
// is NOT covered by the fetch's own abort, so that stall used to hang the CLI
// unbounded. Here a single AbortController governs both halves, and the timer
// is cleared the instant the body is fully read.
type ReadBody = {
  (opts: { asText: true }): Promise<string>;
  (opts?: { asText?: false }): Promise<unknown>;
};

type BoundedResponse = {
  res: Response;
  readBody: ReadBody;
};

async function verboseFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
  verbose: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
  timeoutMs?: number;
}): Promise<BoundedResponse> {
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
  const timeoutMs = opts.timeoutMs ?? defaultTimeoutMs();
  opts.verbose(`→ ${tag} ${opts.method} ${url}` + (bodyStr !== undefined ? ` body=${bodyStr}` : ""));

  // One controller for the whole request lifecycle (headers + body). The timer
  // keeps running after the fetch resolves, so if the body read stalls past the
  // deadline the abort fires mid-`text()` and we map it to the same timeout
  // error. `done` is set once the body is fully read so the timer is cleared
  // and a slow *consumer* can never trip it after the I/O is already complete.
  const controller = new AbortController();
  let done = false;
  const timer = setTimeout(() => {
    if (!done) controller.abort(new DOMException("deadline exceeded", "TimeoutError"));
  }, timeoutMs);

  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    });
    opts.verbose(`← ${tag} ${opts.method} ${url} status=${res.status}`);
  } catch (err) {
    done = true;
    clearTimeout(timer);
    if (isTimeoutError(err)) {
      throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err);
    }
    throw connectionError(opts.baseUrl, opts.service, err);
  }

  const readBody = (async (readOpts?: { asText?: boolean }): Promise<unknown> => {
    try {
      const text = await res.text();
      done = true;
      clearTimeout(timer);
      if (readOpts?.asText) return text;
      return parseBody(text);
    } catch (err) {
      done = true;
      clearTimeout(timer);
      if (isTimeoutError(err)) {
        throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err);
      }
      throw connectionError(opts.baseUrl, opts.service, err);
    }
  }) as ReadBody;

  return { res, readBody };
}

function isTimeoutError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (err.name === "TimeoutError" || err.name === "AbortError") return true;
  const cause = (err as { cause?: unknown }).cause;
  return cause instanceof Error && (cause.name === "TimeoutError" || cause.name === "AbortError");
}

function timeoutError(
  path: string,
  method: string,
  service: "node" | "schema",
  timeoutMs: number,
  cause: unknown,
): FkanbanError {
  const which = service === "node" ? "node" : "schema service";
  return new FkanbanError({
    code: "service_timeout",
    message: `${which} did not respond within ${timeoutMs}ms (${method} ${path}).`,
    hint:
      "The node may be under heavy load. Writes are upserts keyed by slug, so re-running the command is safe. Raise the deadline with FKANBAN_HTTP_TIMEOUT_MS if the node is just slow.",
    cause,
  });
}

function parseJsonSafe(text: string): unknown {
  if (text.length === 0) return null;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

// Parse an already-read response body: JSON when it parses, the raw text
// otherwise, null when empty. (The body read itself is deadline-bounded in
// `verboseFetch`; this is the pure parse step.)
function parseBody(text: string): unknown {
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
        ? "Is a folddb node running? Start one with `brew services start folddb` (Homebrew install) or `cd fold/fold_db_node && ./run.sh --local --dev` (from the fold monorepo), then re-run `fkanban init`."
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
