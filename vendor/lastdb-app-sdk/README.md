# @lastdb/app-sdk

The runtime SDK for LastDB apps. A thin, dependency-free TypeScript client over
a node's production `/api/*` surface: **connect → request consent → await the
grant → query / mutate with the granted capability.**

This is the runtime data path. It is *not* the app-authoring client — that is
the **`folddb`** CLI (`folddb login` → `folddb init` → `folddb push`), which
publishes your app + its schemas to the shared registry. `folddb dev` only
runs a local dev/test node. This SDK reads and writes a user's data on their
node, scoped to what they consented to.

> **The firm app contract.** The small, stable surface a zero-UI app depends on
> — the app-facing primitives, the machine-actionable error taxonomy, and the
> compatibility fixtures that make a LastDB route change break in ONE place —
> is documented in **[CONTRACT.md](CONTRACT.md)**. This README is the full API
> reference; CONTRACT.md is the boundary guarantee.

> **⚠️ Local dev-node version requirement.** To exercise this SDK against a
> local `folddb dev` node, the node must be **built from `main`** (or a release
> **after `v0.1.0`**). The shipped **`v0.1.0`** `folddb dev` binary serves the
> dev-loop `/dev/*` surface only — it has **no `/api/*` data path, no `app
> trust` verb, and no `/api/app/search`**, so this SDK's `query` / `mutate` /
> `search` calls will not reach it. Build from source with
> `cargo build --release -p fold_db_node --bin lastdb --bin folddb --features dev-mode`
> and confirm `folddb dev app trust --list` is a recognized command.
> (A production `fold_db_node` already
> serves `/api/*`; this caveat is only about the *dev* node.)

## Install

```bash
npm install @lastdb/app-sdk
```

## Quickstart

```ts
import { connect } from '@lastdb/app-sdk';

// Transport: a production node's TCP HTTP surface (`baseUrl`) OR a node's
// UDS control socket (`socketPath`). Against a `fold_db_node::dev_mode` the app data
// surface is UDS-only — use `socketPath` (see "What the dev node supports").
const fold = await connect({ baseUrl: 'http://127.0.0.1:9101', appId: 'fbrain' });

if (!fold.hasCapability) {                                    // first run: no stored capability
  const { requestId } = await fold.requestConsent('wildcard'); // ask for fbrain/*
  console.log('Run: folddb consent grant fbrain');             // owner grants in their terminal
  await fold.awaitConsent(requestId, { timeoutMs: 120_000 });  // polls; stores the capability
}

await fold.mutate('fbrain/Concept', {                          // capability auto-attached
  mutationType: 'create',
  fields: { id: 'c1', title: 'hello' },
  key: { hash: null, range: 'c1' },
});
const { rows } = await fold.query('fbrain/Concept', { fields: ['id', 'title'] });
for (const row of rows) {
  console.log(row.key, row.fields, row.authorPubKey); // full envelope per row
}
```

## Choosing a socket: your own apps vs published apps

Before the transport question (`baseUrl` vs `socketPath`, below) there is a
prior one: **which access posture your app runs under.** A LastDB node exposes
two connection surfaces, and which one your app talks decides whether it runs as
the node owner or as an attributed third-party app. Pick by *who runs the app*,
not by how it connects.

| | **Owner socket** | **App socket** |
|---|---|---|
| For | apps **you develop and trust** (your own tooling) | apps **you publish** for other people to run |
| Runs as | **NodeOwner** — full device trust | an **attributed app** on the consumer's node |
| Reads | anything | anything (after one-time consent) |
| Writes | anything | **only its own `owner_app_id` namespace** |
| Consent | none (peer-cred / device trust) | one-time grant, then a stored capability |
| SDK entry | **`ownerClient(...)`** | **`connect(...)`** |

This is the developer-facing view of the design decisions
[`decision-2026-07-10-apps-read-all-write-own-namespace`][d1] (the 2026-07-11
socket-selection addendum) and [`decision-local-security-loose-stance`][d2] —
read those for the full rationale.

**"App isolation" is not a security wall.** A same-user process can reach the
owner socket regardless, so the app socket's write-own rule is an
**attribution + accident-prevention** boundary — it keeps two honest apps on the
same node from clobbering each other's data (single-writer-per-molecule, so
cross-app reads stay trustworthy), not an adversary defense. That is exactly why
self-authored code just uses the owner socket: you already trust it.

### Owner socket — your own apps (`ownerClient`)

An app you write yourself connects to your node's **owner socket** and runs as
**NodeOwner**: full read/write, no namespace restriction, no consent flow. This
is how LastDB's own tools (fbrain, fkanban, fsituations, lastsecrets) run —
same user, owner socket. `ownerClient` is synchronous and keychain-free (it
never mints, stores, or replays a capability); it authenticates by the OS user
(the socket's kernel peer credentials over UDS, or an `X-User-Hash` header on a
loopback TCP fallback).

