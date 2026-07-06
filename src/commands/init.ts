// `fkanban init` — bring a node to the point where the CLI/MCP can read +
// write the board:
//
//   1. probe identity, bootstrap the node if needed
//   2. load schemas into the node (it pulls the published `fkanban/*` schemas
//      from the schema_service)
//   3. resolve each schema's canonical hash from the node's loaded set
//   4. persist ~/.fkanban/config.json
//   5. seed the default board (idempotent)
//
// fkanban does NOT publish its own schemas. Under app_identity v3.1 a schema
// claim under the `fkanban/*` namespace must be signed by an enrolled
// developer's DevCert — that's a one-time out-of-band step done via the
// exemem app-creation flow (`folddb-dev app publish` + `folddb-dev schema
// publish --app fkanban`; see README "Republishing the schemas"). After that, every
// `fkanban init` just loads + resolves the already-published schemas.

import { newNodeClient, FkanbanError, type NodeClient, type Verbose } from "../client.ts";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fkanbanInvocation, mcpAddCommand } from "../mcp/register.ts";
import {
  UNIQUE_SCHEMAS,
  OWNER_APP_ID,
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
  resolveLoadedSchema,
} from "../schemas.ts";
import {
  CONFIG_VERSION,
  defaultConfigPath,
  resolveSocketPath,
  tryReadConfig,
  writeConfig,
  schemaHashFor,
  type Config,
} from "../config.ts";
import {
  boardToFields,
  findBoard,
  listBoards,
  nowIso,
  probeSchemaWritable,
  type Board,
} from "../record.ts";

// `:9001` is the homebrew fold_db_node daemon; the schema service defaults to
// the prod cloud Lambda. Override both with --node-url / --schema-service-url
// (e.g. point at an ephemeral dev node + the dev Lambda).
export const DEFAULT_NODE_URL = "http://127.0.0.1:9001";
export const DEFAULT_SCHEMA_SERVICE_URL =
  "https://axo709qs11.execute-api.us-east-1.amazonaws.com";

export type InitOptions = {
  nodeUrl?: string;
  schemaServiceUrl?: string;
  // Override the node's Unix-domain control socket for owner-session
  // attestation. Persisted to config when given so later CLI/MCP invocations
  // reuse it. Omit to derive from FOLDDB_HOME / FOLDDB_SOCKET_PATH.
  nodeSocketPath?: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
};

export type InitResult = { config: Config; bootstrapped: boolean };

