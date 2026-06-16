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
  // Slugs of cards this card depends on (it is "blocked" until each is in the
  // `done` column). Stored on the wire as `dep:<slug>` entries in `tags` — see
  // DEP_TAG_PREFIX — so dependencies needed no schema change / republish.
  deps: string[];
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

// Dependency edges piggyback on the existing `tags` array: a card that depends
// on `foo` carries the reserved tag `dep:foo`. rowToCard splits these out into
// `deps`, and cardToFields folds them back in, so dep tags never surface as
// user-facing labels (same trick as TOMBSTONE_TAG).
export const DEP_TAG_PREFIX = "dep:";

export function isDepTag(tag: string): boolean {
  return tag.startsWith(DEP_TAG_PREFIX);
}

export function depTag(slug: string): string {
  return `${DEP_TAG_PREFIX}${slug}`;
}

// Clean a dep list: trim, drop blanks, drop self-references, dedupe (order-stable).
export function normalizeDeps(deps: string[], selfSlug: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const d of deps) {
    const s = d.trim();
    if (s.length === 0 || s === selfSlug || seen.has(s)) continue;
    seen.add(s);
    out.push(s);
  }
  return out;
}

// The columns at which dependencies actually gate work. A dependency is
// satisfied only once its card reaches `done`; entering one of these "started"
// columns while still blocked is what `move` refuses (unless --force).
export const WORKING_COLUMNS = ["doing", "review", "done"] as const;

export function isWorkingColumn(column: string): boolean {
  return (WORKING_COLUMNS as readonly string[]).includes(column);
}

export type DepStatus = {
  // Existing dep cards not yet in `done` — these block this card.
  blockedBy: string[];
  // Dep slugs with no live card (deleted or forward-referenced) — surfaced as a
  // warning, but they do NOT block (a dangling dep can never reach `done`).
  missing: string[];
  blocked: boolean;
};

// Resolve a card's deps against the full set of live cards.
export function depStatus(card: Card, allCards: Card[]): DepStatus {
  const bySlug = new Map(allCards.map((c) => [c.slug, c]));
  const blockedBy: string[] = [];
  const missing: string[] = [];
  for (const dep of card.deps) {
    const d = bySlug.get(dep);
    if (!d) {
      missing.push(dep);
    } else if (d.column !== "done") {
      blockedBy.push(dep);
    }
  }
  return { blockedBy, missing, blocked: blockedBy.length > 0 };
}

// Map of slug → blocked? across a set of cards, resolved against `allCards`.
export function blockedSlugSet(cards: Card[], allCards: Card[]): Set<string> {
  const blocked = new Set<string>();
  for (const c of cards) {
    if (depStatus(c, allCards).blocked) blocked.add(c.slug);
  }
  return blocked;
}

// Case-insensitive substring search over a card's user-facing content (slug,
// title, body, assignee, and visible tags — dep/tombstone tags never reach
// here). Multi-word queries are AND-matched: every whitespace-separated term
// must appear somewhere in the card, so `auth p1` finds cards mentioning both.
export function cardMatchesQuery(card: Card, query: string): boolean {
  const terms = query.toLowerCase().split(/\s+/).filter((t) => t.length > 0);
  if (terms.length === 0) return true;
  const hay = [card.slug, card.title, card.body, card.assignee, ...card.tags]
    .join("\n")
    .toLowerCase();
  return terms.every((t) => hay.includes(t));
}

// Filter a card list to those matching `query` (see cardMatchesQuery).
export function searchCards(cards: Card[], query: string): Card[] {
  return cards.filter((c) => cardMatchesQuery(c, query));
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
  const allTags = arrayStringField(f, "tags");
  const deps = allTags
    .filter(isDepTag)
    .map((t) => t.slice(DEP_TAG_PREFIX.length))
    .filter((s) => s.length > 0);
  return {
    slug: stringField(f, "slug"),
    title: stringField(f, "title"),
    body: stringField(f, "body"),
    board: stringField(f, "board"),
    column: stringField(f, "column"),
    position: stringField(f, "position"),
    assignee: stringField(f, "assignee"),
    // dep tags are split into `deps`; everything else (incl. the tombstone) stays.
    tags: allTags.filter((t) => !isDepTag(t)),
    deps,
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

// Fields sufficient to resolve dependency status / card existence — everything
// except the heavy spec `body` (and other display-only fields). Used by the
// read paths that fan out over the whole board so they don't re-download every
// card's multi-paragraph body.
export const CARD_STATUS_FIELDS = ["slug", "board", "column", "position", "tags", "created_at"];

// Like listCards but fetches only CARD_STATUS_FIELDS; absent fields come back
// as "" on the Card. Enough for depStatus / blockedSlugSet / existence checks.
export async function listCardStatuses(node: NodeClient, cfg: Config): Promise<Card[]> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({ schemaHash: hash, fields: CARD_STATUS_FIELDS });
  return res.results.map(rowToCard).filter((c) => !isTombstoned(c.tags));
}

// Point read by slug — the node resolves a HashKey filter as an indexed key
// lookup, so this never scans the board.
export async function findCard(node: NodeClient, cfg: Config, slug: string): Promise<Card | null> {
  const hash = schemaHashFor("card", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("card"),
    filter: { HashKey: slug },
  });
  const card = res.results.map(rowToCard).find((c) => c.slug === slug);
  return card !== undefined && !isTombstoned(card.tags) ? card : null;
}

export async function findBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board | null> {
  const hash = schemaHashFor("board", cfg);
  const res = await node.queryAll({
    schemaHash: hash,
    fields: fieldsFor("board"),
    filter: { HashKey: slug },
  });
  const board = res.results.map(rowToBoard).find((b) => b.slug === slug);
  return board !== undefined && !isTombstoned(board.columns) && board.slug.length > 0
    ? board
    : null;
}

// Resolve a board by slug, throwing the canonical `board_not_found` error
// when it doesn't exist. Shared by `add`, `list`, and `search` so the message
// + hint stay identical in one place.
export async function requireBoard(node: NodeClient, cfg: Config, slug: string): Promise<Board> {
  const board = await findBoard(node, cfg, slug);
  if (!board) {
    throw new FkanbanError({
      code: "board_not_found",
      message: `Board "${slug}" does not exist.`,
      hint: `Create it first: \`fkanban board create ${slug}\` (or use the default board).`,
    });
  }
  return board;
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
    // Persist deps back as reserved `dep:<slug>` tags alongside the user tags.
    tags: [...c.tags.filter((t) => !isDepTag(t)), ...c.deps.map(depTag)],
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

// Position for a card appended to a column: current epoch millis. Positions
// only need to sort ascending, so a timestamp appends after everything already
// there (legacy hand-numbered positions are tiny by comparison) without ever
// reading the rest of the board. Same-millisecond appends fall back to the
// created_at tiebreak in sortCards.
export function appendPosition(): string {
  return String(Date.now());
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
