// Shared command context: read config + build a node client.

import { newNodeClient, type NodeClient, type Verbose } from "./client.ts";
import { readConfig, type Config } from "./config.ts";

export type Ctx = {
  cfg: Config;
  node: NodeClient;
};

export function loadCtx(opts: { configPath?: string; verbose?: Verbose } = {}): Ctx {
  const cfg = readConfig(opts.configPath);
  const node = newNodeClient({
    baseUrl: cfg.nodeUrl,
    userHash: cfg.userHash,
    verbose: opts.verbose,
  });
  return { cfg, node };
}
