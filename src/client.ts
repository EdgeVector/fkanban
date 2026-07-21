// Typed HTTP wrappers for the LastDB node.
//
// Every node endpoint sends X-User-Hash (missing → 401 MISSING_USER_CONTEXT).
// Writes go in as NodeOwner (no capability token) — fine for a local /
// ephemeral node with app_identity enforcement off. All errors flow through
// a single mapper so each failure mode maps to one actionable message.
//
// Local nodes are socket-only: the loopback `:9001` TCP control plane was
// retired (fold `fold-retire-tcp-listener`), so every node route — data plane,
// schema/identity reads, and owner-session attestation — travels over the
// node's Unix-domain control socket. The `nodeUrl` is now just a loopback
// identity string in error/diagnostic text; there is no live TCP transport to
// fall back to.
//
// Owner-session attestation (app-isolation default-on, fold#739): when the
// node enforces app-isolation, owner-authority verbs (schema load, control
// plane) demand an *attested transport* and reject unattested requests with
// `403 transport_not_attested`. fkanban attests exactly like the CLI's
// `attest_owner_session`: mint a one-time pairing code over the node's
// Unix-domain control socket, exchange it over that same socket for a session
// token, and present that token as `X-Folddb-Session` on every request.
// Against a node with no control socket the mint fails, no token is obtained,
// and requests proceed unattested (an owner verb will then 403) — the socket
// is the only path, so a missing socket means the node is effectively
// unreachable, not that TCP takes over.

import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";

import {
  CapabilityDeniedError,
  LastDbClient,
  PermissionDeniedError,
  RequestRejectedError,
  TransportError,
  UnexpectedResponseError,
  capabilityStoreKey,
  parseQueryResponse,
  type CapabilityStore,
  type JsonValue,
  type KeyValue,
  type QueryResult as SdkQueryResult,
  type RowFields,
  type SearchResult as SdkSearchResult,
  type Transport as SdkTransport,
} from "@lastdb/app-sdk";

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

export type AppSearchOptions = {
  k?: number;
};

export type AppSearchHit = {
  key_value: KeyValue;
  fields: RowFields;
  metadata?: unknown;
  author_pub_key: string;
  schema_name: string;
  schema_display_name: string;
  score: number;
};

export type CasExpectation =
  | { type: "absent"; field: string }
  | { type: "value"; field: string; value: JsonValue };

export type AppSchemaDeclaration = {
  app_id: string;
  schema: string;
  canonical: string;
  resolution: "mint" | "link" | string;
  decision?: string;
  auditEventId: string;
  bindEligible: true;
};

// Single-request page size for the /api/query pagination loop — the node caps
// individual pages at 1000. fkanban boards stay well under that, so in
// practice one round trip resolves the whole schema.
export const QUERY_PAGE_SIZE = 1000;
const QUERY_PAGE_LIMIT = 1000;

// fold's /api/query `filter` — exact field filters. `HashKey` is the special
// primary-key point read; schema fields such as `column` may be backed by node
// secondary indexes on newer nodes. Callers that need HashRangePrefix /
// HashRangeKey cast through `as QueryFilter` (fold accepts those objects).
export type QueryFilter = Record<string, string>;

// Every request gets a deadline so a contended node can never hang the CLI
// (an unbounded `add` is what used to orphan backgrounded processes).
const DEFAULT_TIMEOUT_MS = 30_000;

