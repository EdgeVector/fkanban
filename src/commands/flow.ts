import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { featureFlowReport, formatFeatureFlowReport, type FeatureFlowReport } from "../flow-ledger.ts";

export async function flowResult(opts: {
  cfg: Config;
  node: NodeClient;
  milestone: string;
  now?: string;
}): Promise<FeatureFlowReport> {
  return featureFlowReport(opts);
}

export async function flowCmd(opts: {
  cfg: Config;
  node: NodeClient;
  milestone: string;
  json?: boolean;
  now?: string;
}): Promise<string> {
  return formatFeatureFlowReport(await flowResult(opts), opts.json);
}
