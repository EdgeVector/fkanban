---
name: fkanban-setup
description: |
  Bootstrap fkanban on a fresh machine or checkout — install deps, run `init`
  (node + resolve published schemas + seed the default board), verify with
  `doctor`, and optionally register the MCP server. Use when the user says
  "set up fkanban", "fkanban isn't working / can't find config", "install
  fkanban", "fkanban doctor fails", "bootstrap the kanban board", or after a
  fresh clone of EdgeVector/fkanban. For day-to-day card management use the
  `fkanban` skill; to work a card to a merged PR use `fkanban-agent`.
---

# fkanban — setup & repair

fkanban is a Bun/TypeScript client of a fold_db node — the board lives on the
node, the CLI just talks to it over HTTP. Setup = make the CLI able to reach a
node that already has the `fkanban/*` schemas published.

Repo: **`EdgeVector/fkanban`**, local at `~/code/edgevector/fkanban`. Run the
CLI as `bun src/cli.ts <cmd>` from that directory (no global binary).
Config it reads/writes: `~/.fkanban/config.json` (override with `$FKANBAN_CONFIG`).

## Happy path (node already running with fkanban schemas)

This is the normal case — the port-9001 brain already has `fkanban/*` published.

```bash
cd ~/code/edgevector/fkanban
bun install
bun src/cli.ts init        # bootstrap + LOAD/RESOLVE published schemas + seed default board
bun src/cli.ts doctor      # verify: config, node reachable, schemas loaded, query round-trip
```

`init` is **idempotent** — safe to re-run. Defaults: node
`http://127.0.0.1:9001`, schema service = **prod** Lambda
(`https://axo709qs11.execute-api.us-east-1.amazonaws.com`).

A green `doctor` ends with `✓ query round-trip — N cards, M boards`. After
that, the `fkanban` skill's commands all work.

## Point at an ephemeral / dev node instead

For a throwaway node (don't touch Tom's port-9001 brain when iterating):

```bash
bun src/cli.ts init \
  --node-url http://127.0.0.1:9105 \
  --schema-service-url https://y0q3m6vk75.execute-api.us-west-2.amazonaws.com   # dev, us-west-2
```

## If `init` reports `schemas_not_published`

The `fkanban/*` schemas haven't been published to that schema service yet.
Under app_identity v3.1 a claim in the `fkanban/*` namespace must be signed by
an enrolled developer's DevCert, so publishing is a **one-time, out-of-band**
step — `init` never self-publishes. Run the app-creation flow once:

1. Enroll a developer (use the **`app-identity-dev-enroll`** skill): mint an
   `EXEMEM_DEV_API_KEY` (`em_<48 hex>`) + `folddb-dev developer init` +
   `developer_access=true` row in `ExememDevelopers-<env>`.
2. Register + publish the app and its two schemas (full commands in the repo
   README "App creation" section):
   ```bash
   folddb-dev app new --id fkanban --metadata-file fkanban.app.json --out app.json
   folddb-dev app publish --app-file app.json --schema-service-url <url> --dev-api-key "$EXEMEM_DEV_API_KEY"
   # emit src/schemas.ts → card.schema.json / board.schema.json, then in a dev session:
   folddb-dev schema register --file card.schema.json  --session fkanban-pub
   folddb-dev schema register --file board.schema.json --session fkanban-pub
   folddb-dev schema publish --schema Card  --app fkanban --schema-service-url <url> --session fkanban-pub
   folddb-dev schema publish --schema Board --app fkanban --schema-service-url <url> --session fkanban-pub
   ```
   Publishes are **async** — the rows take a few seconds to appear
   (`folddb-dev app list` / `curl .../v1/schema/<hash>` to confirm).
3. Re-run `bun src/cli.ts init`.

Known prod-publish gotchas (seen during the original fkanban publish):
rebuild `folddb-dev` if it's a stale pre-pin binary, and clear the single-slot
`dev_cert.json` cache if a dev cert was reused against prod (→ `cert_invalid`).

## If `doctor` fails

- **node unreachable** → the daemon isn't up. Check `curl -s
  http://127.0.0.1:9001/api/health`. **Never** kill/restart the port-9001 brain
  to "fix" this — surface it to Tom; restart only a node you own.
- **schema hash mismatch / not loaded** → re-run `init`; if it then says
  `schemas_not_published`, do the app-creation step above.
- **config missing** → run `init`.

## Register the MCP server (optional)

To drive the board from an agent over MCP:

```bash
cd ~/code/edgevector/fkanban
claude mcp add fkanban bun "$PWD/src/mcp/main.ts"
```

It reads the same `~/.fkanban/config.json`.

## Guardrails

- The board is shared state on the port-9001 brain — don't reset/wipe the node
  to "start clean"; `init` is additive and idempotent.
- When iterating on fkanban itself, prefer an **ephemeral dev node** over the
  daily-driver brain.
```
