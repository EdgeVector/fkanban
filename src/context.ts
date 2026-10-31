// Shared command context: read config + build a node client.

import { newNodeClient, type NodeClient, type Verbose } from "./client.ts";
import { readConfig, resolveSocketPath, type Config } from "./config.ts";
import { requireMultiKey } from "./multi-key.ts";

export type Ctx = {
  cfg: Config;
  node: NodeClient;
};

export function loadCtx(
  opts: { configPath?: string; verbose?: Verbose; opsLabel?: string } = {},
): Ctx {
  const cfg = readConfig(opts.configPath);
  requireMultiKey(cfg);
  const node = newNodeClient({
    baseUrl: cfg.nodeUrl, schemaFieldAliases:cfg.schemaFieldAliases,
    userHash: cfg.userHash,
    verbose: opts.verbose,
    socketPath: resolveSocketPath(cfg),
    // Omitted for ordinary commands, so they keep the plain board label.
    // Diagnostic entrypoints pass their own — see client.ts DEFAULT_OPS_LABEL.
    opsLabel: opts.opsLabel,
  });
  return { cfg, node };
}