function defaultTimeoutMs(): number {
  const raw = process.env.FKANBAN_HTTP_TIMEOUT_MS;
  const n = raw === undefined ? NaN : parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

// Transient backpressure (HTTP 503 "node is busy") is self-resolving: a busy
// node sheds load and *rejects* the request (so it was never applied) while
// literally telling you to retry. fkanban retries such a 503 a bounded number
// of times with backoff before surfacing an accurate "overloaded, re-run"
// error. Retry is safe for both reads (pure) and writes (upserts keyed by
// slug, and a rejected request can neither double-apply nor corrupt).
const BUSY_RETRY_MAX = 3;
// Exponential backoff schedule (ms) used when the node gives no explicit
// "retry after Ns" hint. Index i is the wait BEFORE attempt i+1.
const BUSY_BACKOFF_MS = [250, 500, 1000];
// Cap on any single honored "retry after" hint, so a misbehaving hint can't
// make a command hang. The per-request deadline still governs each attempt.
const BUSY_RETRY_AFTER_CAP_MS = 5_000;
const SOCKET_CONNECT_RETRY_MAX = 3;
const SOCKET_CONNECT_BACKOFF_MS = [100, 250, 500];

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// True when a node response is transient backpressure we should retry: a 503
// whose error/message clearly signals overload ("busy", "too many concurrent",
// "overloaded", or a "retry after" directive). Deliberately conservative — only
// clearly-transient signals retry. `node_not_provisioned` is a non-transient
// 503 (the node isn't set up; retrying never helps) and is explicitly excluded.
function isTransientBusy(status: number, body: unknown): boolean {
  if (status !== 503) return false;
  const errCode = bodyError(body);
  if (errCode === "node_not_provisioned") return false;
  const haystack = `${errCode ?? ""} ${bodyMessage(body) ?? ""}`.toLowerCase();
  return (
    haystack.includes("busy") ||
    haystack.includes("too many concurrent") ||
    haystack.includes("overloaded") ||
    haystack.includes("retry after")
  );
}

// If the node's message carries a "retry after Ns" directive, return that wait
// in ms (capped). Otherwise null — the caller falls back to the backoff table.
function retryAfterHintMs(body: unknown): number | null {
  const text = `${bodyError(body) ?? ""} ${bodyMessage(body) ?? ""}`;
  const m = text.match(/retry after\s+(\d+(?:\.\d+)?)\s*s/i);
  if (!m) return null;
  const secs = parseFloat(m[1]!);
  if (!Number.isFinite(secs) || secs <= 0) return null;
  return Math.min(secs * 1000, BUSY_RETRY_AFTER_CAP_MS);
}

// The wait before retry attempt `attempt` (1-based): honor the node's own
// "retry after" hint when present (capped), else the exponential table, plus a
// little jitter so concurrent clients don't re-stampede in lockstep.
function busyBackoffMs(attempt: number, body: unknown): number {
  const hinted = retryAfterHintMs(body);
  const base = hinted ?? BUSY_BACKOFF_MS[Math.min(attempt - 1, BUSY_BACKOFF_MS.length - 1)]!;
  return base + Math.floor(Math.random() * 100);
}

export type LoadedSchema = {
  // The canonical identity hash — what mutations/queries pin to.
  name: string;
  descriptive_name: string;
  owner_app_id: string;
  // The schema's declared field names, as the node reports them in
  // `/api/schemas`. fkanban uses this to disambiguate when two schemas share
  // an `owner_app_id` + `descriptive_name` (e.g. a stale duplicate alongside
  // the current one): the resolver prefers the loaded schema whose `fields`
  // SUPERSET the app's local definition, so a write of every local field is
  // accepted — instead of blindly picking the first descriptive_name match,
  // which can be a narrower stale version the node rejects writes against
  // (fkanban #94: a 10-field `fkanban/Card` lingered beside the 18-field one).
  // Empty when the node omits `fields` (older nodes) — callers fall back to
  // descriptive_name matching + a write probe.
  fields: string[];
};

export type NodeClient = {
  baseUrl: string;
  userHash: string;
  autoIdentity(): Promise<
    | { provisioned: true; userHash: string }
    | { provisioned: false; reason: string }
  >;
  bootstrap(name: string): Promise<{ userHash: string }>;
  loadSchemas(schemas?: string[]): Promise<{
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
  declareAppSchema?(appId: string, schema: Record<string, unknown>): Promise<AppSchemaDeclaration>;
  createRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
    /** HashRange range component; omit/null for Hash schemas. */
    rangeKey?: string | null;
    expected?: CasExpectation;
  }): Promise<void>;
  updateRecord(opts: {
    schemaHash: string;
    fields: Record<string, unknown>;
    keyHash: string;
    rangeKey?: string | null;
    expected?: CasExpectation;
  }): Promise<void>;
  deleteRecord(opts: { schemaHash: string; keyHash: string; rangeKey?: string | null }): Promise<void>;
  queryAll(opts: { schemaHash: string; fields: string[]; filter?: QueryFilter; allowFullScan?: boolean }): Promise<QueryResponse>;
  search?(query: string, opts?: AppSearchOptions): Promise<AppSearchHit[]>;
  rawCall(method: string, path: string, body?: unknown): Promise<RawResponse>;
  // Which transport local node requests take RIGHT NOW: `socket` when an owner
  // socket was threaded in and the file currently exists (the socket carries
  // board data-plane routes and the schema/identity checks doctor needs;
  // `folddb-full.sock` carries every node route). Local nodes are socket-only —
  // the loopback TCP control plane was retired — so when no socket file is
  // present this returns `unavailable`: requests have no live transport and
  // will fail, NOT silently fall back to TCP. `socketPath` echoes the path
  // consulted (so `kanban doctor` can name it). Re-evaluates `existsSync` on
  // each call so a socket that appears/vanishes between calls is reported
  // accurately.
  nodeTransport(): { transport: "socket" | "unavailable"; socketPath?: string };
};

const FKANBAN_APP_ID = "fkanban";

const noopCapabilityStore: CapabilityStore = {
  async store() {},
  async load() {
    return null;
  },
  async remove() {},
};

// The outcome of one attestation attempt. On failure it carries enough context
// (whether the socket file even existed, plus the human-readable reason) for the
// caller to build an actionable error if an owner verb later 403s.
export type AttestationOutcome =
  | { ok: true; token: string }
  | { ok: false; socketPath: string; socketExists: boolean; reason: string };

