// `fkanban search <query>` — find cards by a case-insensitive substring match
// across slug, title, body, assignee, and tags. Matches can span columns and
// boards, so results render as a flat, location-annotated list (or `--json`).

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { blockedSlugSet, listCards, requireBoard, searchCards, sortCards } from "../record.ts";
import { renderSearchResults } from "../board.ts";

export type SearchOptions = {
  cfg: Config;
  node: NodeClient;
  query: string;
  board?: string;
  column?: string;
  json?: boolean;
};

export async function searchCmd(opts: SearchOptions): Promise<string> {
  // An explicitly-passed board must exist — a typo'd name should error loudly
  // (matching `add`), not silently report "No cards match". Without `--board`
  // the search spans all boards, so there's nothing to validate.
  if (opts.board !== undefined) {
    await requireBoard(opts.node, opts.cfg, opts.board);
  }
  const allCards = await listCards(opts.node, opts.cfg);
  const scoped = allCards.filter(
    (c) => (!opts.board || c.board === opts.board) && (!opts.column || c.column === opts.column),
  );
  const matches = searchCards(scoped, opts.query);

  if (opts.json) {
    return JSON.stringify(sortCards(matches), null, 2);
  }

  // Resolve blocked status against ALL live cards so cross-board deps count.
  return renderSearchResults(matches, opts.query, { blocked: blockedSlugSet(matches, allCards) });
}
