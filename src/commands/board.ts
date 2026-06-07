// `fkanban board create|list` — manage boards.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import { boardToFields, findBoard, listBoards, nowIso, validateSlug, type Board } from "../record.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";

export async function boardCreateCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  title?: string;
  columns?: string[];
  body?: string;
}): Promise<{ slug: string; action: "created" | "updated" }> {
  validateSlug(opts.slug);
  const columns = opts.columns && opts.columns.length > 0 ? opts.columns : [...DEFAULT_COLUMNS];
  const existing = await findBoard(opts.node, opts.cfg, opts.slug);
  const now = nowIso();
  const board: Board = {
    slug: opts.slug,
    title: opts.title ?? existing?.title ?? opts.slug,
    body: opts.body ?? existing?.body ?? "",
    columns: opts.columns ? columns : existing?.columns ?? columns,
    created_at: existing?.created_at ?? now,
    updated_at: now,
  };
  const hash = schemaHashFor("board", opts.cfg);
  if (existing) {
    await opts.node.updateRecord({ schemaHash: hash, fields: boardToFields(board), keyHash: board.slug });
    return { slug: board.slug, action: "updated" };
  }
  await opts.node.createRecord({ schemaHash: hash, fields: boardToFields(board), keyHash: board.slug });
  return { slug: board.slug, action: "created" };
}

export async function boardListCmd(opts: {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
}): Promise<string> {
  const boards = await listBoards(opts.node, opts.cfg);
  if (opts.json) return JSON.stringify(boards, null, 2);
  if (boards.length === 0) return "No boards. Run `fkanban init` to seed the default board.";
  return boards
    .map((b) => `${b.slug.padEnd(20)} ${b.title}\n  columns: ${b.columns.join(" → ")}`)
    .join("\n");
}

export async function requireBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board> {
  const board = await findBoard(node, cfg, slug);
  if (!board) {
    throw new FkanbanError({ code: "board_not_found", message: `No board with slug "${slug}".` });
  }
  return board;
}