// Mint a one-time pairing code over the node's Unix-domain control socket and
// exchange it for an owner-session token. `folddb-full.sock` can serve the
// exchange over UDS too; narrower sockets keep the historical TCP exchange.
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
  socketPath: string,
  verbose: Verbose = noopVerbose,
): Promise<AttestationOutcome> {
  const socketExists = existsSync(socketPath);
  const fail = (reason: string): AttestationOutcome => ({ ok: false, socketPath, socketExists, reason });

  // Mint over the UDS control socket. Bun speaks unix-socket fetch directly;
  // the `/control/*` verbs exist ONLY on this owner-attested channel.
  let pairingCode: string;
  for (let attempt = 1; ; attempt++) {
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
      break;
    } catch (err) {
      // Socket missing / connect refused / timeout → not an app-isolation node.
      const detail = err instanceof Error ? err.message : String(err);
      if (socketExists && isConnectError(err) && attempt < SOCKET_CONNECT_RETRY_MAX) {
        const wait = SOCKET_CONNECT_BACKOFF_MS[attempt - 1]!;
        verbose(`attest: mint over socket ${socketPath} failed (${detail}) — retry ${attempt}/${SOCKET_CONNECT_RETRY_MAX - 1} after ${wait}ms`);
        await sleep(wait);
        continue;
      }
      verbose(`attest: mint over socket ${socketPath} failed (${detail}) — proceeding unattested`);
      return fail(
        socketExists
          ? `the mint over the control socket failed (${detail})`
          : `no control socket exists at that path`,
      );
    }
  }

  // Exchange the code for a session token OVER THE SAME UDS control socket the
  // mint used. The loopback TCP listener is retired (fold `fold-retire-tcp-listener`),
  // so the old `isFullSurfaceSocket`-gated TCP fallback for narrower sockets could
  // only ever dead-end on connect and hang (~5s x SOCKET_CONNECT_RETRY_MAX, ~20-30s)
  // before "proceeding unattested" — the dominant source of per-invocation CLI
  // slowness. The node serves this route on the control socket regardless of
  // surface (verified against the primary `folddb.sock`), so always use the socket.
  try {
    const exchangeRes = await fetch("http://localhost/api/session/browser-pair", {
      method: "POST",
      unix: socketPath,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code: pairingCode }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!exchangeRes.ok) {
      verbose(`attest: exchange refused (HTTP ${exchangeRes.status}) — proceeding unattested`);
      return fail(`the pairing-code exchange was refused (HTTP ${exchangeRes.status})`);
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
    return fail(`the pairing-code exchange failed (${detail})`);
  }
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
  // Dev-first app-caller mode. When present, requests carry an app capability
  // envelope for this app id so the node applies per-app schema LINK mappings.
  appId?: string;
  appCapability?: string;
}): NodeClient {
  const url = stripTrailingSlash(opts.baseUrl);
  const verbose = opts.verbose ?? noopVerbose;
  const warn = opts.warn ?? noopWarn;
  const userHash = opts.userHash;
  const timeoutMs = opts.timeoutMs;
  const socketPath = opts.socketPath;
  const appId = opts.appId;
  const appCapability = opts.appCapability;

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
        const outcome = await attestOwnerSessionDetailed(socketPath, verbose);
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
        "`--node-socket-path <path>` or `FOLDDB_SOCKET_PATH=<path>` and re-run `kanban init` " +
        "(by default fkanban looks under $FOLDDB_HOME/data, which only matches a node started " +
        "with --data-dir $FOLDDB_HOME/data). Alternatively, drive the node via the desktop app " +
        "or a browser paired with `folddb ui`.",
    });
  };

  const nodeHeaders = (): Record<string, string> => {
    // X-LastDB-Client is a best-effort ops label (not a security boundary).
    // Mini request telemetry ranks worst offenders by this header.
    const h: Record<string, string> = {
      "X-User-Hash": userHash,
      "X-LastDB-Client": "kanban",
    };
    if (sessionToken !== null) h["X-Folddb-Session"] = sessionToken;
    if (appId !== undefined && appId.length > 0) {
      h["X-App-Capability"] = appCapability && appCapability.length > 0
        ? appCapability
        : appCapabilityHeader(appId);
      h["X-Capability-Ts"] = Math.floor(Date.now() / 1000).toString();
    }
    return h;
  };

  // True when a node response is the app-isolation "your transport isn't
  // attested" rejection — the signal to (re-)pair and retry once.
  const isNotAttested = (status: number, body: unknown): boolean =>
    status === 403 && bodyError(body) === "transport_not_attested";

  const sdkTransport: SdkTransport = {
    target: socketPath ? `unix:${socketPath}` : url,
    async send(
      method: "GET" | "POST",
      path: string,
      options: { headers?: Record<string, string>; body?: unknown } = {},
    ): Promise<{ status: number; body: unknown }> {
      await ensureAttested();
      const doFetch = async () => {
        const { res, readBody } = await verboseFetch({
          baseUrl: url,
          path,
          method,
          body: options.body,
          verbose,
          service: "node",
          headers: { ...nodeHeaders(), ...(options.headers ?? {}) },
          timeoutMs,
          socketPath,
        });
        const parsed = await readBody();
        return { status: res.status, body: parsed };
      };
      let result = await doFetch();
      if (isNotAttested(result.status, result.body) && socketPath) {
        verbose("node: transport_not_attested — re-pairing owner session and retrying");
        await ensureAttested(true);
        result = await doFetch();
      }
      for (
        let attempt = 1;
        attempt <= BUSY_RETRY_MAX && isTransientBusy(result.status, result.body);
        attempt++
      ) {
        const wait = busyBackoffMs(attempt, result.body);
        verbose(
          `node: transient 503 backpressure (${bodyError(result.body) ?? "busy"}) — ` +
            `retry ${attempt}/${BUSY_RETRY_MAX} after ${wait}ms`,
        );
        await sleep(wait);
        result = await doFetch();
      }
      if (isNotAttested(result.status, result.body) && sessionToken === null) {
        throw attestationUnavailableError(path);
      }
      return result;
    },
  };

  const sdkStoreKey = capabilityStoreKey(FKANBAN_APP_ID, sdkTransport.target);
  let sdkClient: LastDbClient | null = null;
  const dataClient = (): LastDbClient => {
    sdkClient ??= new LastDbClient(
      FKANBAN_APP_ID,
      sdkTransport,
      noopCapabilityStore,
      null,
      sdkStoreKey,
      sdkTransport.target,
    );
    return sdkClient;
  };

  const sdkDataPath = async <T>(path: string, fn: (client: LastDbClient) => Promise<T>): Promise<T> => {
    try {
      return await fn(dataClient());
    } catch (err) {
      throw mapSdkDataError(err, url, "POST", path, socketPath);
    }
  };

  const queryAllWithFullScanHeader = async (opts: {
    schemaHash: string;
    fields: string[];
    filter?: QueryFilter;
  }): Promise<QueryResponse> => {
    const rows: SdkQueryResult["rows"] = [];
    let schema = "";
    let rowCount = 0;
    let page: SdkQueryResult["page"] = null;
    let offset = 0;
    let cursor: KeyValue | null = null;

    try {
      for (;;) {
        const body: Record<string, unknown> = {
          schema_name: opts.schemaHash,
          fields: opts.fields,
          limit: QUERY_PAGE_SIZE,
          ...(opts.filter !== undefined ? { filter: opts.filter as JsonValue } : {}),
          ...(cursor === null ? { offset } : { cursor }),
        };
        const res = await sdkTransport.send("POST", "/api/query", {
          headers: { "X-LastDB-Allow-Full-Scan": "1" },
          body,
        });
        if (res.status !== 200) {
          throw mapNodeError(res.status, res.body, "/api/query");
        }
        const parsed = parseQueryResponse(res.body);
        schema = parsed.schema || schema;
        rowCount = parsed.page?.totalCount ?? parsed.rowCount ?? rowCount;
        page = parsed.page;
        rows.push(...parsed.rows);

        const hasMore = parsed.page !== null
          ? parsed.page.hasMore
          : parsed.rows.length >= QUERY_PAGE_SIZE;
        if (!hasMore) break;
        if (rows.length >= QUERY_PAGE_SIZE * QUERY_PAGE_LIMIT) break;
        cursor = parsed.page?.nextCursor ?? null;
        if (cursor === null) offset += parsed.rows.length;
        if (parsed.rows.length === 0) break;
      }
    } catch (err) {
      throw mapSdkDataError(err, url, "POST", "/api/query", socketPath);
    }

    return queryResponseFromSdk({ schema, rowCount, rows, page });
  };

  const appSearch = async (query: string, searchOpts?: AppSearchOptions): Promise<AppSearchHit[]> => {
    const result = await sdkDataPath("/api/app/search", (client) =>
      client.search(query, { k: searchOpts?.k ?? 50 }),
    );
    return appSearchHitsFromSdkSearch(result);
  };

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
        socketPath,
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
    // Transient backpressure (HTTP 503 "node is busy") is self-resolving: the
    // node rejected the request (never applied it) and asked us to retry. Retry
    // up to BUSY_RETRY_MAX times with bounded backoff — safe for reads (pure)
    // and writes (slug-keyed upserts; a rejected request can't double-apply).
    // `node_not_provisioned` 503s are excluded by `isTransientBusy` (retrying
    // never helps), as are all non-503 mappings.
    for (
      let attempt = 1;
      attempt <= BUSY_RETRY_MAX && isTransientBusy(result.status, result.body);
      attempt++
    ) {
      const wait = busyBackoffMs(attempt, result.body);
      verbose(
        `node: transient 503 backpressure (${bodyError(result.body) ?? "busy"}) — ` +
          `retry ${attempt}/${BUSY_RETRY_MAX} after ${wait}ms`,
      );
      await sleep(wait);
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
    async loadSchemas(schemas?: string[]) {
      // Scope the load when a non-empty list is given (parity with brain /
      // fold #877): each entry is a canonical identity hash or a
      // descriptive_name. Empty / omitted → full published catalog (slow).
      const scope = (schemas ?? []).filter((s) => typeof s === "string" && s.length > 0);
      const reqBody = scope.length > 0 ? { schemas: scope } : undefined;
      const { status, body } = await callJson("/api/schemas/load", "POST", reqBody);
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
        fields: Array.isArray(s.fields)
          ? (s.fields as unknown[]).filter((v): v is string => typeof v === "string")
          : [],
      }));
    },
    async declareAppSchema(appId, schema) {
      const { status, body } = await callJson("/api/apps/declare-schema", "POST", {
        app_id: appId,
        schema,
      });
      if (status !== 200) throw mapNodeError(status, body, "/api/apps/declare-schema");
      const b = body as Record<string, unknown>;
      const canonical = typeof b.canonical === "string" ? b.canonical : "";
      const schemaName = typeof b.schema === "string" ? b.schema : "";
      const resolution = typeof b.resolution === "string" ? b.resolution : "";
      const auditEventId = typeof b.audit_event_id === "string" ? b.audit_event_id : "";
      const bindEligible = b.bind_eligible === true;
      if (!canonical || !schemaName || !resolution || !auditEventId || !bindEligible) {
        throw new FkanbanError({
          code: "app_schema_declare_bad_response",
          message: `Node /api/apps/declare-schema returned an incomplete response: ${JSON.stringify(body).slice(0, 300)}.`,
          hint: "Upgrade the node or inspect the app-schema declaration response. F-Kanban binds only an audited catalog sync with bind_eligible=true.",
        });
      }
      return {
        app_id: typeof b.app_id === "string" ? b.app_id : appId,
        schema: schemaName,
        canonical,
        resolution,
        decision: typeof b.decision === "string" ? b.decision : undefined,
        auditEventId,
        bindEligible: true,
      };
    },
    async createRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      await sdkDataPath("/api/mutation", (client) =>
        client.mutate(schemaHash, {
          mutationType: "create",
          fields: fields as RowFields,
          key: recordKey(keyHash, rangeKey),
          ...(expected !== undefined ? { expected } : {}),
        }),
      );
    },
    async updateRecord({ schemaHash, fields, keyHash, rangeKey, expected }) {
      await sdkDataPath("/api/mutation", (client) =>
        client.mutate(schemaHash, {
          mutationType: "update",
          fields: fields as RowFields,
          key: recordKey(keyHash, rangeKey),
          ...(expected !== undefined ? { expected } : {}),
        }),
      );
    },
    async deleteRecord({ schemaHash, keyHash, rangeKey }) {
      await sdkDataPath("/api/mutation", (client) =>
        client.mutate(schemaHash, {
          mutationType: "delete",
          fields: {},
          key: recordKey(keyHash, rangeKey),
        }),
      );
    },
    async queryAll({ schemaHash, fields, filter, allowFullScan }) {
      if (allowFullScan === true) {
        return queryAllWithFullScanHeader({ schemaHash, fields, filter });
      }
      const result = await sdkDataPath("/api/query", (client) =>
        client.queryAll(
          schemaHash,
          {
            fields,
            ...(filter !== undefined ? { filter: filter as JsonValue } : {}),
          },
          {
            pageSize: QUERY_PAGE_SIZE,
            maxRows: QUERY_PAGE_SIZE * QUERY_PAGE_LIMIT,
          },
        ),
      );
      return queryResponseFromSdk(result);
    },
    search: appSearch,
    async rawCall(method, path, body) {
      const sdkSearch = sdkSearchFromNativeIndexPath(method, path);
      if (sdkSearch !== null) {
        const hits = await appSearch(sdkSearch.query, { k: sdkSearch.k });
        const json = nativeIndexJsonFromAppSearchHits(hits);
        return { status: 200, headers: new Headers(), body: JSON.stringify(json), json };
      }
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
          socketPath,
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
    nodeTransport() {
      const live = socketPath !== undefined && socketPath.length > 0 && existsSync(socketPath);
      return live ? { transport: "socket", socketPath } : { transport: "unavailable", socketPath };
    },
  };
}

