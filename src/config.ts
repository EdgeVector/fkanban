// Persistent CLI config — `~/.fkanban/config.json` by default, or the path
// in $FKANBAN_CONFIG. Holds the canonical schema hashes (NOT the descriptive
// names) plus the node + schema-service URLs and the node user hash.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

import type { RecordType } from "./schemas.ts";

export const CONFIG_VERSION = 1;

export type Config = {
  configVersion: number;
  nodeUrl: string;
  schemaServiceUrl: string;
  userHash: string;
  // canonical schema hash per record type: { card, board }
  schemaHashes: Record<string, string>;
  // Optional override for the node's Unix-domain control socket, used for
  // owner-session attestation against an app-isolation node. When absent the
  // path is derived from FOLDDB_HOME (see `resolveSocketPath`).
  nodeSocketPath?: string;
};

const SOCKET_FILE_NAME = "folddb.sock";

// Resolve the node data-home when no explicit socket/home override is set.
// The FoldDB→LastDB rebrand (node v0.15.1+) moved the brew/CLI node's data home
// from `~/.folddb` to `~/.lastdb`, while the legacy desktop app still uses
// `~/.folddb`. Prefer whichever default home has a LIVE control socket on disk
// (that's the node actually running), `~/.lastdb` first; fall back to directory
// existence, `~/.lastdb` first, so a pre-launch machine still points somewhere
// real. Mirrors fbrain's `resolveDefaultNodeHome` so all three CLIs derive the
// same root on a mixed-version machine.
function resolveDefaultNodeHome(base: string): string {
  const lastdb = join(base, ".lastdb");
  const folddb = join(base, ".folddb");
  if (existsSync(join(lastdb, "data", SOCKET_FILE_NAME))) return lastdb;
  if (existsSync(join(folddb, "data", SOCKET_FILE_NAME))) return folddb;
  if (existsSync(lastdb)) return lastdb;
  return folddb;
}

// The node's app-isolation control socket lives under its data dir — for a
// socket-only local node this IS the transport, not a fallback. The primary
// local brain uses ~/.lastdb/data (a v0.15.1+ brew/CLI node) or ~/.folddb/data
// (the legacy desktop app); an ephemeral dev node sets FOLDDB_HOME to a temp
// dir. `FOLDDB_SOCKET_PATH` overrides everything; then the config field; then
// the LASTDB_HOME/FOLDDB_HOME override; then a probe for the live default home.
export function resolveSocketPath(cfg?: { nodeSocketPath?: string }): string {
  const envOverride = process.env.FOLDDB_SOCKET_PATH;
  if (envOverride && envOverride.length > 0) return envOverride;
  if (cfg?.nodeSocketPath && cfg.nodeSocketPath.length > 0) return cfg.nodeSocketPath;
  const homeOverride = process.env.LASTDB_HOME ?? process.env.FOLDDB_HOME;
  const home =
    homeOverride && homeOverride.length > 0 ? homeOverride : resolveDefaultNodeHome(homedir());
  return join(home, "data", SOCKET_FILE_NAME);
}

export function defaultConfigPath(): string {
  const override = process.env.FKANBAN_CONFIG;
  if (override && override.length > 0) return override;
  return join(homedir(), ".fkanban", "config.json");
}

export class ConfigMissingError extends Error {
  constructor(path: string) {
    super(`Config not found at ${path}. Run \`fkanban init\` first.`);
    this.name = "ConfigMissingError";
  }
}

export class ConfigInvalidError extends Error {
  constructor(path: string, reason: string) {
    super(`Config at ${path} is invalid: ${reason}. Re-run \`fkanban init\`.`);
    this.name = "ConfigInvalidError";
  }
}

export function readConfig(path: string = defaultConfigPath()): Config {
  if (!existsSync(path)) throw new ConfigMissingError(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new ConfigInvalidError(path, `not valid JSON (${msg})`);
  }
  return assertConfigShape(path, parsed);
}

export function tryReadConfig(path: string = defaultConfigPath()): Config | null {
  if (!existsSync(path)) return null;
  return readConfig(path);
}

export function writeConfig(
  config: Config,
  path: string = defaultConfigPath(),
): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(config, null, 2) + "\n", "utf8");
}

export function schemaHashFor(
  type: RecordType,
  cfg: { schemaHashes: Record<string, string> },
): string {
  const hash = cfg.schemaHashes[type];
  if (!hash || hash.length === 0) {
    throw new ConfigInvalidError(
      defaultConfigPath(),
      `no canonical hash registered for type "${type}"`,
    );
  }
  return hash;
}

function assertConfigShape(path: string, raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new ConfigInvalidError(path, "not an object");
  }
  const r = raw as Record<string, unknown>;

  if (r.configVersion !== undefined && r.configVersion !== CONFIG_VERSION) {
    throw new ConfigInvalidError(path, `unsupported configVersion "${String(r.configVersion)}" (expected ${CONFIG_VERSION})`);
  }

  for (const key of ["nodeUrl", "userHash"] as const) {
    if (typeof r[key] !== "string" || (r[key] as string).length === 0) {
      throw new ConfigInvalidError(path, `field "${key}" not a non-empty string`);
    }
  }

  const schemaServiceUrl = typeof r.schemaServiceUrl === "string" ? r.schemaServiceUrl : "";

  const rawHashes = r.schemaHashes;
  if (typeof rawHashes !== "object" || rawHashes === null || Array.isArray(rawHashes)) {
    throw new ConfigInvalidError(path, `field "schemaHashes" must be an object`);
  }
  const schemaHashes: Record<string, string> = {};
  for (const [k, v] of Object.entries(rawHashes as Record<string, unknown>)) {
    if (typeof v !== "string" || v.length === 0) {
      throw new ConfigInvalidError(path, `schemaHashes["${k}"] is not a non-empty string`);
    }
    schemaHashes[k] = v;
  }

  const nodeSocketPath =
    typeof r.nodeSocketPath === "string" && r.nodeSocketPath.length > 0
      ? (r.nodeSocketPath as string)
      : undefined;

  return {
    configVersion: typeof r.configVersion === "number" ? r.configVersion : CONFIG_VERSION,
    nodeUrl: r.nodeUrl as string,
    schemaServiceUrl,
    userHash: r.userHash as string,
    schemaHashes,
    ...(nodeSocketPath !== undefined ? { nodeSocketPath } : {}),
  };
}
