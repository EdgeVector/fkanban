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
  // Only when columns were explicitly supplied: reject DUPLICATE names. The
  // list is already trim/filter-cleaned by parseTags, so an empty/all-empty
  // string falls back to DEFAULT_COLUMNS below and is never checked here.
  // A duplicate would otherwise be stored verbatim and silently corrupt the
  // board — `list` renders the doubled column (and its cards) twice. This is
  // the same validate-loudly contract slugs / `--column` typos / dep cycles
  // already enforce; column names are compared as exact strings (matching how
  // `ensureColumn` does `boardColumns.includes(column)` elsewhere).
  if (opts.columns && opts.columns.length > 0) {
    const seen = new Set<string>();
    const dups = new Set<string>();
    for (const name of opts.columns) {
      if (seen.has(name)) dups.add(name);
      seen.add(name);
    }
    if (dups.size > 0) {
      const list = [...dups].map((d) => `"${d}"`).join(", ");
      const first = [...dups][0]!;
      throw new FkanbanError({
        code: "dup_columns",
        message: `Duplicate column name "${first}" in --columns.`,
        hint: `Column names must be unique: ${list}.`,
      });
    }
  }
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

// Both the human text and the structured board list, from a single read.
// `boardListCmd` (CLI) returns one; the MCP tool returns both.
export async function boardListResult(opts: {
  cfg: Config;
  node: NodeClient;
}): Promise<{ text: string; boards: Board[] }> {
  const boards = await listBoards(opts.node, opts.cfg);
  const text =
    boards.length === 0
      ? "No boards. Run `fkanban init` to seed the default board."
      : boards
          .map((b) => `${b.slug.padEnd(20)} ${b.title}\n  columns: ${b.columns.join(" → ")}`)
          .join("\n");
  return { text, boards };
}

export async function boardListCmd(opts: {
  cfg: Config;
  node: NodeClient;
  json?: boolean;
}): Promise<string> {
  const { text, boards } = await boardListResult(opts);
  return opts.json ? JSON.stringify(boards, null, 2) : text;
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
