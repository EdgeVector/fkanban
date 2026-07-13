// `fkanban mark <slug> "<line>"` — append one marker line to an existing card
// body, idempotently. This is intentionally narrower than `add --body`, whose
// body argument replaces the entire body.

import { FkanbanError, type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { addCmd, type AddResult } from "./add.ts";
import { requireCard } from "../record.ts";

export type MarkOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  line: string;
};

function appendLineOnce(body: string, line: string): string {
  const lines = body.length === 0 ? [] : body.split(/\r?\n/);
  if (lines.includes(line)) return body;
  if (body.length === 0) return line;
  return body.endsWith("\n") ? `${body}${line}` : `${body}\n${line}`;
}

export async function markCmd(opts: MarkOptions): Promise<AddResult> {
  if (opts.line.length === 0) {
    throw new FkanbanError({
      code: "invalid_mark_line",
      message: "Marker line must not be empty.",
      hint: 'Usage: fkanban mark <slug> "<line>"',
    });
  }

  const card = await requireCard(opts.node, opts.cfg, opts.slug);
  const body = appendLineOnce(card.body, opts.line);
  if (body === card.body) {
    return { slug: card.slug, action: "updated", board: card.board, column: card.column };
  }
  return addCmd({ cfg: opts.cfg, node: opts.node, slug: opts.slug, body });
}
