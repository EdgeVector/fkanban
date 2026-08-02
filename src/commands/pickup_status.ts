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
  // Boards first, then hand them to listCards — listCards needs the board set
  // to know which BoardCards partitions to query, so fetching both in parallel
  // read card_list_index twice for the same answer.
  const boards = await listBoards(opts.node, opts.cfg);
  // `activeOnly`: this report classifies `activeCards` and NOTHING else — every
  // terminal-column row read here was read to be thrown away. On the live board
  // that was 141 of 170 rows. See `BoardListOpt.activeOnly` for why this is a
  // read narrowing rather than a filter, and why it must not spread to `list`.
  const cards = await listCards(opts.node, opts.cfg, { boards, activeOnly: true });
  const report = await buildPickupStatusReportWithSituations(cards, boards, opts.situationPreflight, {
    cfg: opts.cfg,
    node: opts.node,
  });
  return { text: renderPickupStatus(report), report };
}

export async function pickupStatusCmd(opts: PickupStatusOptions): Promise<string> {
  const { text, report } = await pickupStatusResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
