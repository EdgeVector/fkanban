// `fkanban show <slug>` — print one card in detail.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import {
  boardTerminalMap,
  depStatus,
  listBoards,
  listCardStatuses,
  requireCard,
  type Card,
} from "../record.ts";
import { renderCardDetail } from "../board.ts";

// A card plus its resolved dependency status — the shape `show --json` emits.
export type CardDetail = Card & {
  blocked: boolean;
  blockedBy: string[];
  missingDeps: string[];
};

// Both the human text and the structured detail, from a single read.
// `showCmd` (CLI) returns one; the MCP tool returns both.
export async function showResult(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
}): Promise<{ text: string; card: CardDetail }> {
  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  // Resolve dep done-ness against each dep board's terminal column (a dep may
  // live on a different board than this card), falling back to `done`.
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  const status = depStatus(card, await listCardStatuses(opts.node, opts.cfg), boardTerminal);
  const detail: CardDetail = {
    ...card,
    blocked: status.blocked,
    blockedBy: status.blockedBy,
    missingDeps: status.missing,
  };
  return { text: renderCardDetail(card, undefined, status), card: detail };
}

export async function showCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
}): Promise<string> {
  const { text, card } = await showResult(opts);
  return opts.json ? JSON.stringify(card, null, 2) : text;
}
