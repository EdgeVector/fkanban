import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { listBoards, listCards } from "../record.ts";
import {
  buildPickupStatusReportWithSituations,
  renderPickupStatus,
  type PickupStatusReport,
} from "../pickup.ts";
import { type SituationPreflight } from "../situations.ts";

export type PickupStatusOptions = {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
  situationPreflight?: SituationPreflight;
};

export async function pickupStatusResult(opts: PickupStatusOptions): Promise<{
  text: string;
  report: PickupStatusReport;
}> {
  const [cards, boards] = await Promise.all([
    listCards(opts.node, opts.cfg),
    listBoards(opts.node, opts.cfg),
  ]);
  const report = await buildPickupStatusReportWithSituations(cards, boards, opts.situationPreflight);
  return { text: renderPickupStatus(report), report };
}

export async function pickupStatusCmd(opts: PickupStatusOptions): Promise<string> {
  const { text, report } = await pickupStatusResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
