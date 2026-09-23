// Join a possibly stale pre-claim Card read with the claim-authoritative
// BoardCards row. Shared by `show` and the metadata stamp in `add`.

import { type NodeClient } from "./client.ts";
import { type Config } from "./config.ts";
import { listBoardCardsPartition } from "./board-cards.ts";
import { type Card } from "./record.ts";

const CLAIM_PROJECTION_FIELDS = ["title", "assignee", "updated_at"] as const;

/**
 * Join a possibly stale pre-claim Card read with the claim-authoritative
 * BoardCards row. The body and all non-claim fields still come from Card.
 *
 * A claim starts in todo and ends in doing. Therefore only a Card that still
 * says todo, or a doing Card without an owner, needs this one keyed column
 * read. There is no retry, sleep, board scan, or write on the show path.
 */
export async function resolveCurrentClaim(
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