const STEPS = 5;

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;
  const bootstrapName = opts.bootstrapName ?? "fkanban";
  const configPath = opts.configPath ?? defaultConfigPath();
  const existing = tryReadConfig(configPath);

  const nodeUrl = opts.nodeUrl ?? existing?.nodeUrl ?? DEFAULT_NODE_URL;
  const schemaServiceUrl =
    opts.schemaServiceUrl ?? existing?.schemaServiceUrl ?? DEFAULT_SCHEMA_SERVICE_URL;
  // Persist the socket path to config only when explicitly given; otherwise
  // leave it unset so it keeps resolving from FOLDDB_HOME / FOLDDB_SOCKET_PATH.
  const nodeSocketPath = opts.nodeSocketPath ?? existing?.nodeSocketPath;
  const socketPath = resolveSocketPath({ nodeSocketPath });

  // Step 1: probe identity, bootstrap if needed. The schema-load path below is
  // an owner verb that 403s `transport_not_attested` on an app-isolation node,
  // so every node client here attests an owner session over the control socket
  // (no-op fallback when the node serves no socket).
  print(`[1/${STEPS}] probing node identity at ${nodeUrl}`);
  const probe = newNodeClient({ baseUrl: nodeUrl, userHash: existing?.userHash ?? "init-probe", verbose, warn: print, socketPath });

  let identity: Awaited<ReturnType<NodeClient["autoIdentity"]>>;
  try {
    identity = await probe.autoIdentity();
  } catch (err) {
    // Older socket configurations may still be unable to answer this setup
    // probe. When TCP is gone but an existing config can prove the board's data
    // plane over the socket, reuse that config instead of printing a stale
    // start-a-TCP-node diagnosis.
    const degraded = await tryInitSocketOnly({
      err,
      existing,
      nodeUrl,
      schemaServiceUrl,
      nodeSocketPath,
      socketPath,
      configPath,
      verbose,
      print,
    });
    if (degraded) return degraded;
    throw err;
  }

  let userHash: string;
  let bootstrapped = false;
  if (identity.provisioned) {
    userHash = identity.userHash;
    print(`        node already provisioned (user_hash=${userHash.slice(0, 8)}…)`);
  } else {
    print(`        node not provisioned (${identity.reason}); running bootstrap`);
    let res: Awaited<ReturnType<NodeClient["bootstrap"]>>;
    try {
      res = await probe.bootstrap(bootstrapName);
    } catch (err) {
      throw freshSetupSocketError(err, socketPath, "/api/setup/bootstrap") ?? err;
    }
    userHash = res.userHash;
    bootstrapped = true;
    print(`        bootstrap ok (user_hash=${userHash.slice(0, 8)}…)`);
  }

  // The probe (step 1) already emitted the one-line "control socket not found"
  // warning if the socket is missing, so the schema-load client stays quiet on
  // that front — it still raises the actionable `node_attestation_unavailable`
  // error if the owner verb 403s.
  const node = newNodeClient({ baseUrl: nodeUrl, userHash, verbose, socketPath });

  // Step 2: load schemas into the node (it pulls everything published in the
  // schema_service, including the `fkanban/*` schemas).
  print(`[2/${STEPS}] loading schemas into the node`);
  let loadResult: Awaited<ReturnType<NodeClient["loadSchemas"]>>;
  try {
    loadResult = await node.loadSchemas();
  } catch (err) {
    const degraded = await tryInitSocketOnly({
      err,
      existing,
      nodeUrl,
      schemaServiceUrl,
      nodeSocketPath,
      socketPath,
      configPath,
      verbose,
      print,
    });
    if (degraded) return degraded;
    throw freshSetupSocketError(err, socketPath, "/api/schemas/load") ?? err;
  }
  if (loadResult.failed_schemas.length > 0) {
    throw new Error(`partial schema load — failed_schemas: ${loadResult.failed_schemas.join(", ")}`);
  }
  print(`        loaded ${loadResult.schemas_loaded_to_db}/${loadResult.available_schemas_loaded} (failed_schemas empty ✓)`);

  // Step 3: resolve each fkanban schema's canonical hash from the node's
  // loaded set. The node can have MORE THAN ONE schema sharing
  // owner_app_id + descriptive_name (a stale, narrower version lingering beside
  // the current one — fkanban #94). `resolveLoadedSchema` therefore prefers the
  // candidate whose FIELDS superset the local definition, so we never pin config
  // to a narrower version the node would reject every write against.
  print(`[3/${STEPS}] resolving ${UNIQUE_SCHEMAS.length} schema hashes for app "${OWNER_APP_ID}"`);
  let loaded: Awaited<ReturnType<NodeClient["listSchemas"]>>;
  try {
    loaded = await node.listSchemas();
  } catch (err) {
    const degraded = await tryInitSocketOnly({
      err,
      existing,
      nodeUrl,
      schemaServiceUrl,
      nodeSocketPath,
      socketPath,
      configPath,
      verbose,
      print,
    });
    if (degraded) return degraded;
    throw err;
  }
  const schemaHashes: Record<string, string> = {};
  const missing: string[] = [];
  const narrower: string[] = [];
  for (const entry of UNIQUE_SCHEMAS) {
    const descriptive = entry.schema.schema.descriptive_name;
    const resolution = resolveLoadedSchema(entry.key, loaded);
    if (resolution.kind === "missing") {
      missing.push(`${OWNER_APP_ID}/${descriptive}`);
      continue;
    }
    if (resolution.kind === "narrower") {
      // Every loaded `fkanban/<descriptive>` is narrower than the app expects —
      // adopting it would 400 every write. Refuse, naming the missing fields.
      narrower.push(
        `${OWNER_APP_ID}/${descriptive} (loaded hash ${resolution.hash} is missing fields: ${resolution.missingFields.join(", ")})`,
      );
      continue;
    }
    schemaHashes[entry.key] = resolution.hash;
    print(
      `        ${descriptive.padEnd(6)} → ${resolution.hash}` +
        (resolution.ambiguous ? " (multiple write-compatible versions loaded; picked one)" : ""),
    );
  }
  if (narrower.length > 0) {
    throw new FkanbanError({
      code: "schema_not_writable",
      message:
        `The node's loaded ${narrower.length === 1 ? "schema is" : "schemas are"} an OLDER, narrower ` +
        `version than this fkanban build expects — adopting ${narrower.length === 1 ? "it" : "them"} would ` +
        `reject every write:\n  ${narrower.join("\n  ")}`,
      hint:
        "Do NOT pin config to a narrower schema. The node needs the current " +
        "fkanban/* schema version (with all fields) loaded. Either the current " +
        "version isn't published to the schema_service the node uses, or only a " +
        "stale version is loaded. Republish/load the current fkanban/* schemas " +
        "(README → \"Republishing the schemas\"), then re-run `fkanban init`. " +
        "Your existing config was left untouched, so current writes keep working.",
    });
  }
  if (missing.length > 0) {
    throw new FkanbanError({
      code: "schemas_not_published",
      message: `These fkanban schemas are not registered in the schema service: ${missing.join(", ")}.`,
      hint:
        "The NODE loads schemas from its OWN configured schema_service (via " +
        "/api/schemas/load) — the CLI's --schema-service-url flag does NOT drive " +
        "this and changing it won't fix the failure. The schema_service the node " +
        "uses just doesn't have the fkanban/* schemas published yet.\n" +
        "Fix (node-side): publish fkanban/* to the schema_service the node is " +
        "configured to use, or point the node at a schema_service where fkanban/* " +
        "already lives, then re-run `fkanban init`. The fkanban/* schemas are " +
        "already published on the default prod schema_service.\n" +
        `(For reference, the schema_service URL recorded in config is ${schemaServiceUrl}; ` +
        "it's informational/diagnostic only — the node, not the CLI, decides where schemas load from.)\n" +
        "\n" +
        "Maintainer only — standing the schemas up on a *new* schema_service:\n" +
        "  Publish fkanban/* via the exemem app-creation flow, then re-run `fkanban init`.\n" +
        "  See README → \"Republishing the schemas\" (needs a DevCert + enrolled developer + em_… API key).",
    });
  }

  // Step 3b: WRITE-PROBE each resolved hash before adopting it. The
  // field-superset resolution above catches a narrower schema only when the
  // node reports `fields`; this probe is the runtime backstop — it creates +
  // deletes a throwaway record carrying EVERY field against each resolved hash,
  // so a hash is adopted only once a real all-fields write round-trips. This is
  // the guard that closes the #94 footgun where `init` happily pinned a
  // resolved-but-not-writable hash and broke every subsequent `add`.
  print(`[3b/${STEPS}] write-probing resolved schema hashes`);
  const notWritable: string[] = [];
  for (const entry of UNIQUE_SCHEMAS) {
    const hash = schemaHashes[entry.key];
    if (!hash) continue;
    const probe = await probeSchemaWritable(node, hash, entry.key);
    if (probe.writable) {
      print(`        ${entry.key.padEnd(6)} writable ✓`);
    } else {
      notWritable.push(`${entry.key} (${hash}): ${probe.reason}`);
    }
  }
  if (notWritable.length > 0) {
    throw new FkanbanError({
      code: "schema_not_writable",
      message:
        `A write probe was REJECTED for the resolved schema ${notWritable.length === 1 ? "hash" : "hashes"} — ` +
        `the node will not accept fkanban's full field set, so init is refusing to adopt ` +
        `${notWritable.length === 1 ? "it" : "them"} (this would otherwise break every ` +
        `subsequent write):\n  ${notWritable.join("\n  ")}`,
      hint:
        "The node has a schema version that resolves but isn't writable for all " +
        "fields. Load/republish the current fkanban/* schemas on the node " +
        "(README → \"Republishing the schemas\"), then re-run `fkanban init`. " +
        "Your existing config was left untouched — current writes keep working.",
    });
  }

  // Step 4: persist config — only now that every resolved hash write-probed OK.
  print(`[4/${STEPS}] writing config to ${configPath}`);
  const config: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl,
    userHash,
    schemaHashes,
    ...(nodeSocketPath !== undefined ? { nodeSocketPath } : {}),
  };
  writeConfig(config, configPath);

  // Step 5: seed the default board (idempotent upsert).
  print(`[5/${STEPS}] seeding default board "${DEFAULT_BOARD_SLUG}"`);
  const boardHash = schemaHashFor("board", config);
  const existingBoard = await findBoard(node, config, DEFAULT_BOARD_SLUG);
  if (!existingBoard) {
    const now = nowIso();
    const board: Board = {
      slug: DEFAULT_BOARD_SLUG,
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    };
    await node.createRecord({ schemaHash: boardHash, fields: boardToFields(board), keyHash: board.slug });
    print(`        created board "${DEFAULT_BOARD_SLUG}" with columns ${DEFAULT_COLUMNS.join(", ")}`);
  } else {
    print(`        board "${DEFAULT_BOARD_SLUG}" already exists — leaving as-is`);
  }

  print(`[init] ok`);
  // Surface the full Next steps block (incl. the `claude mcp add` registration
  // line) on a genuine FIRST-TIME fkanban setup — `existing === null` means no
  // `~/.fkanban/config.json` pre-existed — OR a fresh node bootstrap. A
  // first-time `init` pointed at an *already-provisioned* node leaves
  // `bootstrapped` false, but it's still first-time fkanban setup and the dev
  // most needs the MCP hint, so don't hide it. A true re-init (config already
  // present) still collapses to the quiet one-line hint.
  const freshFkanbanConfig = existing === null;
  printNextSteps(print, bootstrapped || freshFkanbanConfig);

  return { config, bootstrapped };
}