function recordDedupKey(row: QueryRow): string {
  const key = row.key;
  if (!key || typeof key !== "object") return `__no_key__|${JSON.stringify(row.fields ?? null)}`;
  return `h:${key.hash ?? ""}|r:${key.range ?? ""}`;
}

function hashKey(keyHash: string): KeyValue {
  return { hash: keyHash, range: null };
}

/** Hash or HashRange key for /api/mutation. */
function recordKey(keyHash: string, rangeKey?: string | null): KeyValue {
  if (rangeKey !== undefined && rangeKey !== null && rangeKey.length > 0) {
    return { hash: keyHash, range: rangeKey };
  }
  return hashKey(keyHash);
}

function queryResponseFromSdk(result: SdkQueryResult): QueryResponse {
  const allResults: QueryRow[] = [];
  const seenKeys = new Set<string>();
  for (const row of result.rows) {
    const converted = queryRowFromSdk(row);
    const k = recordDedupKey(converted);
    if (seenKeys.has(k)) continue;
    seenKeys.add(k);
    allResults.push(converted);
  }
  return {
    ok: true,
    results: allResults,
    returned_count: allResults.length,
    total_count: result.page?.totalCount ?? result.rowCount ?? allResults.length,
  };
}

function queryRowFromSdk(row: SdkQueryResult["rows"][number]): QueryRow {
  return {
    fields: row.fields,
    key: row.keyValue ?? renderedKeyFallback(row.key),
  };
}

