// Shared command context: read config + build a node client.

import { newNodeClient, type NodeClient, type Verbose } from "./client.ts";
import { readConfig, resolveSocketPath, type Config } from "./config.ts";
import { searchVisibilityProbeClient } from "./board-cards.ts";

export type Ctx = {
  cfg: Config;
  node: NodeClient;
  // Short-timeout twin of `node`, for the post-write search-visibility wait's
  // own probe reads (see `SEARCH_INDEX_PROBE_TIMEOUT_MS` in board-cards.ts).
  probeNode: NodeClient;
};

export function loadCtx(
  opts: { configPath?: string; verbose?: Verbose; opsLabel?: string } = {},
): Ctx {
  const cfg = readConfig(opts.configPath);
  const node = newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose: opts.verbose,
    socketPath: resolveSocketPath(cfg),
    // Omitted for ordinary commands, so they keep the plain board label.
    // Diagnostic entrypoints pass their own — see client.ts DEFAULT_OPS_LABEL.
    opsLabel: opts.opsLabel,
  });
  return { cfg, node, probeNode: searchVisibilityProbeClient(cfg) };
}

export function loadAppCtx(opts: { appId: string; configPath?: string; verbose?: Verbose }): Ctx {
  const cfg = readConfig(opts.configPath);
  const node = newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose: opts.verbose,
    socketPath: resolveSocketPath(cfg),
    appId: opts.appId,
    appCapability: process.env.FKANBAN_APP_CAPABILITY,
  });
  return { cfg, node, probeNode: searchVisibilityProbeClient(cfg) };
}