function freshSetupSocketError(err: unknown, socketPath: string, route: string): FkanbanError | null {
  if (!(err instanceof FkanbanError) || err.code !== "service_unreachable") return null;
  const fullSocketPath = basename(socketPath) === "folddb-full.sock"
    ? socketPath
    : join(dirname(socketPath), "folddb-full.sock");
  if (existsSync(fullSocketPath)) return null;
  return new FkanbanError({
    code: "full_surface_socket_unavailable",
    message:
      `Cannot complete first-time fkanban setup over ${socketPath}: ${route} needs the ` +
      `node's full-surface owner socket, but ${fullSocketPath} does not exist.`,
    hint:
      "This node appears to expose only the narrow data/attestation socket. Use a node build " +
      "or startup mode that creates <data>/folddb-full.sock for setup writes, then re-run " +
      "`fkanban init --node-socket-path <data>/folddb.sock`. Existing provisioned nodes can " +
      "still be used over the narrow socket; fresh bootstrap/schema-load needs the full surface.",
    cause: err,
  });
}

// Graceful degradation for a socket-only node: the TCP control-plane is
// unreachable (legacy `:9001` retired / refused) but the node serves the data
// plane over its Unix socket. Returns an `InitResult` when init can complete
// over the socket alone, or `null` when it cannot (so the caller re-throws the
// original TCP error). Completing over the socket requires:
//   1. the TCP failure was a genuine *unreachable* (connection refused), not a
//      different node error — a 401/500 etc. is a real answer to re-surface;
//   2. an EXISTING valid config (init can't resolve schema hashes without TCP,
//      so a first-ever init on a socket-only node still can't proceed — but it
//      gets a socket-aware error from the caller's re-throw path);
//   3. the socket data-plane actually round-trips a board query (proves the
//      node is UP + the pinned schemas are loaded), confirming the TCP-only
//      bootstrap/load/resolve steps are moot.
// When all hold, it re-seeds the default board over the socket (idempotent) and
// reports the node UP via the socket.
async function tryInitSocketOnly(args: {
  err: unknown;
  existing: Config | null;
  nodeUrl: string;
  schemaServiceUrl: string;
  nodeSocketPath: string | undefined;
  socketPath: string;
  configPath: string;
  verbose: Verbose | undefined;
  print: (line: string) => void;
}): Promise<InitResult | null> {
  const { err, existing, nodeUrl, schemaServiceUrl, nodeSocketPath, socketPath, configPath, verbose, print } = args;

  // Only degrade for a genuine "TCP unreachable" — not a real node-side error
  // (401/500/etc.), which must surface as-is.
  if (!(err instanceof FkanbanError) || err.code !== "service_unreachable") return null;

  // Without a prior config we have no pinned schema hashes, and the only way to
  // resolve them (the TCP schema-list route) is exactly what's down. Can't
  // complete a first-ever init over the socket — let the caller re-throw the
  // (socket-aware) unreachable error.
  if (!existing) return null;

  // Prove the socket data-plane is live: round-trip a board query over it. If
  // this also fails the node is genuinely down (or there's no socket) — bail so
  // the original TCP-unreachable error stands.
  const node = newNodeClient({ baseUrl: nodeUrl, userHash: existing.userHash, verbose, socketPath });
  const transport = node.nodeTransport();
  if (transport.transport !== "socket") return null;
  try {
    await listBoards(node, existing);
  } catch {
    return null;
  }

  print(
    `        node TCP control-plane unreachable, but the data-plane socket ` +
      `${transport.socketPath} is live — degrading to a socket-only re-init`,
  );
  print(`        (bootstrap + schema load/resolve are TCP-only system routes; ` + `skipping — the node is already provisioned with the fkanban/* schemas loaded)`);

  // Persist config unchanged (re-affirm the existing pins). Carry the socket
  // path through if it was explicitly given, mirroring the TCP path.
  const config: Config = {
    configVersion: CONFIG_VERSION,
    nodeUrl,
    schemaServiceUrl,
    userHash: existing.userHash,
    schemaHashes: existing.schemaHashes,
    ...(nodeSocketPath !== undefined ? { nodeSocketPath } : {}),
  };
  print(`[4/${STEPS}] writing config to ${configPath}`);
  writeConfig(config, configPath);

  // Seed the default board over the socket (idempotent) — `/api/mutation` +
  // `/api/query` are exactly the routes the data-plane socket serves.
  print(`[5/${STEPS}] seeding default board "${DEFAULT_BOARD_SLUG}" (over the socket)`);
  const boardHash = schemaHashFor("board", config);
  const existingBoard = await findBoard(node, config, DEFAULT_BOARD_SLUG);
  if (!existingBoard) {
    const now = nowIso();
    const board: Board = {
      slug: DEFAULT_BOARD_SLUG,
      title: "Default board",
      body: "",
      columns: [...DEFAULT_COLUMNS],
      created_at: now,
      updated_at: now,
    };
    await node.createRecord({ schemaHash: boardHash, fields: boardToFields(board), keyHash: board.slug });
    print(`        created board "${DEFAULT_BOARD_SLUG}" with columns ${DEFAULT_COLUMNS.join(", ")}`);
  } else {
    print(`        board "${DEFAULT_BOARD_SLUG}" already exists — leaving as-is`);
  }

  print(`[init] ok (socket-only — TCP control-plane unavailable)`);
  // A degraded re-init over an existing config is, by definition, not a
  // first-time setup, so emit the quiet one-line hint.
  printNextSteps(print, false);

  return { config, bootstrapped: false };
}

