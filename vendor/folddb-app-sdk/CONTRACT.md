# The app contract — `@folddb/app-sdk`

This SDK is the **firm boundary between LastDB core and a zero-UI app.** An app
that needs no UI of its own — it connects to a node, writes into its own
namespace, reads it back, searches it, and reacts to a fixed set of refusals —
should need *only* the primitives documented here. If something a zero-UI app
needs is missing from this list, that is a gap in the contract, not something
the app should reach around the SDK to do (as the Brain's vendored subset and
the Kanban's bespoke socket client currently do — see "Convergence gaps").

The README is the full API reference. This document is the **contract**: the
small, stable surface an app depends on, and the guarantee that it does not
change shape underneath the app without a test breaking first.

---

## The app-facing primitives

### 1. Connect + identity

```ts
const app = await connect({ appId, socketPath });     // dev node: UDS-only
const app = await connect({ appId, baseUrl });        // production: TCP + consent
```

- **`appId`** is the app's identity. Every capability, every stored token, and
  every scoped read/write is keyed by it. The node decides an app's access
  scope `S(A)` from the *verified* `app_id` on the capability — the app never
  names or widens its own scope.
- **Transport** is chosen by which of `socketPath` / `baseUrl` you pass. A local
  node is reached over its **Unix-domain data-plane socket** by default (the
  `baseUrl` case socket-discovers it; see the README's "Socket-first
  discovery"). An external app-like caller connecting over that socket is the
  primary path — exercised end-to-end in `test/integration.uds.test.ts`.
- **`defaultHeaders`** carries a production node's required `X-User-Hash`
  identity header on every request. A UDS caller does not need it (the socket
  carries kernel peer credentials).

### 2. Consent lifecycle (production nodes)

```ts
const { requestId } = await app.requestConsent('wildcard' | { explicit: [...] });
const capability   = await app.awaitConsent(requestId, { timeoutMs });
```

`requestConsent` → poll (`awaitConsent` / `pollConsentOnce`) → the SDK stores
the granted capability keyed by `(appId, node)` and auto-attaches it thereafter.
A dev node governs isolation with `folddb app trust` instead and does not serve
consent.

### 3. Data path — the app's own namespace

```ts
await app.mutate(schema, { mutationType, fields, key });   // write one row
await app.query(schema, { fields, limit, offset });        // read (paginated)
await app.queryAll(schema, { fields });                    // drain past the page cap
await app.search(query, { k, target });                    // node-scoped associative search
```

- **`mutate`** writes one row; `key` (`{hash, range}`) addresses it, and a
  `QueryRow.keyValue` from a prior read can be passed straight back to
  update/delete that exact row.
- **`query`** always paginates — a plain call caps at the node's default page
  (100). Check `result.page?.hasMore` or use `queryAll`.
- **Row envelope**: every row carries `key` + `keyValue` + `fields` +
  `metadata` + `authorPubKey` — the app-scoped write metadata a real app needs
  for provenance, not just bare field values.
- **`search`** is node-authoritative: hits come only from schemas in the app's
  `S(A)`; the optional `target` can only *narrow*, never widen.

### 4. The machine-actionable error contract

Every refusal maps to a typed error carrying a **stable discriminator** — an app
branches on the discriminator, never on free text. See `src/errors.ts`.

| Situation | Type | Machine-actionable field |
|---|---|---|
| App not registered | `UnknownAppError` | — |
| App is sandbox-tier | `AppInSandboxError` | — |
| Owner denied / revoked / expired consent | `ConsentDeniedError` / `CapabilityRevokedError` / `ConsentExpiredError` | — |
| Namespace / identity / write isolation refusal | `PermissionDeniedError` | `.category` (`namespace_denied` \| `unverified_identity` \| `write_denied`) |
| Per-write capability refusal | `CapabilityDeniedError` | `.denialReason` — one of the eight `CAPABILITY_DENIAL_REASONS`, plus `.detail` |
| Request-shape / schema-state rejection | `RequestRejectedError` | `.kind` + verbatim `.body` |
| A route the node no longer serves | `UnexpectedResponseError` | `.status` + `.body` |

For the eight discriminated capability reasons, `capabilityDenialReaction()`
returns the design's prescribed reaction (`discardToken` / `reacquire` /
`retryOnce` / `surface`) as pure data the app can act on.

---

## Why route changes break in one place

The exact JSON of every request the SDK emits and every response/error the node
returns is pinned in **[`test/fixtures/wire.ts`](test/fixtures/wire.ts)** — the
compatibility fixtures. Two test suites drive off them:

- **`test/contract.test.ts`** — asserts the SDK emits each pinned request shape
  and parses each pinned response/error into the right typed result.
- **`test/integration.uds.test.ts`** — stands up a LastDB-shaped fake node on a
  real Unix socket and drives the SDK's real transport through the full
  lifecycle (connect → mutate → query → search → the error shapes).

When a LastDB route changes shape, update the fixture to the node's new shape:
the failing assertions name exactly which SDK surface must move with it. That is
the single point of breakage the card asked for — an app never discovers a wire
drift in production.

The fixtures are verified against `origin/main`: consent flow
(`fold_db_node/src/server/routes/apps.rs`), data path
(`folddb_dev_core/src/app_endpoints.rs`), scoped search
(`fold_db_node/src/server/routes/query.rs`), and the discriminated 403 reasons
(`fold_db/crates/core/src/access/capability_denial.rs`).

---

## Convergence gaps (tracked, not closed here)

The SDK is the intended contract, but two in-tree apps do not yet consume it as
such:

- **Brain (`fbrain`)** vendors a subset of these primitives plus its own
  write/capability glue rather than depending on `@folddb/app-sdk` directly.
- **Kanban (`fkanban`)** bypasses the SDK entirely with its own client/socket
  wrappers.

Converging them onto this contract is follow-up work (filed as separate cards),
not part of hardening the contract itself. The direction is captured in
`north-star-lastdb-core-host-app-extraction` and
`design-lastdb-apps-work-like-brain-kanban`.