function renderedKeyFallback(rendered: string): KeyValue {
  return { hash: rendered.length > 0 ? rendered : null, range: null };
}

function sdkSearchFromNativeIndexPath(method: string, path: string): { query: string; k: number } | null {
  if (method !== "GET" || !path.startsWith("/api/native-index/search")) return null;
  const url = new URL(path, "http://localhost");
  const query = url.searchParams.get("q") ?? "";
  if (query.length === 0) return null;
  return { query, k: 50 };
}

function nativeIndexJsonFromAppSearchHits(hits: AppSearchHit[]): unknown {
  return {
    ok: true,
    results: hits,
  };
}

function appSearchHitsFromSdkSearch(result: SdkSearchResult): AppSearchHit[] {
  return result.hits.map((hit) => ({
    key_value: hit.keyValue ?? renderedKeyFallback(fieldString(hit.fields, "slug") ?? hit.key),
    fields: hit.fields,
    metadata: hit.metadata,
    author_pub_key: hit.authorPubKey ?? "",
    schema_name: hit.schemaName,
    schema_display_name: hit.schemaDisplayName ?? "",
    score: hit.score ?? 0,
  }));
}

function fieldString(fields: RowFields, key: string): string | null {
  const value = fields[key];
  return typeof value === "string" && value.length > 0 ? value : null;
}

function numField(obj: Record<string, unknown>, key: string): number {
  const v = obj[key];
  return typeof v === "number" ? v : 0;
}

