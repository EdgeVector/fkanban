// `fkanban show <slug>` — print one card in detail.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { depStatus, findCard, listCardStatuses } from "../record.ts";
import { renderCardDetail } from "../board.ts";

export async function showCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  json?: boolean;
}): Promise<string> {
  const card = await findCard(opts.node, opts.cfg, opts.slug);
  if (!card) {
    throw new FkanbanError({ code: "card_not_found", message: `No card with slug "${opts.slug}".` });
  }
  const status = depStatus(card, await listCardStatuses(opts.node, opts.cfg));
  if (opts.json) {
    return JSON.stringify({ ...card, blocked: status.blocked, blockedBy: status.blockedBy, missingDeps: status.missing }, null, 2);
  }
  return renderCardDetail(card, undefined, status);
}
