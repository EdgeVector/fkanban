// `kanban init` — bring a node to the point where the CLI/MCP can read +
// write the board:
//
//   1. probe identity, bootstrap the node if needed
//   2. ask Mini to resolve/register fkanban's schemas with Schema Service
//   3. capture each registered catalog hash from the declaration result
//   4. persist ~/.kanban/config.json
//   5. seed the default board (idempotent)
//
// fkanban's Card/Board schemas are private in visibility, but not local-only.
// Mini orchestrates `/api/apps/declare-schema` and must return Schema
// Service-registered catalog hashes. Shared-surface publish/attach is separate
// governance and is not a prerequisite for registration.

import {
  newNodeClient,
  FkanbanError,
  type LoadedSchema,
  type NodeClient,
  type Verbose,
} from "../client.ts";
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fkanbanInvocation, mcpAddCommand } from "../mcp/register.ts";
import {
  UNIQUE_SCHEMAS,
  EXTRA_SCHEMAS,
  OWNER_APP_ID,
  DEFAULT_BOARD_SLUG,
  DEFAULT_COLUMNS,
  allPinnedSchemas,
  checkPinnedSchemaIdentity,
  formatSchemaIdentityMismatch,
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
  toBoardSummary,
  type Board,
} from "../record.ts";
import { patchBoardListIndex } from "../card-list-index.ts";
import { BOARD_CARDS_REKEY_TARGET } from "../board-cards.ts";

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
  /** Operator's explicit yes to changing an existing schema pin. */
  acceptSchemaRepin?: boolean;
};

export type InitResult = { config: Config; bootstrapped: boolean };

const STEPS = 5;

/**
 * Create the default Board record if missing, then dual-write `all_boards`.
 *
 * `kanban board create` already patches the rollup; `init` used to write only
 * the primary record. First-run `kanban list` then found no `all_boards` row
 * and enumerated the Board schema — LastDB 400s that as
 * `full_schema_scan_not_allowed`. The patch is idempotent; re-init of an
 * existing default board still repairs a missing rollup row.
 */
