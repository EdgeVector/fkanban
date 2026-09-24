import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  bodyDeclaredValidateOnly,
  CARD_LIST_FIELDS,
  hydrateCardBodies,
  listBoards,
  listCards,
  listCardsByColumn,
  type Card,
} from "../record.ts";
import {
  buildPickupStatusReportWithSituations,
  renderPickupStatus,
  type PickupStatusReport,
} from "../pickup.ts";
import { type SituationPreflight } from "../situations.ts";
import { hydrateOverlapPeers, overlapAgainstCards } from "./overlap.ts";

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
  await demoteValidateOnlyReady(opts, cards, report);
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
export type PickupReadyReport = PickupStatusReport & {
  /**
   * Ready cards that `pickup claim` could take right now: ready AND not fenced
   * by a live surface overlap with a `doing` card (the same overlap test, with
   * the same stall bound, the claim applies). `ready` alone overstated the
   * claimable work: gate said ready=4 while every claim path skipped all four
   * for surface overlap (papercut-kanban-pickup-gate-ready-overstates-eligible-20260922).
   * Absent when the doing column could not be read.
   */
  claimable?: number;
  /** Ready cards fenced by a live doing peer, with the peers that fence them. */
  fenced?: Array<{ slug: string; peers: string[] }>;
};

/**
 * Read the body of each READY card only, and park the ones whose body says the
 * code already merged (`bodyDeclaredValidateOnly`). The todo list read is
 * body-free, so without this the gate counted a reopened, merged card as WORK
 * and a Loom land-card walk was dispatched at it (2026-09-24). Cost: one point
 * read per ready card — never per todo card, never a forge call. A failed read
 * leaves the verdict as it was; `claimCard` re-checks the full record anyway.
 */
async function demoteValidateOnlyReady(
  opts: { node: NodeClient; cfg: Config },
  cards: Card[],
  report: PickupStatusReport,
): Promise<void> {
  if (report.ready === 0) return;
  const readySlugs = new Set(report.cards.filter((c) => c.ready).map((c) => c.slug));
  let hydrated: Card[];
  try {
    hydrated = await hydrateCardBodies(
      opts.node,
      opts.cfg,
      cards.filter((card) => readySlugs.has(card.slug)),
    );
  } catch {
    return;
  }
  const bodyBySlug = new Map(hydrated.map((card) => [card.slug, card.body]));
  for (const row of report.cards) {
    if (!row.ready) continue;
    const reason = bodyDeclaredValidateOnly(bodyBySlug.get(row.slug) ?? "");
    if (!reason) continue;
    row.ready = false;
    row.category = "parked/non-work";
    row.reason = reason;
    row.suggestion =
      "Keep the card in doing with its merged pr_url for the validate lane; add a `REWORK:` line only when new implementation work is wanted.";
    report.ready -= 1;
    report.counts["pickup-ready"] -= 1;
    report.counts["parked/non-work"] += 1;
  }
}

export async function pickupReadyResult(opts: PickupReadyOptions): Promise<{
  text: string;
  report: PickupReadyReport;
}> {
  const board = opts.board ?? "default";
  const todoCards = await listCardsByColumn(opts.node, opts.cfg, "todo", CARD_LIST_FIELDS, board);
  const report: PickupReadyReport = await buildPickupStatusReportWithSituations(todoCards, opts.situationPreflight, {
    cfg: opts.cfg,
    node: opts.node,
  });
  await demoteValidateOnlyReady(opts, todoCards, report);
  if (report.ready > 0) {
    try {
      const doing = await hydrateOverlapPeers(
        opts.node,
        opts.cfg,
        await listCardsByColumn(opts.node, opts.cfg, "doing", CARD_LIST_FIELDS, board),
      );
      const bySlug = new Map(todoCards.map((c) => [c.slug, c]));
      const fenced: Array<{ slug: string; peers: string[] }> = [];
      let claimable = 0;
      for (const c of report.cards) {
        if (!c.ready) continue;
        const card = bySlug.get(c.slug);
        if (!card) continue;
        const overlap = overlapAgainstCards(card, doing);
        if (overlap.conflicts.length > 0) {
          fenced.push({ slug: c.slug, peers: overlap.conflicts.map((p) => p.slug) });
        } else {
          claimable += 1;
        }
      }
      report.claimable = claimable;
      report.fenced = fenced;
    } catch {
      // Leave `claimable` absent: an unread doing column is not "0 fenced".
    }
  } else {
    report.claimable = 0;
    report.fenced = [];
  }
  const fencedLine = report.fenced && report.fenced.length > 0
    ? `\nclaimable=${report.claimable} fenced=${report.fenced.map((f) => `${f.slug}<-${f.peers.join("+")}`).join(",")}`
    : report.claimable !== undefined
      ? `\nclaimable=${report.claimable}`
      : "";
  return { text: renderPickupStatus(report) + fencedLine, report };
}

export async function pickupReadyCmd(opts: PickupReadyOptions): Promise<string> {
  const { text, report } = await pickupReadyResult(opts);
  return opts.json ? JSON.stringify(report, null, 2) : text;
}
