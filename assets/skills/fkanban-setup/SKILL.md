---
name: fkanban-setup
description: |
  Bootstrap fkanban on a fresh machine or checkout — install deps, run `init`
  (reach a fold_db node + resolve the published schemas + seed the default
  board), verify with `doctor`, and optionally register the MCP server. Use when
  the user says "set up fkanban", "install fkanban", "fkanban can't find config",
  "fkanban doctor fails", or after a fresh clone. For day-to-day card management
  use the `fkanban` skill; to drive a card to a merged PR use `fkanban-agent`.
---

# fkanban — setup & repair

fkanban is a Bun/TypeScript client of a [fold_db](https://folddb.com) node — the
board lives on the node, the CLI just talks to it over HTTP. Setup = make the
CLI able to reach a node that has the `fkanban/*` schemas published.

- **Prerequisites:** a running fold_db node and Bun (≥ 1.3.10). Install the node
  from the Homebrew tap and start it:
  ```bash
  brew install edgevector/folddb/folddb
  brew services start folddb
  curl -s http://127.0.0.1:9001/api/health      # expect {"ok":true,...}
  ```
  Install Bun from <https://bun.sh> if you don't have it.
- **Config:** the CLI reads/writes `~/.fkanban/config.json` (override with
  `$FKANBAN_CONFIG`).

## Happy path

```bash
cd fkanban           # your clone of the repo
bun install
bun link             # optional: exposes a global `fkanban`
fkanban init         # bootstrap + LOAD/RESOLVE published schemas + seed default board
fkanban doctor       # verify: config, node reachable, schemas loaded, query round-trip
```

`init` is **idempotent** — safe to re-run. Defaults: node
`http://127.0.0.1:9001`, schema service = the public prod Lambda
(`https://axo709qs11.execute-api.us-east-1.amazonaws.com`). Resolving the
published schemas needs **no account, key, or sign-up** — it's a read-only
lookup. A green `doctor` ends with `✓ query round-trip — N cards, M boards`;
after that the `fkanban` skill's commands all work.

### Point at a different node / schema service

```bash
fkanban init \
  --node-url http://127.0.0.1:9105 \
  --schema-service-url <schema-service-url>
```

## If `init` reports `schemas_not_published`

The `fkanban/*` schemas haven't been published to that schema service yet. This
is an **author-side, one-time** step (a schema claim in the `fkanban/*`
namespace must be signed by an enrolled developer, so `init` never
self-publishes). If you're just *using* fkanban against the default public
schema service, you should never hit this — the schemas are already published
there. If you're standing up fkanban against your **own** schema service, follow
the "App creation" section in the repo README once, then re-run `fkanban init`.

## If `doctor` fails

- **node unreachable** → the daemon isn't up. Check
  `curl -s http://127.0.0.1:9001/api/health`; start it with
  `brew services start folddb`. Don't kill/restart a node you didn't start.
- **schema hash mismatch / not loaded** → re-run `init`; if it then says
  `schemas_not_published`, see the section above.
- **config missing** → run `init`.

## Register the MCP server (optional)

To drive the board from an agent over MCP:

```bash
cd fkanban
claude mcp add fkanban bun "$PWD/src/mcp/main.ts"
```

It reads the same `~/.fkanban/config.json`.

## Guardrails

- The board is the only copy of its data — don't reset/wipe the node to "start
  clean"; `init` is additive and idempotent.