function appCapabilityHeader(appId: string): string {
  const now = new Date().toISOString();
  const token = {
    envelope: {
      version: 1,
      purpose: "capability_grant",
      alg: "Ed25519",
      key_id: "fkanban-dev-local",
      issued_at: now,
      env: "dev",
      payload_hash: "dev-local",
      sig: "ZGV2LWxvY2Fs",
    },
    capability_id: `fkanban-dev-local-${appId}`,
    app_id: appId,
    scope: { wildcard: `${appId}/*` },
    granted_ops: ["read", "write"],
    granted_at: now,
    node_pubkey: "dev-local",
  };
  return Buffer.from(JSON.stringify(token), "utf8").toString("base64");
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

// Pull a string[] field (e.g. `unknown_fields`, `available_fields`) out of a
// JSON error body, returning [] if absent or the wrong shape. Used to surface
// the node's full unknown-field detail in the mapped error.
function bodyStringArray(body: unknown, key: string): string[] {
  if (body && typeof body === "object" && key in body) {
    const v = (body as Record<string, unknown>)[key];
    if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  }
  return [];
}

// A `: <raw>` suffix for an error body that carries neither `error` nor
// `message` — a raw JSON object or a plain-text body — so a 400/500 with an
// unexpected shape still surfaces SOMETHING actionable instead of a bare
// status. Bounded so a huge body can't blow up the message.
function rawBodySuffix(body: unknown): string {
  if (body === null || body === undefined) return "";
  const text = typeof body === "string" ? body : JSON.stringify(body);
  if (text.length === 0 || text === "null" || text === "{}") return "";
  const clipped = text.length > 300 ? `${text.slice(0, 300)}…` : text;
  return `: ${clipped}`;
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

// True when a fetch rejection is a *connect-class* failure (the socket vanished,
// the listener refused, the path is gone) rather than a real HTTP response or a
// deadline abort. Only these justify the socket-first → TCP fallback: an HTTP
// 4xx/5xx is a genuine answer from the node and must NOT trigger a fallback, and
// a timeout has its own mapping. Bun surfaces UDS connect failures as a plain
// Error whose message/code names ENOENT/ECONNREFUSED/"Unable to connect" etc.;
// match those loosely so a missing or refused socket falls back cleanly.
function isConnectError(err: unknown): boolean {
  if (isTimeoutError(err)) return false;
  if (!(err instanceof Error)) return false;
  const code = (err as { code?: unknown }).code;
  if (typeof code === "string" && /ENOENT|ECONNREFUSED|ECONNRESET|EPIPE|ENXIO|EACCES/.test(code)) {
    return true;
  }
  const msg = err.message.toLowerCase();
  return (
    msg.includes("unable to connect") ||
    msg.includes("connection refused") ||
    msg.includes("econnrefused") ||
    msg.includes("enoent") ||
    msg.includes("failed to connect") ||
    msg.includes("typo in the url or port") ||
    msg.includes("socket") ||
    msg.includes("connection closed")
  );
}

// Routes served by the node's owner data socket (`folddb.sock`). Older nodes
// may expose a sibling full-surface socket (`folddb-full.sock`) for the whole
// HTTP app; current nodes collapsed that surface into canonical `folddb.sock`.
// Keeping this allowlist method-aware prevents non-canonical narrower sockets
// from receiving owner/control routes they cannot serve, while still letting
// doctor prove schema + identity without retired TCP :9001.
const SOCKET_OWNER_ROUTES = [
  { method: "POST", path: "/api/query" },
  { method: "POST", path: "/api/mutation" },
  { method: "GET", path: "/api/schemas" },
  { method: "GET", path: "/api/system/auto-identity" },
] as const;

const CANONICAL_NODE_SOCKET_BASENAME = "folddb.sock";
const LEGACY_FULL_SURFACE_SOCKET_BASENAME = "folddb-full.sock";

function isFullSurfaceSocket(socketPath: string): boolean {
  return basename(socketPath) === LEGACY_FULL_SURFACE_SOCKET_BASENAME;
}

function legacyFullSurfaceSocketPath(socketPath: string): string {
  return join(dirname(socketPath), LEGACY_FULL_SURFACE_SOCKET_BASENAME);
}

function isCollapsedFullSurfaceSocket(socketPath: string): boolean {
  return (
    basename(socketPath) === CANONICAL_NODE_SOCKET_BASENAME &&
    !existsSync(legacyFullSurfaceSocketPath(socketPath))
  );
}

function socketServesEveryNodeRoute(socketPath: string): boolean {
  return isFullSurfaceSocket(socketPath) || isCollapsedFullSurfaceSocket(socketPath);
}

function isSocketRoute(method: string, path: string, socketPath: string): boolean {
  if (socketServesEveryNodeRoute(socketPath)) return true;
  return SOCKET_OWNER_ROUTES.some((r) => r.method === method && r.path === path);
}

// A LOCAL node is reached only over its Unix socket — the loopback TCP listener
// is retired (fold `fold-retire-tcp-listener`), so there is no TCP fallback.
export function isLoopbackNodeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "127.0.0.1" ||
      u.hostname === "localhost" ||
      u.hostname === "::1" ||
      u.hostname === "[::1]"
    );
  } catch {
    return false;
  }
}

// The socket a given route must use under socket-only, computed regardless of
// whether the selected file exists (a down node simply fails the connect, which
// the catch maps to a node-not-running diagnostic instead of dialing :9001). A
// configured legacy full-surface socket carries every route. A canonical
// `folddb.sock` carries the whole app when no `folddb-full.sock` sibling exists
// (current fold nodes); when the sibling exists (older nodes), non-data-plane
// setup routes keep using it for back-compat.
function routeSocketPathFor(method: string, path: string, socketPath: string): string {
  if (socketServesEveryNodeRoute(socketPath)) return socketPath;
  if (SOCKET_OWNER_ROUTES.some((r) => r.method === method && r.path === path)) return socketPath;
  return legacyFullSurfaceSocketPath(socketPath);
}

