// Init declares owned schemas. It does not change existing records.
import { syncOwnedModel } from "../owned-schema-init.ts";
import { requireMultiKey } from "../multi-key.ts";
import { newNodeClient, FkanbanError, type NodeClient, type Verbose } from "../client.ts";
import { existsSync, readFileSync } from "node:fs";
import { fkanbanInvocation, mcpAddCommand } from "../mcp/register.ts";
import { OWNER_APP_ID, DEFAULT_BOARD_SLUG, DEFAULT_COLUMNS } from "../schemas.ts";
import { CONFIG_VERSION, defaultConfigPath, resolveSocketPath, tryReadConfig,
  writeConfig, schemaHashFor, type Config } from "../config.ts";
import { boardToFields, findBoard, nowIso, type Board } from "../record.ts";

export const DEFAULT_NODE_URL = "http://127.0.0.1";
export const DEFAULT_SCHEMA_SERVICE_URL = "https://axo709qs11.execute-api.us-east-1.amazonaws.com";
export type InitOptions = {
  nodeUrl?: string;
  schemaServiceUrl?: string;
  nodeSocketPath?: string;
  configPath?: string;
  bootstrapName?: string;
  verbose?: Verbose;
  print?: (line: string) => void;
};
export type InitResult = { config: Config; bootstrapped: boolean };

export async function seedDefaultBoard(node: NodeClient, config: Config, print: (line: string) => void): Promise<Board> {
  requireMultiKey(config);
  const existing = await findBoard(node, config, DEFAULT_BOARD_SLUG);
  if (existing) {
    print(`        board "${DEFAULT_BOARD_SLUG}" already exists`);
    return existing;
  }
  const now = nowIso();
  const board: Board = { slug: DEFAULT_BOARD_SLUG, title: "Default board", body: "",
    columns: [...DEFAULT_COLUMNS], created_at: now, updated_at: now };
  await node.createRecord({ schemaHash: schemaHashFor("board", config), keyHash: board.slug, fields: boardToFields(board) });
  print(`        created board "${DEFAULT_BOARD_SLUG}" with columns ${DEFAULT_COLUMNS.join(", ")}`);
  return board;
}

export async function runInit(opts: InitOptions): Promise<InitResult> {
  const print = opts.print ?? console.log;
  const configPath = opts.configPath ?? defaultConfigPath();
  const priorConfig=existsSync(configPath)?readFileSync(configPath,"utf8"):null;
  const existing = tryReadConfig(configPath);
  if (existing) requireMultiKey(existing);
  assertSafePrimaryConfigRepoint({ existing, requestedNodeSocketPath: opts.nodeSocketPath, configPath,
    hasExplicitConfigPath: opts.configPath !== undefined || Boolean(process.env.KANBAN_CONFIG || process.env.FKANBAN_CONFIG) });
  const staleUrls = new Set(["http://127.0.0.1:9001", "http://localhost:9001"]);
  const priorUrl = existing?.nodeUrl;
  const nodeUrl = opts.nodeUrl ?? (priorUrl && !staleUrls.has(priorUrl) ? priorUrl : DEFAULT_NODE_URL);
  const schemaServiceUrl = opts.schemaServiceUrl ?? existing?.schemaServiceUrl ?? DEFAULT_SCHEMA_SERVICE_URL;
  const nodeSocketPath = opts.nodeSocketPath ?? existing?.nodeSocketPath;
  const socketPath = resolveSocketPath({ nodeSocketPath });
  print(`[1/3] read node identity at ${socketPath}`);
  const probe = newNodeClient({ baseUrl: nodeUrl, userHash: existing?.userHash ?? "init-probe",
    verbose: opts.verbose, warn: print, socketPath });
  const identity = await probe.autoIdentity();
  let userHash: string;
  const bootstrapped = !identity.provisioned;
  if (identity.provisioned) userHash = identity.userHash;
  else userHash = (await probe.bootstrap(opts.bootstrapName ?? "fkanban")).userHash;
  const before = existing ? [] : await probe.listSchemas();
  const canonicalVocabulary = existing ? Boolean(existing.schemaFieldAliases)
    : !before.some(schema => schema.owner_app_id === OWNER_APP_ID && schema.fields.some(field => ["slug", "board"].includes(field)));
  const node = newNodeClient({ baseUrl: nodeUrl, userHash, verbose: opts.verbose, socketPath,
    schemaFieldAliases: existing?.schemaFieldAliases, canonicalVocabulary });
  print("[2/3] declare schema-owned records and named keys");
  const config = await syncOwnedModel(node, { configVersion: CONFIG_VERSION, nodeUrl, schemaServiceUrl,
    userHash, schemaHashes: {}, ...(nodeSocketPath ? { nodeSocketPath } : {}) }, existing, canonicalVocabulary);
  writeConfig(config, configPath,priorConfig);
  print("[3/3] ensure the default board");
  await seedDefaultBoard(node, config, print);
  printNextSteps(print, bootstrapped || existing === null);
  return { config, bootstrapped };
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
      "a separate node init, or re-run against the configured primary socket.",
  });
}

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
