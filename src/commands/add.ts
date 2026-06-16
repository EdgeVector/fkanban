// `fkanban add <slug>` — create or update a card. Body can come from --body
// or stdin. Column defaults to the board's first column; position appends to
// the end of that column. The whole command is two point reads (board, card)
// plus one write — it never scans the board.

import { type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  appendPosition,
  cardToFields,
  ensureColumn,
  findCard,
  normalizeDeps,
  nowIso,
  requireBoard,
  validateSlug,
  type Card,
} from "../record.ts";

export type AddOptions = {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  board?: string;
  column?: string;
  assignee?: string;
  tags?: string[];
  // Replace the card's dependency list with these slugs (validated, deduped,
  // self-references dropped). Omit to leave existing deps untouched on update.
  deps?: string[];
  body?: string;
};

// Validate + clean a user-supplied dep list for `slug`.
function prepareDeps(deps: string[], slug: string): string[] {
  const cleaned = normalizeDeps(deps, slug);
  for (const d of cleaned) validateSlug(d);
  return cleaned;
}

export type AddResult = { slug: string; action: "created" | "updated"; board: string; column: string };

export async function addCmd(opts: AddOptions): Promise<AddResult> {
  validateSlug(opts.slug);
  const boardSlug = opts.board ?? "default";
  const board = await requireBoard(opts.node, opts.cfg, boardSlug);
  const columns = board.columns;
  const column = opts.column ?? columns[0] ?? "backlog";
  ensureColumn(column, columns);

  const hash = schemaHashFor("card", opts.cfg);
  const existing = await findCard(opts.node, opts.cfg, opts.slug);
  const now = nowIso();

  if (existing) {
    const updated: Card = {
      ...existing,
      title: opts.title ?? existing.title,
      body: opts.body ?? existing.body,
      board: boardSlug,
      column: opts.column ?? existing.column,
      assignee: opts.assignee ?? existing.assignee,
      tags: opts.tags ?? existing.tags,
      deps: opts.deps ? prepareDeps(opts.deps, opts.slug) : existing.deps,
      updated_at: now,
    };
    if (opts.column) ensureColumn(updated.column, columns);
    await opts.node.updateRecord({ schemaHash: hash, fields: cardToFields(updated), keyHash: opts.slug });
    return { slug: opts.slug, action: "updated", board: boardSlug, column: updated.column };
  }

  const card: Card = {
    slug: opts.slug,
    title: opts.title ?? opts.slug,
    body: opts.body ?? "",
    board: boardSlug,
    column,
    position: appendPosition(),
    assignee: opts.assignee ?? "",
    tags: opts.tags ?? [],
    deps: opts.deps ? prepareDeps(opts.deps, opts.slug) : [],
    created_at: now,
    updated_at: now,
  };
  await opts.node.createRecord({ schemaHash: hash, fields: cardToFields(card), keyHash: opts.slug });
  return { slug: opts.slug, action: "created", board: boardSlug, column };
}