// Guide the next action. On a genuine first-time fkanban setup — no prior
// `~/.fkanban/config.json`, OR a freshly bootstrapped node — emit a
// copy-pasteable Next steps block (list the board, add a card, register the MCP
// server). This is the natural moment to surface the `claude mcp add` command,
// which is otherwise discoverable only by reading the README; it must NOT be
// hidden from someone whose first `init` happened to point at an
// already-provisioned node (where the node wasn't bootstrapped). On an
// idempotent re-init (config already present), collapse to a single quiet line
// so re-runs stay calm. Every command is printed in the form that actually runs
// for THIS dev — `fkanbanInvocation()` returns the global `fkanban` shim when
// it's on PATH, else `bun run src/cli.ts` from the repo (the fresh-clone
// default, before `bun run install-cli`) — so copy-pasting never hits `command
// not found: fkanban`. The `invocation` arg is injectable for unit testing both
// branches without touching PATH. Threaded through the same `print` callback as
// the rest of `init` so test/`--json` callers stay deterministic. Exported for
// unit testing.
export function printNextSteps(
  print: (line: string) => void,
  firstTimeSetup: boolean,
  invocation: string = fkanbanInvocation(),
): void {
  if (firstTimeSetup) {
    // Align the trailing `#` comments to a common column for readability; the
    // `add` line is the longest, so pad the others to match it.
    const listCmd = `${invocation} list`;
    const addCmd = `${invocation} add my-first-card --title "..."`;
    const col = Math.max(listCmd.length, addCmd.length) + 3;
    print("");
    print("Next steps:");
    print(`  ${listCmd.padEnd(col)}# see your board`);
    print(`  ${addCmd.padEnd(col)}# add a card`);
    print(`  ${mcpAddCommand()}   # register the MCP server`);
  } else {
    print("");
    print(`Already initialized — run \`${invocation} list\` to see your board.`);
  }
}
