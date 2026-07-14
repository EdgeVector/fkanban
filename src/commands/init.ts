// `kanban init` — bring a node to the point where the CLI/MCP can read +
// write the board:
//
//   1. probe identity, bootstrap the node if needed
//   2. declare fkanban's private schemas locally on the Mini node
//   3. capture each schema's canonical hash from the local declaration result
//   4. persist ~/.kanban/config.json
//   5. seed the default board (idempotent)
//
// fkanban's Card/Board schemas are app-private implementation details. Mini
// declares them through its local `/api/apps/declare-schema` route and returns
// deterministic app-namespaced canonical hashes. The schema service is reserved
// for explicit shared-surface publish/attach flows, not ordinary private init.

import { newNodeClient, FkanbanError, type NodeClient, type Verbose } from "../client.ts";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fkanbanInvocation, mcpAddCommand } from "../mcp/register.ts";
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
import {
  boardToFields,
  findBoard,
  listBoards,
  nowIso,
  probeSchemaWritable,
  type Board,
} from "../record.ts";

// A local LastDB node is reached over its Unix-domain control socket, NOT over
// TCP. DEFAULT_NODE_URL is a loopback *marker* (hostname only) so clients select
// socket transport — it is not a TCP endpoint. The retired :9001 control plane
// must not appear in new configs. Schema service defaults to the prod cloud
// Lambda. Override with --node-url / --schema-service-url when needed.
export const DEFAULT_NODE_URL = "http://127.0.0.1";
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

  const STALE_NODE_URLS = new Set([
    "http://127.0.0.1:9001",
    "http://localhost:9001",
  ]);
  let nodeUrl = opts.nodeUrl ?? existing?.nodeUrl ?? DEFAULT_NODE_URL;
  if (!opts.nodeUrl && existing?.nodeUrl && STALE_NODE_URLS.has(existing.nodeUrl)) {
    nodeUrl = DEFAULT_NODE_URL;
    print(`        healed nodeUrl ${existing.nodeUrl} → ${DEFAULT_NODE_URL} (TCP :9001 retired)`);
  }
  const schemaServiceUrl =
    opts.schemaServiceUrl ?? existing?.schemaServiceUrl ?? DEFAULT_SCHEMA_SERVICE_URL;
  // Persist the socket path to config only when explicitly given; otherwise
  // leave it unset so it keeps resolving from FOLDDB_HOME / FOLDDB_SOCKET_PATH.
  const nodeSocketPath = opts.nodeSocketPath ?? existing?.nodeSocketPath;
  const socketPath = resolveSocketPath({ nodeSocketPath });

  // Step 1: probe identity, bootstrap if needed. The private-schema declaration
  // path below is an owner verb that 403s `transport_not_attested` on an app-isolation node,
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
  // warning if the socket is missing, so the declaration client stays quiet on
  // that front — it still raises the actionable `node_attestation_unavailable`
  // error if the owner verb 403s.
  const node = newNodeClient({ baseUrl: nodeUrl, userHash, verbose, socketPath });

  // Step 2: declare fkanban's app-private schemas locally. This is Mini's
  // private-schema bootstrap path; it must not call schema_service load.
  print(`[2/${STEPS}] declaring ${UNIQUE_SCHEMAS.length} private schemas locally`);
  let schemaHashes: Record<string, string>;
  try {
    schemaHashes = await declareOwnedSchemasLocally(node, print);
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
    throw freshSetupSocketError(err, socketPath, "/api/apps/declare-schema") ?? err;
  }

  // Step 3: WRITE-PROBE each declared hash before adopting it. The declaration
  // response is the source of truth for the canonical identity; the probe is
  // the runtime backstop that proves the node will accept fkanban's full field
  // set before config is updated.
  print(`[3/${STEPS}] write-probing declared schema hashes`);
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
        "The node returned a declared fkanban/* schema hash that is not writable for all " +
        "fields. Upgrade or repair the Mini local schema declaration path, then re-run `kanban init`. " +
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
// `~/.kanban/config.json` pre-existed — OR a fresh node bootstrap. A
  // first-time `init` pointed at an *already-provisioned* node leaves
  // `bootstrapped` false, but it's still first-time fkanban setup and the dev
  // most needs the MCP hint, so don't hide it. A true re-init (config already
  // present) still collapses to the quiet one-line hint.
  const freshFkanbanConfig = existing === null;
  printNextSteps(print, bootstrapped || freshFkanbanConfig);

  return { config, bootstrapped };
}

