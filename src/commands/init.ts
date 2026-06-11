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
// publish --app fkanban`; see README "App creation"). After that, every
// `fkanban init` just loads + resolves the already-published schemas.

import { newNodeClient, FkanbanError, type Verbose } from "../client.ts";
import {
  UNIQUE_SCHEMAS,
  OWNER_APP_ID,
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
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
import { boardToFields, findBoard, nowIso, type Board } from "../record.ts";

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
  // (no-op fallback when the node serves no socket — see attestOwnerSession).
  print(`[1/${STEPS}] probing node identity at ${nodeUrl}`);
  const probe = newNodeClient({ baseUrl: nodeUrl, userHash: existing?.userHash ?? "init-probe", verbose, socketPath });
  const identity = await probe.autoIdentity();

  let userHash: string;
  let bootstrapped = false;
  if (identity.provisioned) {
    userHash = identity.userHash;
    print(`        node already provisioned (user_hash=${userHash.slice(0, 8)}…)`);
  } else {
    print(`        node not provisioned (${identity.reason}); running bootstrap`);
    const res = await probe.bootstrap(bootstrapName);
    userHash = res.userHash;
    bootstrapped = true;
    print(`        bootstrap ok (user_hash=${userHash.slice(0, 8)}…)`);
  }

  const node = newNodeClient({ baseUrl: nodeUrl, userHash, verbose, socketPath });

  // Step 2: load schemas into the node (it pulls everything published in the
  // schema_service, including the `fkanban/*` schemas).
  print(`[2/${STEPS}] loading schemas into the node`);
  const loadResult = await node.loadSchemas();
  if (loadResult.failed_schemas.length > 0) {
    throw new Error(`partial schema load — failed_schemas: ${loadResult.failed_schemas.join(", ")}`);
  }
  print(`        loaded ${loadResult.schemas_loaded_to_db}/${loadResult.available_schemas_loaded} (failed_schemas empty ✓)`);

  // Step 3: resolve each fkanban schema's canonical hash from the node's
  // loaded set, matched by owner_app_id + descriptive_name.
  print(`[3/${STEPS}] resolving ${UNIQUE_SCHEMAS.length} schema hashes for app "${OWNER_APP_ID}"`);
  const loaded = await node.listSchemas();
  const schemaHashes: Record<string, string> = {};
  const missing: string[] = [];
  for (const entry of UNIQUE_SCHEMAS) {
    const descriptive = entry.schema.schema.descriptive_name;
    const match = loaded.find(
      (s) => s.owner_app_id === OWNER_APP_ID && s.descriptive_name === descriptive,
    );
    if (!match || match.name.length === 0) {
      missing.push(`${OWNER_APP_ID}/${descriptive}`);
      continue;
    }
    schemaHashes[entry.key] = match.name;
    print(`        ${descriptive.padEnd(6)} → ${match.name}`);
  }
  if (missing.length > 0) {
    throw new FkanbanError({
      code: "schemas_not_published",
      message: `These fkanban schemas are not registered in the schema service: ${missing.join(", ")}.`,
      hint:
        "Publish them once via the exemem app-creation flow (see README → \"App creation\"):\n" +
        "  folddb-dev app new --id fkanban --metadata-file fkanban.app.json\n" +
        "  folddb-dev app publish --app-file app.json --schema-service-url <url> --dev-api-key <em_…>\n" +
        "  folddb-dev schema register --file card.schema.json && folddb-dev schema publish --schema Card --app fkanban --schema-service-url <url>\n" +
        "  (repeat for Board), then re-run `fkanban init`.",
    });
  }

  // Step 4: persist config.
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
  return { config, bootstrapped };
}
