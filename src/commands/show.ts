// `fkanban show <slug>` — print one card in detail.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { listBoardCardsPartition } from "../board-cards.ts";
import {
  assertDbLocatorMatchesCard,
  depStatus,
  listDependencyStatusesForCards,
  requireCard,
  type Card,
} from "../record.ts";
import { renderCardDetail } from "../board.ts";
import {
  attachPipelineStatus,
  type PipelineAttachResult,
} from "../pipeline_status.ts";

const CLAIM_PROJECTION_FIELDS = ["title", "assignee", "updated_at"] as const;

/**
 * Join a possibly stale pre-claim Card read with the claim-authoritative
 * BoardCards row. The body and all non-claim fields still come from Card.
 *
 * A claim starts in todo and ends in doing. Therefore only a Card that still
 * says todo, or a doing Card without an owner, needs this one keyed column
 * read. There is no retry, sleep, board scan, or write on the show path.
 */
async function resolveCurrentClaim(
  node: NodeClient,
  cfg: Config,
  card: Card,
): Promise<Card> {
  const mayBePreClaim = card.column === "todo" ||
    (card.column === "doing" && card.assignee.trim().length === 0);
  if (!mayBePreClaim || !cfg.schemaHashes.board_cards) return card;

  const doing = await listBoardCardsPartition(node, cfg, card.board, {
    column: "doing",
    fields: CLAIM_PROJECTION_FIELDS,
  });
  const claimed = doing?.find((candidate) => candidate.slug === card.slug);
  if (!claimed) return card;
  const cardUpdated = Date.parse(card.updated_at);
  const claimUpdated = Date.parse(claimed.updated_at);
  // A stale duplicate doing row must not override a later reopen to todo.
  if (!Number.isFinite(cardUpdated) || !Number.isFinite(claimUpdated) || claimUpdated < cardUpdated) {
    return card;
  }

  return {
    ...card,
    column: claimed.column,
    position: claimed.position,
    assignee: claimed.assignee,
    updated_at: claimed.updated_at || card.updated_at,
  };
}

// A card plus its resolved dependency status — the shape `show --json` emits.
export type CardDetail = Card & {
  blocked: boolean;
  blockedBy: string[];
  missingDeps: string[];
  /** Best-effort LastgitCiStatus join; omitted only when attach throws (should not). */
  pipeline?: PipelineAttachResult;
};

// Both the human text and the structured detail, from a single read.
// `showCmd` (CLI) returns one; the MCP tool returns both.
export async function showResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dbLocator?: string;
}): Promise<{ text: string; card: CardDetail }> {
  let card = await requireCard(opts.node, opts.cfg, opts.slug);
  assertDbLocatorMatchesCard(card, opts.dbLocator, "show");
  card = await resolveCurrentClaim(opts.node, opts.cfg, card);
  // Resolve dep done-ness against each dep board's terminal column (a dep may
  // live on a different board than this card), falling back to `done`.
  // POINT-READ only this card's deps rather than scanning the whole card table:
  // `depStatus` only consults `card.deps`, so fetching all ~1000s of cards here
  // was a full-collection scan (the dominant per-`show` cost) for no benefit.
  //
  // These two only need `card`, and every node query pays a flat ~120ms
  // regardless of rows, so serializing them made `show` the sum of three
  // round-trips. Run them concurrently: wall ≈ card read + slowest branch.
  // The pipeline join stays best-effort — never fail show if lastgit schemas
  // are absent or the node is busy on that partition.
  //
  // The board list used to be a third leg here, read only to build a
  // board→terminal-column map that was `done` for every board. `TERMINAL_COLUMN`
  // says that without a read.
  const [relevant, pipeline] = await Promise.all([
    listDependencyStatusesForCards(opts.node, opts.cfg, [card]),
    attachPipelineStatus(opts.node, card).catch((): PipelineAttachResult | undefined => undefined),
  ]);
  const status = depStatus(card, relevant);
  const detail: CardDetail = {
    ...card,
    blocked: status.blocked,
    blockedBy: status.blockedBy,
    missingDeps: status.missing,
    ...(pipeline ? { pipeline } : {}),
  };
  return {
    text: renderCardDetail(card, undefined, status, pipeline),
    card: detail,
  };
}

export async function showCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  dbLocator?: string;
  json?: boolean;
}): Promise<string> {
  const { text, card } = await showResult(opts);
  return opts.json ? JSON.stringify(card, null, 2) : text;
}