/**
 * Declare fkanban's private schemas through Mini's local declaration API.
 * Private init has no schema_service fallback; older nodes must be upgraded
 * rather than loading app-private schemas from the shared service registry.
 */
async function declareOwnedSchemasLocally(
  node: NodeClient,
  print: (line: string) => void,
): Promise<Record<string, string>> {
  if (!node.declareAppSchema) {
    throw appSchemaDeclareUnsupported();
  }
  const schemaHashes: Record<string, string> = {};
  for (const entry of UNIQUE_SCHEMAS) {
    const descriptive = entry.schema.schema.descriptive_name ?? entry.key;
    try {
      const declared = await node.declareAppSchema!(OWNER_APP_ID, entry.schema.schema as unknown as Record<string, unknown>);
      schemaHashes[entry.key] = declared.canonical;
      print(
        `        ${String(descriptive).padEnd(6)} → ${declared.canonical}  (${declared.resolution})`,
      );
    } catch (err) {
      if (
        err instanceof FkanbanError &&
        (err.code === "node_http_404" ||
          err.code === "node_http_405")
      ) {
        throw appSchemaDeclareUnsupported(err);
      }
      throw err;
    }
  }
  print(`        local app-schema declarations persisted; schema_service load skipped`);
  return schemaHashes;
}

function appSchemaDeclareUnsupported(cause?: unknown): FkanbanError {
  return new FkanbanError({
    code: "app_schema_declare_unsupported",
    message: "This node does not support Mini local private schema declaration at /api/apps/declare-schema.",
    hint:
      "Upgrade LastDB/fold to a Mini node with local app-schema declaration. " +
      "fkanban's Card/Board schemas are private implementation schemas and `kanban init` no longer loads them from schema_service.",
    cause,
  });
}

function freshSetupSocketError(err: unknown, socketPath: string, route: string): FkanbanError | null {
  if (!(err instanceof FkanbanError) || err.code !== "service_unreachable") return null;
  const fullSocketPath = basename(socketPath) === "folddb-full.sock"
    ? socketPath
    : join(dirname(socketPath), "folddb-full.sock");
  if (basename(socketPath) === "folddb.sock" && !existsSync(fullSocketPath)) return null;
  if (existsSync(fullSocketPath)) return null;
  return new FkanbanError({
    code: "full_surface_socket_unavailable",
    message:
      `Cannot complete first-time fkanban setup over ${socketPath}: ${route} needs the ` +
      `node's full-surface owner socket, but ${fullSocketPath} does not exist.`,
    hint:
      "This node appears to expose only the narrow data/attestation socket. Use a node build " +
      "or startup mode that creates <data>/folddb-full.sock for setup writes, then re-run " +
      "`kanban init --node-socket-path <data>/folddb.sock`. Existing provisioned nodes can " +
      "still be used over the narrow socket; fresh bootstrap/private schema declaration needs the full surface.",
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
//      node is UP + the pinned schemas are usable), confirming setup steps are moot.
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

  // Only degrade for transport/route availability while proving an existing
  // config still works over the data plane. Real node-side errors (401/500/etc.)
  // must surface as-is.
  if (
    !(err instanceof FkanbanError) ||
    !["service_unreachable", "app_schema_declare_unsupported"].includes(err.code)
  ) {
    return null;
  }

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
    `        node setup route unavailable, but the data-plane socket ` +
      `${transport.socketPath} is live — degrading to a socket-only re-init`,
  );
  print(`        (bootstrap + private schema declaration are setup routes; ` + `skipping — the node is already provisioned with fkanban schema hashes in config)`);

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
// `~/.kanban/config.json`, OR a freshly bootstrapped node — emit a
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
