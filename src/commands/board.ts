// `fkanban board create|list|rm` — manage boards.

import { FkanbanError, type NodeClient } from "../client.ts";
import { schemaHashFor, type Config } from "../config.ts";
import {
  boardToFields,
  findBoard,
  listBoards,
  listCards,
  nowIso,
  TOMBSTONE_TAG,
  validateSlug,
  type Board,
} from "../record.ts";
import { DEFAULT_BOARD_SLUG, DEFAULT_COLUMNS } from "../schemas.ts";

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

// `fkanban board rm <slug>` — soft-delete a board. fold_db is append-only, so
// (like card `rm`) this overwrites the record and stamps TOMBSTONE_TAG; for a
// board the tombstone marker lives in `columns`, which is exactly what every
// board read path (listBoards / findBoard) filters on via isTombstoned.
export async function boardRmCmd(opts: {
  cfg: Config;
  node: NodeClient;
  slug: string;
  force?: boolean;
}): Promise<{ slug: string }> {
  // The default board is seeded by `init` and assumed by init-less flows;
  // removing it would silently break those, so it is never deletable.
  if (opts.slug === DEFAULT_BOARD_SLUG) {
    throw new FkanbanError({
      code: "board_protected",
      message: `The "${DEFAULT_BOARD_SLUG}" board cannot be removed.`,
      hint: "It is the seeded board that init-less flows fall back to.",
    });
  }
  const board = await findBoard(opts.node, opts.cfg, opts.slug);
  if (!board) {
    throw new FkanbanError({ code: "board_not_found", message: `No board with slug "${opts.slug}".` });
  }
  // Don't silently orphan cards: a board with live cards is only removable with
  // --force (the cards remain, just on a now-hidden board).
  if (!opts.force) {
    const cards = await listCards(opts.node, opts.cfg);
    const live = cards.filter((c) => c.board === opts.slug);
    if (live.length > 0) {
      const n = live.length;
      throw new FkanbanError({
        code: "board_not_empty",
        message: `Board "${opts.slug}" still has ${n} live card${n === 1 ? "" : "s"}.`,
        hint: "Move or rm those cards first, or pass --force to remove the board anyway.",
      });
    }
  }
  const tombstoned: Board = {
    ...board,
    columns: [...new Set([...board.columns, TOMBSTONE_TAG])],
    updated_at: nowIso(),
  };
  const hash = schemaHashFor("board", opts.cfg);
  await opts.node.updateRecord({ schemaHash: hash, fields: boardToFields(tombstoned), keyHash: board.slug });
  return { slug: board.slug };
}

export async function requireBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board> {
  const board = await findBoard(node, cfg, slug);
  if (!board) {
    throw new FkanbanError({ code: "board_not_found", message: `No board with slug "${slug}".` });
  }
  return board;
}