async function verboseFetch(opts: {
  baseUrl: string;
  path: string;
  method: string;
  body: unknown;
  verbose: Verbose;
  service: "node" | "schema";
  headers: Record<string, string>;
  timeoutMs?: number;
  // The node's Unix-domain socket. When set AND the service is `node` AND the
  // route is served by that socket AND the socket file exists, the request goes
  // over UDS (socket-first) with a single automatic fallback to TCP `baseUrl` if
  // the socket connect fails. `folddb.sock` is deliberately allowlisted; the
  // full surface socket (`folddb-full.sock`) may carry every node route. NEVER
  // consulted for `service: schema` — the schema service is the remote HTTPS
  // Lambda, which has no local socket.
  socketPath?: string;
}): Promise<BoundedResponse> {
  const tcpUrl = `${opts.baseUrl}${opts.path}`;
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

  // Socket-first selection. `folddb.sock` carries board data-plane requests plus
  // the schema and auto-identity reads doctor needs. `folddb-full.sock` carries
  // the whole node HTTP app, so it uses UDS for every node route. Beyond the
  // route predicate the usual guards apply: only `service: node`, only when a
  // socketPath was threaded in and the file exists (a node without a socket, or
  // the schema service, transparently uses TCP). Bun's UDS fetch keeps the URL
  // as `http://localhost<path>` and routes the connection over `{ unix }`.
  // A LOCAL (loopback) node is socket-only: pick the route's socket
  // UNCONDITIONALLY and never dial the retired loopback TCP port — a connect
  // failure is mapped to a node-not-running diagnostic, not a :9001 error.
  const socketOnly =
    opts.service === "node" &&
    isLoopbackNodeUrl(opts.baseUrl) &&
    opts.socketPath !== undefined &&
    opts.socketPath.length > 0;
  const socketOnlyPath = socketOnly
    ? routeSocketPathFor(opts.method, opts.path, opts.socketPath as string)
    : null;
  // Legacy socket-first WITH a TCP fallback, retained only for a NON-loopback
  // (remote) node that exposes a local socket file for an allowlisted route.
  const useSocket =
    !socketOnly &&
    opts.service === "node" &&
    opts.socketPath !== undefined &&
    opts.socketPath.length > 0 &&
    existsSync(opts.socketPath) &&
    isSocketRoute(opts.method, opts.path, opts.socketPath);
  const errorSocketPath = socketOnly
    ? (socketOnlyPath as string)
    : useSocket
      ? opts.socketPath
      : undefined;

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

  // Issue the request over a given transport: a socket path routes over Bun's
  // `{ unix }` option (URL stays `http://localhost<path>`); null uses plain TCP.
  const attempt = async (sock: string | null): Promise<Response> => {
    const url = sock ? `http://localhost${opts.path}` : tcpUrl;
    const transport = sock ? `unix:${sock}` : "tcp";
    opts.verbose(
      `→ ${tag} ${opts.method} ${url} [${transport}]` +
        (bodyStr !== undefined ? ` body=${bodyStr}` : ""),
    );
    const init: RequestInit & { unix?: string } = {
      method: opts.method,
      headers,
      body: bodyStr,
      signal: controller.signal,
    };
    if (sock) init.unix = sock;
    const r = await fetch(url, init);
    opts.verbose(`← ${tag} ${opts.method} ${url} [${transport}] status=${r.status}`);
    return r;
  };

  // Retry a socket connect a few times (it may be mid-startup), then give up.
  const attemptSocketWithRetries = async (sock: string): Promise<Response> => {
    let socketErr: unknown = null;
    for (let attemptNo = 1; attemptNo <= SOCKET_CONNECT_RETRY_MAX; attemptNo++) {
      try {
        return await attempt(sock);
      } catch (err) {
        socketErr = err;
        if (!isConnectError(err) || isTimeoutError(err)) throw err;
        if (attemptNo < SOCKET_CONNECT_RETRY_MAX) {
          const wait = SOCKET_CONNECT_BACKOFF_MS[attemptNo - 1]!;
          opts.verbose(
            `node: socket ${sock} connect failed (${
              err instanceof Error ? err.message : String(err)
            }) — retry ${attemptNo}/${SOCKET_CONNECT_RETRY_MAX - 1} after ${wait}ms`,
          );
          await sleep(wait);
        }
      }
    }
    throw socketErr;
  };

  let res: Response | undefined;
  try {
    if (socketOnly) {
      // Socket-only: never dial the retired loopback TCP port.
      res = await attemptSocketWithRetries(socketOnlyPath as string);
    } else if (useSocket) {
      try {
        res = await attemptSocketWithRetries(opts.socketPath as string);
      } catch (socketErr) {
        if (!isConnectError(socketErr) || isTimeoutError(socketErr)) throw socketErr;
        opts.verbose(
          `node: socket ${opts.socketPath} unreachable (${
            socketErr instanceof Error ? socketErr.message : String(socketErr)
          }) — falling back to TCP ${opts.baseUrl}`,
        );
        res = await attempt(null);
      }
    } else {
      res = await attempt(null);
    }
  } catch (err) {
    done = true;
    clearTimeout(timer);
    if (isTimeoutError(err)) {
      throw timeoutError(opts.path, opts.method, opts.service, timeoutMs, err);
    }
    throw connectionError(opts.baseUrl, opts.service, err, errorSocketPath, opts.method, opts.path);
  }
  if (res === undefined) {
    throw connectionError(opts.baseUrl, opts.service, new Error("no response"), errorSocketPath, opts.method, opts.path);
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
      throw connectionError(opts.baseUrl, opts.service, err, errorSocketPath, opts.method, opts.path);
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

function connectionError(
  baseUrl: string,
  service: "node" | "schema",
  cause: unknown,
  socketPath?: string,
  method?: string,
  path?: string,
): FkanbanError {
  const which = service === "node" ? "node" : "schema service";
  // A local node is socket-only (the loopback TCP listener is retired), so name
  // the socket — not :9001 — when one was configured; only a remote/non-socket
  // target reports the base URL.
  const where = socketPath ? `over its Unix socket ${socketPath}` : `at ${baseUrl}`;
  const route = method && path ? ` during ${method} ${path}` : "";
  const routeKind = path === "/api/mutation" ? "write" : path === "/api/query" ? "read" : "request";
  return new FkanbanError({
    code: "service_unreachable",
    message: `${which} ${routeKind} route not reachable ${where}${route} — run \`kanban doctor\` for a diagnosis.`,
    hint:
      service === "node"
        ? "Is a folddb node running? The local node is reached only over its Unix socket (the legacy loopback TCP port is retired), so an absent or unresponsive socket means it isn't up. Start one with `brew services start folddb` (Homebrew install) or `cd fold/fold_db_node && ./run.sh --local --dev` (from the fold monorepo), then re-run `kanban init`."
        : "Check the schema-service URL in ~/.kanban/config.json.",
    cause,
  });
}

function mapSdkDataError(
  err: unknown,
  baseUrl: string,
  method: string,
  path: string,
  socketPath?: string,
): FkanbanError {
  if (err instanceof FkanbanError) return err;
  if (err instanceof CapabilityDeniedError) {
    const body: Record<string, unknown> = { status: 403, reason: err.reason };
    if (err.detail.capabilityId !== undefined) body.capability_id = err.detail.capabilityId;
    if (err.detail.schema !== undefined) body.schema = err.detail.schema;
    if (err.detail.timestampSkewSecs !== undefined) body.timestamp_skew_secs = err.detail.timestampSkewSecs;
    return mapNodeError(403, body, path);
  }
  if (err instanceof PermissionDeniedError) {
    return mapNodeError(403, { kind: "permission_denied", error: err.reason }, path);
  }
  if (err instanceof RequestRejectedError) {
    return mapNodeError(400, err.body ?? { kind: err.kind, error: err.message }, path);
  }
  if (err instanceof UnexpectedResponseError) {
    return mapNodeError(err.status, err.body, path);
  }
  if (err instanceof TransportError) {
    return connectionError(baseUrl, "node", err, socketPath, method, path);
  }
  return new FkanbanError({
    code: "sdk_error",
    message: `SDK call to ${path} failed: ${err instanceof Error ? err.message : String(err)}.`,
    cause: err,
  });
}

function mapNodeError(status: number, body: unknown, path: string): FkanbanError {
  const errCode = bodyError(body);
  const msg = bodyMessage(body);
  if (status === 401 && (errCode === "MISSING_USER_CONTEXT" || msg?.includes("Authentication"))) {
    return new FkanbanError({
      code: "missing_user_context",
      message: `Node rejected ${path}: missing X-User-Hash.`,
      hint: "Re-run `kanban init` so the config's userHash is regenerated.",
    });
  }
  if (status === 503 && errCode === "node_not_provisioned") {
    return new FkanbanError({
      code: "node_not_provisioned",
      message: `Node not set up.`,
      hint: "Run `kanban init` to bootstrap the node.",
    });
  }
  if (status === 409 && errCode === "cas_conflict") {
    return new FkanbanError({
      code: "cas_conflict",
      message: msg ?? `Node rejected ${path}: CAS precondition failed.`,
      cause: body,
    });
  }
  // A transient-busy 503 that survived the in-client retries (callJson tried
  // BUSY_RETRY_MAX times). The node is shedding load, not broken — say so
  // accurately instead of the catch-all "looks like a node-side bug" hint.
  if (isTransientBusy(status, body)) {
    return new FkanbanError({
      code: "node_overloaded",
      message: `Node is overloaded right now (HTTP 503: ${msg ?? "too many concurrent reads"}).`,
      hint:
        `fkanban retried ${BUSY_RETRY_MAX} times; the node is shedding load, not broken — ` +
        "re-run shortly, or raise FKANBAN_HTTP_TIMEOUT_MS.",
    });
  }
  if (status === 400 && (errCode === "unknown_fields" || msg?.includes("unknown"))) {
    // Surface the node's full, raw reason — the message already names which
    // fields aren't writable and which ARE available, and `unknown_fields` /
    // `available_fields` arrays may add detail the message omits. Without this
    // the user only saw "Node /api/mutation returned HTTP 400." with no reason
    // (fkanban #94). Do NOT advise `kanban init` here: when the pinned hash is
    // a stale, narrower schema version (the #94 footgun), re-running init can
    // RE-ADOPT it and keep writes broken. Point at doctor's write-probe instead.
    const unknown = bodyStringArray(body, "unknown_fields");
    const available = bodyStringArray(body, "available_fields");
    const detail =
      msg ??
      (unknown.length > 0
        ? `fields ${unknown.join(", ")} not writable on schema${available.length > 0 ? ` (writable: ${available.join(", ")})` : ""}`
        : "unknown field name");
    return new FkanbanError({
      code: "unknown_fields",
      message: `Node rejected ${path}: ${detail}.`,
      hint:
        "The pinned card schema hash doesn't accept these fields — the node has a " +
        "different (likely stale, narrower) schema version pinned in config. Run " +
        "`kanban doctor` to write-probe the pinned hash; do NOT blindly `kanban init` " +
        "(it can re-adopt the same broken hash).",
    });
  }
  return new FkanbanError({
    code: `node_http_${status}`,
    // Include the full raw body when there's no structured message/error, so a
    // 400 with an unusual shape is never reduced to a bare status (fkanban #94).
    message: `Node ${path} returned HTTP ${status}${msg ? `: ${msg}` : errCode ? "" : rawBodySuffix(body)}${errCode ? ` [${errCode}]` : ""}.`,
    hint: status >= 500 ? "Check the node log; this looks like a node-side bug." : undefined,
  });
}
