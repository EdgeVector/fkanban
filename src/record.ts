// Domain helpers: turn fold_db query rows into typed Card / Board records,
// list + find by slug, soft-delete (tombstone), slug + column validation.

import { FkanbanError, type NodeClient, type QueryRow } from "./client.ts";
import { schemaHashFor, type Config } from "./config.ts";
import {
  DEFAULT_COLUMNS,
  fieldsFor,
  isDefaultColumn,
  type Column,
  type RecordType,
} from "./schemas.ts";

export type Card = {
  slug: string;
  title: string;
  body: string;
  board: string;
  column: string;
  position: string;
  assignee: string;
  tags: string[];
  created_at: string;
  updated_at: string;
};

export type Board = {
  slug: string;
  title: string;
  body: string;
  columns: string[];
  created_at: string;
  updated_at: string;
};

// Soft-delete sentinel — fold_db is append-only, so `fkanban rm` overwrites
// the record's fields and stamps this tag; every read path drops it.
export const TOMBSTONE_TAG = "__fkanban_deleted__";

export function isTombstoned(tags: string[]): boolean {
  return tags.includes(TOMBSTONE_TAG);
}

export function nowIso(): string {
  return new Date().toISOString();
}

function stringField(f: Record<string, unknown>, key: string): string {
  const v = f[key];
  if (typeof v === "string") return v;
  if (v == null) return "";
  return String(v);
}

function arrayStringField(f: Record<string, unknown>, key: string): string[] {
  const v = f[key];
  if (Array.isArray(v)) return v.filter((x): x is string => typeof x === "string");
  if (typeof v === "string" && v.length > 0) {
    return v.split(",").map((s) => s.trim()).filter((s) => s.length > 0);
  }
  return [];
}

export function rowToCard(row: QueryRow): Card {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    board: stringField(f, "board"),
    column: stringField(f, "column"),
    position: stringField(f, "position"),
    assignee: stringField(f, "assignee"),
    tags: arrayStringField(f, "tags"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
}

export function rowToBoard(row: QueryRow): Board {
  const f = (row.fields ?? {}) as Record<string, unknown>;
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    columns: arrayStringField(f, "columns"),
    created_at: stringField(f, "created_at"),
    updated_at: stringField(f, "updated_at"),
  };
}

export async function listCards(node: NodeClient, cfg: Config): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: fieldsFor("card") });
  return res.results.map(rowToCard).filter((c) => !isTombstoned(c.tags));
}

export async function listBoards(node: NodeClient, cfg: Config): Promise<Board[]> {
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: fieldsFor("board") });
  return res.results.map(rowToBoard).filter((b) => !isTombstoned(b.columns) && b.slug.length > 0);
}

export async function findCard(node: NodeClient, cfg: Config, slug: string): Promise<Card | null> {
  const cards = await listCards(node, cfg);
  return cards.find((c) => c.slug === slug) ?? null;
}

export async function findBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board | null> {
  const boards = await listBoards(node, cfg);
  return boards.find((b) => b.slug === slug) ?? null;
}

export function cardToFields(c: Card): Record<string, unknown> {
  return {
    slug: c.slug,
    title: c.title,
    body: c.body,
    board: c.board,
    column: c.column,
    position: c.position,
    assignee: c.assignee,
    tags: c.tags,
    created_at: c.created_at,
    updated_at: c.updated_at,
  };
}

export function boardToFields(b: Board): Record<string, unknown> {
  return {
    slug: b.slug,
    title: b.title,
    body: b.body,
    columns: b.columns,
    created_at: b.created_at,
    updated_at: b.updated_at,
  };
}

export function validateSlug(slug: string): void {
  if (slug.length === 0) {
    throw new FkanbanError({ code: "invalid_slug", message: "Slug must be non-empty." });
  }
  if (!/^[a-z0-9][a-z0-9-_]*$/.test(slug)) {
    throw new FkanbanError({
      code: "invalid_slug",
      message: `Slug "${slug}" is invalid.`,
      hint: "Slugs are lowercase, start with a letter or digit, and use [a-z0-9-_].",
    });
  }
}

// A card's column must be one of the board's columns (or, when the board has
// no explicit column list, one of the default columns).
export function ensureColumn(column: string, boardColumns: string[]): void {
  const valid = boardColumns.length > 0 ? boardColumns : [...DEFAULT_COLUMNS];
  if (!valid.includes(column)) {
    throw new FkanbanError({
      code: "invalid_column",
      message: `"${column}" is not a column on this board.`,
      hint: `Valid columns: ${valid.join(" | ")}`,
    });
  }
}

export function isColumn(s: string): s is Column {
  return isDefaultColumn(s);
}

// Order cards within a column: explicit integer `position` ascending, then
// created_at as a stable tiebreak. Non-numeric / empty positions sort last.
export function sortCards(cards: Card[]): Card[] {
  return cards.slice().sort((a, b) => {
    const pa = parsePosition(a.position);
    const pb = parsePosition(b.position);
    if (pa !== pb) return pa - pb;
    return a.created_at.localeCompare(b.created_at);
  });
}

function parsePosition(p: string): number {
  const n = parseInt(p, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

// Type guard for record-type-keyed config lookups used by the CLI.
export function recordTypeFields(type: RecordType): string[] {
  return fieldsFor(type);
}
