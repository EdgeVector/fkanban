import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { CARD_LIST_FIELDS, listBoards, listCards, listCardsByColumn } from "../record.ts";
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
  const report = await buildPickupStatusReportWithSituations(cards, opts.situationPreflight, {
    cfg: opts.cfg,
    node: opts.node,
  });
  return { text: renderPickupStatus(report), report };
}

export async function pickupStatusCmd(opts: PickupStatusOptions): Promise<string> {
  const { text, report } = await pickupStatusResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}

export type PickupReadyOptions = {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
  /** Defaults to "default" — the only board `classifyPickupCard` can ever mark ready. */
  board?: string;
  situationPreflight?: SituationPreflight;
};

/**
 * Cheap `ready` read for the pickup gate.
 *
 * `classifyPickupCard` returns `pickup-ready` only for a `board === "default"`
 * card whose `column === "todo"` — every other board/column is parked or
 * human-gated before that check is reached. So the full board this report
 * reads for a human (`pickupStatusResult`: every board, every active column)
 * is read to classify rows that can NEVER be ready; only the `todo` column of
 * `default` can ever contribute to `report.ready`.
 *
 * This calls the SAME classification pipeline
 * (`buildPickupStatusReportWithSituations`) on that one partition instead —
 * not a reimplementation, so a todo card gets the identical verdict here it
 * would get inside the full report. The dependency/milestone/PR-liveness/
 * situation-fence lookups inside that pipeline are already targeted point
 * reads keyed off the input cards, so shrinking the input to one BoardCards
 * `todo#` partition read (what `pickup claim-v2` already reads cheaply)
 * shrinks the whole call, not just the part a human report throws away.
 *
 * The non-ready counts in the returned report (`blocked-on-dependency`,
 * `human-gated`, …) are therefore scoped to the `default` board's `todo`
 * column only — a real but partial view. Use `pickupStatusResult` for the
 * full per-category audit; use this only for the `ready` number/set.
 */
export async function pickupReadyResult(opts: PickupReadyOptions): Promise<{
  text: string;
  report: PickupStatusReport;
}> {
  const board = opts.board ?? "default";
  const todoCards = await listCardsByColumn(opts.node, opts.cfg, "todo", CARD_LIST_FIELDS, board);
  const report = await buildPickupStatusReportWithSituations(todoCards, opts.situationPreflight, {
    cfg: opts.cfg,
    node: opts.node,
  });
  return { text: renderPickupStatus(report), report };
}

export async function pickupReadyCmd(opts: PickupReadyOptions): Promise<string> {
  const { text, report } = await pickupReadyResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