export async function seedDefaultBoard(
  node: NodeClient,
  config: Config,
  print: (line: string) => void,
): Promise<Board> {
  const boardHash = schemaHashFor("board", config);
  const existingBoard = await findBoard(node, config, DEFAULT_BOARD_SLUG);
  const now = nowIso();
  const board: Board = existingBoard ?? {
    slug: DEFAULT_BOARD_SLUG,
    title: "Default board",
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: now,
    updated_at: now,
  };
  if (!existingBoard) {
    await node.createRecord({
      schemaHash: boardHash,
      fields: boardToFields(board),
      keyHash: board.slug,
    });
    print(`        created board "${DEFAULT_BOARD_SLUG}" with columns ${DEFAULT_COLUMNS.join(", ")}`);
  } else {
    print(`        board "${DEFAULT_BOARD_SLUG}" already exists — leaving as-is`);
  }
  await patchBoardListIndex(node, config, toBoardSummary(board), "upsert");
  return board;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = opts.print ?? ((line: string) => console.log(line));
  const verbose = opts.verbose;
  const bootstrapName = opts.bootstrapName ?? "fkanban";
  const configPath = opts.configPath ?? defaultConfigPath();
  const existing = tryReadConfig(configPath);
  assertSafePrimaryConfigRepoint({
    existing,
    requestedNodeSocketPath: opts.nodeSocketPath,
    configPath,
    hasExplicitConfigPath:
      opts.configPath !== undefined ||
      Boolean(process.env.KANBAN_CONFIG || process.env.FKANBAN_CONFIG),
  });

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

  // Step 1: probe identity, bootstrap if needed. The schema declaration
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

  // Step 2: ask Mini to resolve/register fkanban's schemas and return catalog
  // identities. The CLI does not bypass Mini to mint a local identity.
  print(`[2/${STEPS}] syncing ${UNIQUE_SCHEMAS.length + EXTRA_SCHEMAS.length} catalog schemas through Mini`);
  let schemaHashes: Record<string, string>;
  try {
    schemaHashes = await syncOwnedSchemasThroughMini(node, print);
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
  // ALL SEVEN pinned keys, not just the three RecordTypes. The four membership
  // indexes were never scoped out of this step — `probeSchemaWritable` read
  // `RECORDS[type]` and so could not be CALLED for them. init adopted whatever
  // hash Mini handed back for `board_cards` / `milestone_cards` /
  // `board_milestones` / `card_list_index` with no proof the node would take a
  // write there, and the first evidence was a runtime failure on a board whose
  // init printed clean.
  print(`[3/${STEPS}] write-probing declared schema hashes`);
  const notWritable: string[] = [];
  for (const entry of allPinnedSchemas()) {
    const hash = schemaHashes[entry.key];
    if (!hash) continue;
    const probe = await probeSchemaWritable(node, hash, entry);
    if (probe.writable) {
      print(
        `        ${entry.key.padEnd(16)} writable ✓` +
          (probe.leaked ? ` (probe row NOT cleaned up: ${probe.leaked})` : ""),
      );
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
        "fields. Upgrade or repair Mini's registered schema declaration path, then re-run `kanban init`. " +
        "Your existing config was left untouched — current writes keep working.",
    });
  }

  // Is each resolved hash the schema we DECLARED? The write probe answers "will
  // the node accept our fields here", which a schema belonging to a different
  // record type can answer `yes` to whenever its field set happens to cover ours
  // — and a membership index is a field superset of the entity it indexes BY
  // CONSTRUCTION, so that is not a hypothetical. Measured on the primary: the
  // `milestone_cards` pin addresses a hash registered as `Milestone`.
  //
  // Runs BEFORE the pin-move guard on purpose. Both refuse before `writeConfig`,
  // so ordering only decides which diagnosis prints — but a crossed identity is
  // also WHY a pin would move, and unlike the move guard this one has no
  // operator override: `--accept-schema-repin` says "yes, re-point it", never
  // "yes, point it at another record type".
  //
  // A node whose schema list is unreadable (socket-only control plane) cannot be
  // checked. It says so on its own line rather than passing quietly — this seat
  // has now found four checks that reported coverage they did not have.
  await assertResolvedSchemaIdentities(node, schemaHashes, print);

  // A resolved hash that differs from the incumbent is an ADDRESS CHANGE, not a
  // config refresh, and the write probe above cannot stand in for this check: it
  // asks only "will the node accept a write here?", which a brand-new EMPTY
  // identity answers `yes` just as readily as the one holding every row.
  //
  // It runs AFTER the probe rather than before because both guards refuse and
  // both leave config untouched, so ordering decides only which diagnosis the
  // operator reads — and when the resolved hash is BOTH a move and unwritable
  // (fkanban #94: declare hands back a stale narrower Card), "the node will not
  // accept these fields, here are the missing ones" is the more actionable of
  // the two. Ordering against `writeConfig` is the part that is load-bearing.
  const stagedBoardCards = stageBoardCardsRekey(existing, schemaHashes);
  schemaHashes = stagedBoardCards.schemaHashes;
  if (stagedBoardCards.staged) {
    print(
      `        ** board_cards rekey STAGED: reads stay on ${stagedBoardCards.active!.slice(0, 16)}…; ` +
        `mutations dual-write ${stagedBoardCards.target!.slice(0, 16)}… until ` +
        `\`kanban groom board-cards-rekey --apply\` converges **`,
    );
  }
  const pinMoves = schemaPinMoves(existing, schemaHashes);
  for (const m of pinMoves) {
    print(`        ** ${m.key} pin would MOVE: ${m.from.slice(0, 16)}… → ${m.to.slice(0, 16)}… **`);
  }
  assertNoSilentSchemaRepin({
    moves: pinMoves,
    accepted: opts.acceptSchemaRepin === true,
    configPath,
  });

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

  // Step 5: seed the default board (idempotent upsert) and dual-write all_boards.
  print(`[5/${STEPS}] seeding default board "${DEFAULT_BOARD_SLUG}"`);
  await seedDefaultBoard(node, config, print);

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

/** One schema pin `init` would change: `from` is what config holds today. */
export type SchemaPinMove = { key: string; from: string; to: string };

export type BoardCardsRekeyStage = {
  schemaHashes: Record<string, string>;
  staged: boolean;
  active?: string;
  target?: string;
};

/**
 * A newly resolved BoardCards identity is not safe to adopt as an ordinary pin
 * move: it is empty until Card truth has regenerated its board-keyed tips.
 * Preserve the incumbent read pin and record the new identity as a dual-write
 * target. The idempotent background groomer owns backfill and cutover.
 */
export function stageBoardCardsRekey(
  existing: Config | null,
  resolved: Record<string, string>,
): BoardCardsRekeyStage {
  const active = existing?.schemaHashes.board_cards;
  const target = resolved.board_cards;
  if (!active || !target || active === target) {
    return { schemaHashes: { ...resolved }, staged: false };
  }

  const incumbentTarget = existing?.schemaHashes[BOARD_CARDS_REKEY_TARGET];
  if (incumbentTarget && incumbentTarget !== target) {
    throw new FkanbanError({
      code: "board_cards_rekey_target_changed",
      message:
        `BoardCards rekey is already staged for ${incumbentTarget}, but schema declaration now ` +
        `resolved ${target}. Refusing to replace an in-flight migration target.`,
      hint:
        "Inspect the staged target and finish or explicitly roll back that migration before " +
        "declaring another BoardCards identity.",
    });
  }

  return {
    schemaHashes: {
      ...resolved,
      board_cards: active,
      [BOARD_CARDS_REKEY_TARGET]: target,
    },
    staged: true,
    active,
    target,
  };
}

/**
 * Which pins would this init MOVE?
 *
 * A pin move is not a config edit. A schema hash IS the address of a record
 * type: every row fkanban has ever written under `from` lives under `from`, and
 * a config pointing at `to` cannot see any of them. Re-pointing an index is
 * therefore indistinguishable, from every read path, from that index being
 * empty — and `init` is the one command an operator runs when something already
 * looks wrong.
 */
export function schemaPinMoves(
  existing: Config | null,
  resolved: Record<string, string>,
): SchemaPinMove[] {
  if (!existing) return [];
  const moves: SchemaPinMove[] = [];
  for (const [key, to] of Object.entries(resolved)) {
    const from = (existing.schemaHashes as Record<string, string | undefined>)[key];
    // No incumbent is not a move — that is a first declaration, which is the
    // normal path on a fresh node and on a newly added catalog entry.
    if (!from || from.length === 0) continue;
    if (from === to) continue;
    moves.push({ key, from, to });
  }
  return moves;
}

/**
 * Refuse to silently re-point an existing config at different schema identities.
 *
 * Measured on an isolated node 2026-08-04: with `milestone_cards` pinned to a
 * hash other than the one Mini resolves, `kanban init` rewrote the pin and its
 * output said nothing about the change — it prints the resolved hash, never the
 * incumbent, so the one line that would reveal a move looks identical to the
 * line printed when nothing moved.
 *
 * That is a live landmine rather than a hypothetical. On the primary,
 * `milestone_cards` is pinned to `69e76079…`, which the node has registered
 * under `descriptive_name: "Milestone"`; the catalog's declared name
 * `MilestoneCards_hashrange_v1_children_20260723` resolves to ZERO loaded
 * schemas there. The next unguarded `init` on that node would adopt a freshly
 * registered identity and orphan every live MilestoneCards row.
 *
 * Refusing rather than warning, because the failure is silent by nature: a
 * re-pointed index reads as an empty index, so nothing downstream errors and no
 * later run can tell the difference. `--accept-schema-repin` is the operator's
 * yes — a red that an operator CAN clear, which is the only kind worth printing.
 */
export function assertNoSilentSchemaRepin(args: {
  moves: SchemaPinMove[];
  accepted: boolean;
  configPath: string;
}): void {
  const { moves, accepted, configPath } = args;
  if (moves.length === 0 || accepted) return;

  const lines = moves.map((m) => `  ${m.key}: ${m.from} → ${m.to}`);
  throw new FkanbanError({
    code: "schema_pin_would_move",
    message:
      `Refusing to re-point ${moves.length} schema ${moves.length === 1 ? "pin" : "pins"} in ` +
      `${configPath}. A schema hash is the ADDRESS of a record type — rows written under the ` +
      `old hash are invisible to a config holding the new one, and an index re-pointed this way ` +
      `reads exactly like an empty index:\n${lines.join("\n")}`,
    hint:
      "Your config was left untouched — current reads and writes keep working. If the node " +
      "genuinely holds no rows under the old hashes (a fresh node, or an index you have already " +
      "migrated), re-run with `--accept-schema-repin`. Otherwise the rows must be migrated to " +
      "the new identity FIRST; adopting the pin does not move them.",
  });
}

export function assertSafePrimaryConfigRepoint(args: {
  existing: Config | null;
  requestedNodeSocketPath: string | undefined;
  configPath: string;
  hasExplicitConfigPath: boolean;
}): void {
  const { existing, requestedNodeSocketPath, configPath, hasExplicitConfigPath } = args;
  if (!existing || !requestedNodeSocketPath) return;
  if (hasExplicitConfigPath) return;

  const currentSocketPath = resolveSocketPath({ nodeSocketPath: existing.nodeSocketPath });
  const requestedSocketPath = resolveSocketPath({ nodeSocketPath: requestedNodeSocketPath });
  if (requestedSocketPath === currentSocketPath) return;

  throw new FkanbanError({
    code: "unsafe_primary_config_repoint",
    message:
      `Refusing to rewrite primary config ${configPath} from socket ` +
      `${currentSocketPath} to ${requestedSocketPath}.`,
    hint:
      "Use KANBAN_CONFIG or FKANBAN_CONFIG to write an alternate config for " +
      "test-node init, or re-run against the configured primary socket.",
  });
}

/**
 * Refuse to adopt any resolved hash whose loaded schema is not the record type
 * fkanban declared. Pure decision lives in `checkPinnedSchemaIdentity`; this
 * wrapper owns the I/O (one `listSchemas`) and the operator-facing error.
 */
export async function assertResolvedSchemaIdentities(
  node: NodeClient,
  schemaHashes: Record<string, string>,
  print: (line: string) => void,
): Promise<void> {
  let loaded: LoadedSchema[];
  try {
    loaded = await node.listSchemas();
  } catch {
    print(`        ** schema identities NOT verified — node schema list unavailable **`);
    return;
  }

  const crossed: string[] = [];
  for (const entry of allPinnedSchemas()) {
    const identity = checkPinnedSchemaIdentity(entry, schemaHashes[entry.key], loaded);
    if (identity.kind !== "mismatch") continue;
    crossed.push(
      `${entry.key} (${schemaHashes[entry.key]}) is registered as "${identity.loadedDescriptiveName}" — ` +
        formatSchemaIdentityMismatch(identity),
    );
  }
  if (crossed.length === 0) return;

  throw new FkanbanError({
    code: "schema_identity_crossed",
    message:
      `The node resolved ${crossed.length === 1 ? "a schema hash" : "schema hashes"} that ` +
      `${crossed.length === 1 ? "belongs" : "belong"} to a DIFFERENT record type than fkanban ` +
      `declared, so init is refusing to adopt ${crossed.length === 1 ? "it" : "them"}:\n  ` +
      crossed.join("\n  "),
    hint:
      "A schema hash is the address of a record type. Pinning one that resolves to another type " +
      "does not error at write time — the index simply reads as empty. Repair the node's catalog " +
      "registration for the named schema(s), then re-run `kanban init`. Your existing config was " +
      "left untouched.",
  });
}

/**
 * Resolve/register fkanban's schemas through Mini's declaration API.
 * Mini is responsible for reaching Schema Service when the verified catalog
 * cache cannot reuse an existing identity. No local-only fallback is valid.
 */
async function syncOwnedSchemasThroughMini(
  node: NodeClient,
  print: (line: string) => void,
): Promise<Record<string, string>> {
  if (!node.declareAppSchema) {
    throw appSchemaDeclareUnsupported();
  }
  const schemaHashes: Record<string, string> = {};
  for (const entry of [...UNIQUE_SCHEMAS, ...EXTRA_SCHEMAS]) {
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
  print(`        catalog identities loaded; expansions reuse prior molecules`);
  return schemaHashes;
}

function appSchemaDeclareUnsupported(cause?: unknown): FkanbanError {
  return new FkanbanError({
    code: "app_schema_declare_unsupported",
    message: "This node does not support registered app-schema declaration at /api/apps/declare-schema.",
    hint:
      "Upgrade LastDB/fold to a Mini node that resolves/registers app schemas with Schema Service. " +
      "Private visibility does not permit local-only schema identities.",
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
      "still be used over the narrow socket; fresh bootstrap/schema registration needs the full surface.",
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
  print(`        (bootstrap + schema registration are setup routes; ` + `skipping — the node is already provisioned with fkanban schema hashes in config)`);

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
  await seedDefaultBoard(node, config, print);

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