```ts
import { ownerClient } from '@lastdb/app-sdk';

// Owner socket: NodeOwner, no consent, no namespace jail.
// FOLDDB_SOCKET_PATH is the node's control socket (LASTDB_SOCKET_PATH is the
// brand-forward alias); over UDS peer credentials authenticate you, so no
// X-User-Hash header is needed.
const db = ownerClient({
  appId: 'fbrain',
  socketPath: process.env.FOLDDB_SOCKET_PATH,
  // baseUrl: 'http://127.0.0.1:9001',  // loopback TCP fallback; then pass
  // defaultHeaders: { 'X-User-Hash': userHash }  // (from autoIdentity())
});

// Full read/write across any schema — device trust, no write-own restriction.
const rows = await db.queryAll('fbrain/Concept', { fields: ['id', 'title'] });
await db.mutate('fbrain/Concept', {
  mutationType: 'create',
  fields: { id: 'c1', title: 'hello' },
  key: { hash: null, range: 'c1' },
});
```

### App socket — apps you publish (`connect`)

An app you **publish for other people** runs through *their* node. When a
consumer runs it, their node launches it into its app-attribution ("app
isolation") system — the **app socket** — where it gets a one-time consent
grant and then **reads any schema but writes only its own `owner_app_id`
namespace**. This is the boundary that makes running someone else's published
app safe-by-default on your data. Use `connect` (async; drives the
request-consent → await-grant flow and stores the resulting capability):

```ts
import { connect } from '@lastdb/app-sdk';

// App socket: attributed app on the consumer's node. See "Transports" below for
// baseUrl (production TCP) vs socketPath (a dev node's UDS).
const db = await connect({ baseUrl: 'http://127.0.0.1:9001', appId: 'my-app' });

if (!db.hasCapability) {                                  // first run: no capability yet
  const { requestId } = await db.requestConsent('wildcard');
  console.log('Run: folddb consent grant my-app');       // the consumer grants in their terminal
  await db.awaitConsent(requestId, { timeoutMs: 120_000 });
}

// Reads: any schema the consumer consented to — including other apps' data.
await db.query('some-other-app/PublicNote', { fields: ['id', 'text'] });
// Writes: confined to your own namespace. A write to another app's namespace is
// rejected by the node (the mutation-chokepoint ownership check), not the SDK.
await db.mutate('my-app/Note', {
  mutationType: 'create',
  fields: { id: 'n1', text: 'hi' },
  key: { hash: null, range: 'n1' },
});
```

The write-own confinement is enforced by the **node** at its mutation chokepoint
(keyed off the attributed app identity), not by this SDK — a cross-namespace
write surfaces as a `403` `PermissionDeniedError` / `CapabilityDeniedError` (see
[Typed errors](#typed-errors)). The owner-socket path has no such restriction.

### Schema resolution and edge adapters

Apps should resolve their app-facing schema names through Schema Service before
using the data path. The SDK accepts a `schemaResolver` that returns
`ResolveResult { identity, schema, adapter, outcome }`: `identity` is the
global schema identity, `schema` is the runtime node schema when it differs,
and `adapter.appToCatalog` rewrites local field names to catalog names before
`query`/`mutate` reaches storage. Reads are mapped back through
`adapter.catalogToApp` or the reverse one-to-one map.

```ts
const db = await connect({
  baseUrl: 'http://127.0.0.1:9001',
  appId: 'my-app',
  schemaResolver: async (schemaName) => {
    if (schemaName !== 'LocalNote') return undefined;
    return {
      identity: 'global-schema-identity-hash',
      schema: 'catalog/Note',
      outcome: 'adapted',
      adapter: {
        appToCatalog: { title: 'name', body: 'body_text' },
      },
    };
  },
});

await db.mutate('LocalNote', {
  mutationType: 'create',
  fields: { title: 'hello', body: 'catalog-shaped at the edge' },
  key: { hash: null, range: 'n1' },
});
```

This keeps storage global and catalog-shaped. A resolver returning
`undefined`/`null` is an explicit pass-through for already-catalog-shaped
callers; creating a new shared-surface language remains a separate publisher
flow, not a runtime fallback.

[d1]: fbrain `decision-2026-07-10-apps-read-all-write-own-namespace`
[d2]: fbrain `decision-local-security-loose-stance`

## Transports

Pass exactly one of `baseUrl` (HTTP) or `socketPath` (the node's Unix-domain
control socket); the transport is chosen by which is present.

```ts
await connect({ baseUrl: 'http://127.0.0.1:9101', appId: 'fbrain' });          // socket-first (see below)
await connect({ socketPath: '/path/to/<session>.sock', appId: 'fbrain' });     // explicit UDS, no discovery
```

### Socket-first discovery (the default app path)

When you pass `baseUrl` — the local-node case — the SDK **prefers the node's
Unix-domain data-plane socket** and falls back to the `baseUrl` TCP listener
only when no socket file is present. The socket is the normal app path
(`folddb.sock`, peer-credential authenticated); TCP is the legacy fallback that
keeps working during the migration. This mirrors the discovery order the Rust
client (`FoldDbHttpClient`, used by the CLI + MCP) follows — with the
brand-forward `LASTDB_SOCKET_PATH` preferred ahead of the Rust client's
`FOLDDB_SOCKET_PATH` — so a TypeScript app and the Rust client agree on where
the socket lives (both explicit overrides point at the same socket when only
one is set):

1. **`LASTDB_SOCKET_PATH`** — canonical explicit socket-path override
   (brand-forward; SDK-preferred). Used when the file exists; a missing path
   falls through.
2. **`FOLDDB_SOCKET_PATH`** — legacy socket-path alias (the current Rust
   client's canonical override), still honored when `LASTDB_SOCKET_PATH` is
   unset.
3. **`FOLDDB_SOCK`** — deprecated socket-path alias, still honored for older
   callers when neither `LASTDB_SOCKET_PATH` nor `FOLDDB_SOCKET_PATH` is set.
   Prefer `LASTDB_SOCKET_PATH` for new scripts.
4. **`<data_dir>/folddb.sock`** — the default the node binds, resolved the same
   way the Rust client resolves it: `<folddb_home>/data/folddb.sock` where
   `folddb_home` honors `LASTDB_HOME` → `FOLDDB_HOME` → an existing `~/.lastdb`
   → an existing `~/.folddb` → `~/.lastdb`. Used only when the file exists.
5. **Loopback TCP at `baseUrl`** — the fallback when no socket file exists (a
   pre-data-plane node, or one whose socket bind failed).

```ts
// Prefer the socket; fall back to TCP if no node serves one. Discovery is
// silent — `fold.target` reports where it landed (`unix:…` or `http://…`).
const fold = await connect({ baseUrl: 'http://127.0.0.1:9001', appId: 'fbrain' });

// Force the TCP listener (e.g. a remote node, or a browser-style HTTP path):
await connect({ baseUrl: 'http://127.0.0.1:9001', appId: 'fbrain', discoverSocket: false });

// An explicit socket is always used verbatim — no discovery, no fallback:
await connect({ socketPath: '/path/to/<session>.sock', appId: 'fbrain' });
```

`discoverTransport({ fallbackBaseUrl, defaultHeaders?, timeoutMs?, env? })` is
also exported directly for callers that build their own transport (it returns a
`Transport` pointed at the discovered socket or the TCP fallback). On non-Unix
platforms there is no UDS transport, so discovery always yields TCP.

## Default headers (production-node identity)

A **production `fold_db_node`** HTTP server is stateless: it resolves the
calling user from an `X-User-Hash` header on *every* request and answers
`401 MISSING_USER_CONTEXT` when it is absent. Pass `defaultHeaders` to attach
such a header to every request the client sends (consent flow + data path):

```ts
await connect({
  baseUrl: 'http://127.0.0.1:9001',
  appId: 'fbrain',
  defaultHeaders: { 'X-User-Hash': userHash },
});
```

A per-call header of the same name wins. This applies to a **production
node's TCP HTTP surface**. A `fold_db_node::dev_mode`'s app data surface is the
**UDS control socket** (a TCP `/api/*` caller is refused — see
[below](#what-the-dev-node-supports-vs-production)) and ignores
`X-User-Hash`, so setting it is always safe.

## Request timeout

Every transport request has a 30s timeout by default, so a hung or wedged node
cannot leave SDK calls pending forever. Override it per client when needed:

```ts
await connect({ baseUrl: 'http://127.0.0.1:9001', appId: 'fbrain', timeoutMs: 5000 });
```

## Capability storage

Granted capabilities are stored, per the App Identity design, in the **OS
keychain** with a **file fallback** on headless machines and non-macOS
platforms:

- macOS: the system Keychain via the `security` CLI (no native addon).
  The Keychain **service label** is configurable via
  `connect({ keychainService })` (default `com.folddb.app-sdk.capability`).
- elsewhere / headless / keychain unavailable: a `0o600` file under
  `$FOLDDB_APP_SDK_HOME` (default `~/.folddb-app-sdk/capabilities/`).

**Testability seam.** The keychain's `security` CLI is invoked through an
injectable `SecurityRunner` — `new KeychainWithFileFallbackStore(baseDir,
service, runner)` (or `new MacKeychainStore(service, runner)`) lets an app's
test suite simulate a hung keychain prompt (`status: null` + `error`), a
locked keychain (non-zero status), or a missing item (`find` exit 44) without
spawning the real CLI. When a runner is injected the darwin platform gate is
skipped, so the keychain path and its file fallback are exercisable on any OS
(CI/Linux). Omit the runner for the real CLI, bounded by the 5s hang timeout.

**Per-node keying.** A capability is minted by one node for one app, so the
store keys entries by **(appId, nodeUrl/socketPath)** — `connect` derives the
key with `capabilityStoreKey(appId, transport.target)`. An app that connects
to more than one node (or whose node URL changes) therefore never replays
node A's capability against node B: the entry for B is a different key, and as
defense-in-depth the stored value records the `boundNode` it was minted for —
a loaded capability whose bound node ≠ the current connection is treated as
**absent** (`load` returns `null`), never blindly sent. The single-node case
is unchanged: one node, one key, auto-loaded on `connect`.

`connect` auto-loads any stored capability for `(appId, node)`. You can also
drive storage explicitly with `storeCapability` / `loadCapability`, or inject
a custom `capabilityStore`.

> **API note (CapabilityStore v2).** The `CapabilityStore` interface now keys
> by an opaque `key: string` the client builds from `(appId, node)`, and
> records the bound node:
> `store(key, capability, boundNode)` /
> `load(key, { expectedNode? })` / `remove(key)`. Pre-v2 the methods took a
> bare `appId`. A custom store written against the old single-arg shape only
> needs to treat the first arg as an opaque id; to gain the wrong-node guard,
> honor `expectedNode` in `load`. Build the key with the exported
> `capabilityStoreKey(appId, nodeTarget)` helper.

## Query result envelope

`query()` returns the node's **full per-row envelope**, not a bare field map.
Each `QueryRow` carries:

| Field | Meaning |
|---|---|
| `key` | the row's storage key rendered to a string (`"hash:range"` / `"hash"` / `"range"`, fold_db's `KeyValue::Display` rendering) — ambiguous when a range contains `:`, so prefer `keyValue` for addressing |
| `keyValue` | the row's **structured** `{hash, range}` key when the node sent one (production `/api/query` does) — pass it back verbatim as `MutationOp.key` to update/delete this exact row; `null` when the node sent a pre-rendered string key (the dev-node mirror) |
| `fields` | the field values, keyed by field name (the flattened convenience shape) |
| `metadata` | per-field write metadata as the node stores it (atom/molecule ids, `writer_pubkey`, …), keyed by field name |
| `authorPubKey` | the pubkey that authored the row (first non-empty `writer_pubkey`), or `null` |

This is the exact shape production `fold_db_node`'s `/api/query` builds
(`{key, fields, metadata, author_pub_key}` per result key); the SDK surfaces
those fields faithfully and invents none. A node that returns bare field-map
rows is still accepted (the object becomes `fields`; `key`/`metadata`/
`authorPubKey` come back empty/`null`).

## Pagination

Production `fold_db_node` **always pages `/api/query`**: with no `limit` it
still caps the response at its default page size (100, `DEFAULT_QUERY_LIMIT`),
so a plain `query()` against a >100-row schema is silently truncated. The SDK
exposes the node's pagination params and metadata:

- `query(schema, { limit, offset })` — forwarded verbatim as the request's
  top-level pagination fields, **only when set**. Both production
  `fold_db_node` and the dev node (`fold_db_node::dev_mode`) honor them with the same
  default/clamp and page metadata.
- `QueryResult.page` — the node's pagination metadata (`totalCount`,
  `returnedCount`, `limit`, `offset`, `hasMore`), or `null` when the node
  reported none. `page?.hasMore` is the truncation signal.
- `queryAll(schema, filter?, { pageSize?, maxRows? })` — auto-paginates until
  the node reports no more rows and returns everything as one result.
  `maxRows` (default 100k) is the safety ceiling; when hit, the returned
  `page.hasMore` stays `true` so the truncation is visible. Works against
  both node kinds — the dev node paginates `/api/query` with production-parity
  semantics, so the drain follows `page.hasMore` identically.

```ts
const all = await fold.queryAll('fbrain/Concept', { fields: ['id', 'title'] });
console.log(all.rowCount, all.page?.hasMore); // every row; false unless maxRows hit
```

## Search (scoped)

`search()` runs the node's **scoped native-index search** (`POST /api/app/search`,
operation 5 of the [app-API contract](https://github.com/EdgeVector/exemem-workspace/blob/main/docs/designs/folddb_app_api.md)) —
associative recall over the user's data, ranked by relevance.

```ts
const { hits } = await fold.search('quantum computing', { k: 10 });
for (const hit of hits) {
  console.log(hit.score, hit.schemaName, hit.key, hit.fields);
  //          ^relevance ^which schema   ^row key  ^full envelope
}
```

Each hit is a full `QueryRow` envelope (`key` + `fields` + `metadata` +
`authorPubKey`, exactly as `query()` returns) plus three search-only fields:

| Field | Meaning |
|---|---|
| `score` | the node's relevance score (cosine), or `null` when none |
| `schemaName` | the schema the hit came from (always within the app's scope) |
| `schemaDisplayName` | the schema's human-readable name, or `null` |

### Scope is node-authoritative — the app cannot widen it

This is the security property that makes scoped search safe to hand an app, and
it is enforced **by the node, not the SDK**:

- The app **never names its scope**. The node derives the access-scope set
  `S(A)` — the schemas the app *owns* plus those it has been *granted* — from
  the capability's verified `app_id` against its own grant ledger, and ranks
  **only** over `S(A)`. Hits come back **only from schemas the app has been
  granted**; everything else is invisible.
- **There is no `schemas` / allowlist parameter, by design.** The SDK exposes a
  single optional `target` — and the node *intersects* it with `S(A)`, never
  unions. `target` can only **narrow** the search; a `target` the app isn't
  granted simply yields **zero hits** (and a normal `200`, never an
  existence-confirming error).
- Scope is enforced by **traversal, not output filtering**: forbidden schemas
  never enter the ranking, so an app cannot infer "there's similar content I
  can't see" from a missing/low result. There is no recall/existence oracle.

```ts
// `target` can only SHRINK the result set to within the app's scope.
// A target outside S(A) is intersected away → { hits: [] }, normal 200.
const scoped = await fold.search('quantum computing', { target: 'fbrain/Concept' });
```

A header-less (capability-less) call is refused by the node with
`403 capability_required` rather than handing back the owner's whole-index
search — the SDK surfaces that as `PermissionDeniedError`.

## Durable change feed

`changes()` reads thin, ordered mutation metadata from `POST /api/app/changes`.
The feed is persisted in a bounded, node-local LastDB namespace; it is not a
sidecar file and is not cloud-synced product data. Consumers must point-read
the authoritative row after each event.

```ts
let cursor: string | undefined;
const page = await fold.changes({ since: cursor, limit: 100 });
if (page.gap) {
  // Cursor fell behind retention: rescan the app's declared product keys.
}
for (const change of page.changes) {
  console.log(change.schemaName, change.key, change.operation);
}
cursor = page.nextCursor; // persist this in an app-owned LastDB record
```

The node derives visible schemas from the verified caller. `target` is a
single optional narrowing filter and cannot widen scope. Cursors are opaque;
`gap` is explicit so a long-offline worker cannot silently treat an incomplete
event history as complete.

## Compare-and-set writes (`expected`)

A `mutate` can carry an optional `expected` **CAS precondition** on a single
field — the write is applied only if the field still holds the value you expect,
so contended writers (ref updates, state-machine transitions, first-writer-wins
rows) don't clobber each other:

```ts
// "update main from oldoid → newoid, but only if it's still at oldoid"
await fold.mutate('myapp/Ref', {
  mutationType: 'update',
  fields: { oid: 'newoid' },
  key: { hash: null, range: 'main' },
  expected: { type: 'value', field: 'oid', value: 'oldoid' },
});

// "create-if-absent": succeed only if `oid` has no current value
await fold.mutate('myapp/Ref', {
  mutationType: 'create',
  fields: { oid: 'firstoid' },
  key: { hash: null, range: 'main' },
  expected: { type: 'absent', field: 'oid' },
});
```

When the precondition fails, the node returns `409 {error:"cas_conflict", …}`
and the SDK throws a typed **`CasConflictError`** carrying `.schema`, `.field`,
`.key`, `.expected`, and `.actual` — so you can re-read the current value and
retry without parsing free text:

```ts
try {
  await fold.mutate('myapp/Ref', { mutationType: 'update', fields, key, expected });
} catch (e) {
  if (e instanceof CasConflictError) {
    // e.field / e.expected / e.actual tell you what moved — re-read and retry.
  } else {
    throw e;
  }
}
```

> Requires a node that implements the `/api/mutation` `expected` primitive.
> Omitting `expected` is an unconditional write (the prior behavior); an older
> node that doesn't understand `expected` ignores it.

## Typed errors

Every node failure maps to a specific error class — there is no catch-all.

| Throw | When |
|---|---|
| `UnknownAppError` | `request-consent` 404 — app not in the registry |
| `AppInSandboxError` | `request-consent` 403 — sandbox-tier, non-owner caller |
| `InvalidScopeError` | `request-consent` 400 — malformed scope |
| `ConsentDeniedError` | `consent-status` 403 `denied` — owner declined |
| `CapabilityRevokedError` | `consent-status` 403 `revoked` — discard token, don't re-prompt |
| `ConsentExpiredError` | `consent-status` 408 — 5-min window elapsed |
| `ConsentRequestNotFoundError` | `consent-status` 404 — unknown `request_id` |
| `ConsentTimeoutError` | client-side `awaitConsent` deadline hit while still pending |
| `PermissionDeniedError` | query/mutation/search 403 — `.category` ∈ `namespace_denied` / `unverified_identity` / `write_denied` / `capability_denied` / `unknown` |
| `CapabilityDeniedError` | a 403 whose body carries a discriminated `reason` (the app_identity v3.1 capability-verifier contract, plus search's `capability_required`) — subclasses `PermissionDeniedError`; carries `.reason` verbatim + `.detail` |
| `CapabilityVerificationError` | a granted/inline capability failed client-side verification under `verifyCapability` — `.problem` ∈ `malformed` / `audience_mismatch` / `integrity_mismatch` |
| `RequestRejectedError` | query/mutation/search 400 — carries the node's `kind`, its message (`error` or `message`), and the raw parsed `.body` verbatim |
| `CasConflictError` | mutation 409 `{error:"cas_conflict"}` — a `MutationOp.expected` precondition did not hold; carries `.schema` / `.field` / `.key` / `.expected` / `.actual` (+ verbatim `.body`) so an app can re-read and retry |
| `TransportError` / `UnexpectedResponseError` | network failure / unmodeled status |

## Public API

```ts
connect(options: ConnectOptions): Promise<LastDbClient>
capabilityStoreKey(appId: string, nodeTarget: string): string

class LastDbClient {
  readonly appId: string
  get target(): string
  get hasCapability(): boolean

  requestConsent(scope?: ConsentScope): Promise<RequestConsentResult>
  awaitConsent(requestId: string, options?: AwaitConsentOptions): Promise<string>
  pollConsentOnce(requestId: string): Promise<string | null>

  storeCapability(capability: string): Promise<void>   // keyed by (appId, node)
  loadCapability(): Promise<string | null>             // wrong-node / failed-verification ⇒ null

  query(schemaName: string, filter?: QueryFilter): Promise<QueryResult>
  queryAll(schemaName: string, filter?: Omit<QueryFilter, 'limit' | 'offset'>,
           opts?: QueryAllOptions): Promise<QueryResult>  // auto-paginates past the node's page cap
  mutate(schemaName: string, op: MutationOp): Promise<MutationResult>
  search(query: string, opts?: SearchOptions): Promise<SearchResult>  // scope is node-authoritative

  autoIdentity(): Promise<AutoIdentityResult>                 // owner/host helper, not capability-scoped
  listSchemas(): Promise<LoadedSchema[]>                      // owner/host helper over GET /api/schemas
  resolveSchema(descriptor: SchemaDescriptor): Promise<LoadedSchema | null>
}

interface QueryFilter {
  fields?: string[]
  filter?: JsonValue                   // fold_db range filter, verbatim
  limit?: number                       // page size (both nodes default 100, clamp 1000)
  offset?: number                      // page offset (both nodes; default 0)
}
interface QueryAllOptions { pageSize?: number /* default 100 */; maxRows?: number /* default 100k */ }
interface QueryResult {
  schema: string; rowCount: number; rows: QueryRow[]
  page: QueryPage | null               // the node's pagination metadata, or null when none reported
}
interface QueryPage { totalCount: number; returnedCount: number; limit: number; offset: number; hasMore: boolean }
interface KeyValue { hash: string | null; range: string | null }
interface QueryRow {
  key: string                          // rendered key string (Display form; ambiguous with ':' ranges)
  keyValue: KeyValue | null            // structured row address — pass back as MutationOp.key
  fields: Record<string, JsonValue>    // the flattened field map
  metadata: JsonValue                  // per-field write metadata (writer_pubkey, …)
  authorPubKey: string | null          // who authored the row
}

interface SearchOptions {
  k?: number                           // top-N hits (node defaults + clamps)
  target?: string                      // ONE schema the node INTERSECTS with S(A); never an allowlist
}
interface SearchResult { hits: SearchHit[] }
interface SearchHit extends QueryRow { // the full row envelope, plus:
  score: number | null                 // relevance (cosine), or null
  schemaName: string                   // which (in-scope) schema the hit came from
  schemaDisplayName: string | null
}

interface MutationOp {
  mutationType: 'create' | 'update' | 'delete'
  fields: Record<string, JsonValue>
  key: KeyValue                        // { hash, range } — pass a QueryRow.keyValue back verbatim
  expected?: CasExpectation            // optional CAS precondition; a failure → CasConflictError
}
type CasExpectation =
  | { type: 'absent'; field: string }               // succeed only if `field` has no current value
  | { type: 'value'; field: string; value: JsonValue } // succeed only if `field` == value
interface MutationResult { written: number; mutationIds: string[]; firingsObserved: number }

// CAS precondition failure — mutation 409 {error:"cas_conflict"}
class CasConflictError extends FoldDbError {
  readonly schema: string | null      // the schema the write targeted
  readonly field: string | null       // the field the precondition checked
  readonly key: string | null         // the row key (rendered)
  readonly expected: string | null    // the value the write expected
  readonly actual: string | null      // the value the node observed (null when the field was absent)
  readonly body: unknown              // the verbatim parsed 409 body
}

type AutoIdentityResult =
  | { provisioned: true; userHash: string; publicKey: string | null; userId: string | null }
  | { provisioned: false; reason: string; next: string | null }
interface LoadedSchema {
  name: string                         // canonical runtime name
  identityHash: string | null          // explicit identity_hash, or name on current nodes
  descriptiveName: string | null
  ownerAppId: string | null
  fields: string[]
}
interface SchemaDescriptor {
  ownerAppId: string
  descriptiveName: string
  fields?: readonly string[]           // exact field set, order-insensitive
}

// Gap #4 — capability 403 contract + client-side verification
class CapabilityDeniedError extends PermissionDeniedError {
  readonly reason: string                       // the node's discriminator, verbatim
  readonly detail: CapabilityDenialDetail       // { capabilityId? schema? timestampSkewSecs? }
  get denialReason(): CapabilityDenialReason | null  // narrowed to the 8-reason contract
}
capabilityDenialReaction(reason, detail?): CapabilityDenialReaction
  // { discardToken, reacquire, retryOnce, surface? } per the design's contract table

canonicalize(value: JsonValue): string          // RFC 8785 JCS (matches the Rust node)
canonicalizeBytes(value: JsonValue): Uint8Array
decodeCapabilityBlob(blob: string): CapabilityToken | null
tokenIntegrityValid(token: CapabilityToken): boolean  // payload_hash == sha256(JCS(payload))
verifyCapabilityBlob(blob: string, expectedAppId: string): CapabilityBlobVerification
```

## What the dev node supports vs. production

The consent + capability-enforcement endpoints
(`/api/apps/request-consent`, `/api/apps/consent-status/{id}`, and the
`X-App-Capability` write gate) are served by a **production `fold_db_node`**.
`fold_db_node::dev_mode` serves the same data dialect (`/api/query`,
`/api/mutation`, `/api/schemas`) but gates app isolation via pid-based dev-trust
(`folddb app trust`) rather than the capability header, and does **not**
serve the consent endpoints. **The app data surface is UDS-only on the dev
node:** `/api/query`, `/api/mutation`, and `/api/app/search` over the TCP
port are refused with `403 tcp_app_surface_closed` — the TCP surface runs as
the node owner, so serving the app routes there would bypass isolation.
Connect with `socketPath`, not `baseUrl`. So:

- Against `folddb dev`: `connect` (via `socketPath`) + `query` + `mutate`
  work end to end once you've `folddb app trust`ed your binary (the
  capability header is accepted-but-ignored; the connecting pid's app
  identity is what's enforced). This is what `e2e/roundtrip.mjs` exercises —
  over the control socket, including the full query-row envelope (`key` +
  `fields` + `metadata` + `authorPubKey`): the dev node's `/api/query` emits
  the same envelope production does, so an app's query parsing is identical
  against either node. The e2e also drives the paginated read path
  (`limit`/`offset` + `page` metadata) and a `queryAll` drain, since the dev
  node now implements production-parity pagination.
- The consent flow (`requestConsent` / `awaitConsent`) targets a production
  node. It is covered by the SDK's unit tests (mock transport asserting the
  exact request/poll JSON + the full error taxonomy).

> **CLI vs SDK mutation shape.** This SDK's `mutate(schema, op)` and the
> dev-loop CLI's `folddb mutate --file` take **different** mutation JSON.
> The SDK submits one row at the `/api/*` boundary —
> `{ mutationType, fields, key: { hash, range } }` (camelCase, schema as the
> 1st arg). The CLI's `POST /dev/mutations` wraps a *batch* with snake_case
> keys — `{ "mutations": [ { schema, mutation_type, key: { range }, fields } ] }`.
> Both paths name the schema `fbrain/Note`: the SDK uses the **canonical
> published** name, and the CLI uses the **namespaced registered** name
> `folddb dev post dev/schemas --app fbrain` produces (it prefixes `<app>/`
> to the file's bare `name`). They agree by construction. See the onboarding
> doc's "CLI vs SDK mutation shape" table:
> [`docs/developer-onboarding.md`](../../docs/developer-onboarding.md#cli-vs-sdk-mutation-shape).
- `search()` targets the node-authoritative `POST /api/app/search` (fold #693).
  `fold_db_node::dev_mode`'s `/api/*` mirror **routes it** (#130): the dev mirror serves
  `POST /api/app/search` with node-authoritative scope (it resolves `S(A)` from
  the caller's verified posture against the active namespace ACL — the app never
  names its own scope). `e2e/search.mjs` drives the SDK against an ephemeral dev
  node end-to-end.

## Owner / Host Helpers

`autoIdentity()`, `listSchemas()`, and `resolveSchema()` are deliberately
owner/host-context helpers. They cover the two node endpoints LastDB owner apps
kept hand-rolling while using the SDK for the app data plane:

- `GET /api/system/auto-identity` returns the local owner identity used for
  `X-User-Hash`; the node's canonical 503 becomes
  `{ provisioned: false, reason, next }`.
- `GET /api/schemas` lists loaded schemas; `resolveSchema({ ownerAppId,
  descriptiveName, fields })` resolves the app's own descriptor to the
  loaded canonical `identityHash`/`name` without each app re-parsing raw JSON.

These helpers do not attach `X-App-Capability` and do not represent an app's
capability-scoped access set `S(A)`. They are for owner-side setup, diagnostics,
and host-context tools such as fbrain and fsituations.

## Capability 403 contract + client-side verification (gap #4)

A production node's capability verifier refuses a write with one of **eight
discriminated reasons** (`fold_db/crates/core/src/access/capability_denial.rs`),
rendered as `403 {status: 403, reason: "<reason>", ...detail}`:
`capability_revoked` · `capability_expired` · `capability_unknown` ·
`capability_out_of_scope` (+`schema`) · `capability_replay`
(+`timestamp_skew_secs`) · `capability_bad_sig` · `capability_for_wrong_node` ·
`consent_required`. The SDK surfaces any reason-tagged data-path 403 as
`CapabilityDeniedError` with the node's `reason` **verbatim** plus the detail
fields, and ships the design's contract reaction table as pure data:

```ts
import { CapabilityDeniedError, capabilityDenialReaction } from '@lastdb/app-sdk';

try {
  await client.mutate('appa/Notes', op);
} catch (e) {
  if (e instanceof CapabilityDeniedError && e.denialReason !== null) {
    const r = capabilityDenialReaction(e.denialReason, e.detail);
    // r.discardToken / r.reacquire / r.retryOnce / r.surface — apply per your app's lifecycle
  }
}
```

The SDK can also verify a capability blob **client-side** before storing or
replaying it. A token's `envelope.payload_hash` is
`sha256(JCS(token-minus-envelope))` — RFC 8785 canonicalization, byte-identical
to the node's Rust `app_identity_crypto` canonicalizer (pinned by the shared
golden vectors). Opt in via `connect({ ..., verifyCapability: true })`:

- a **granted** token (`awaitConsent`) is gated on audience binding
  (`token.app_id === appId`) + JCS integrity — a mismatch throws
  `CapabilityVerificationError` and nothing is stored;
- a **cached** token (`connect` auto-load / `loadCapability`) that fails is
  discarded and treated as absent — never replayed into a guaranteed
  `capability_bad_sig` 403.

The default is off (verbatim token-carrier behavior — e.g. a dev node's
`app trust` override has no real token). The helpers are exported standalone:
`canonicalize` / `canonicalizeBytes` (RFC 8785 JCS), `decodeCapabilityBlob`,
`tokenIntegrityValid`, `verifyCapabilityBlob`, `sha256Hex`. The client never
re-signs anything — the node's Ed25519 signature check remains the enforcement
point; this just keeps the client's cache clean and fails fast.

## Known limitations

- **No JCS request digest.** The node binds a capability to the request via
  headers (`X-App-Capability` + `X-Capability-Ts`), not a per-request
  canonicalized digest; if a future node dialect adds one, the JCS module here
  is the building block.

## Development

```bash
npm install
npm run build        # tsc → dist/
npm test             # vitest (mock-transport error mapping + capability store)
npm run lint
node e2e/roundtrip.mjs   # connect → mutate → query, against an ephemeral folddb dev node
node e2e/search.mjs      # scoped search() contract + node-authoritative scope (see e2e/)
```
