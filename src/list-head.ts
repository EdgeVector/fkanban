// One column list is one exact key. The range is `__head__`. The atom holds
// at most 20 short cards and does not hold the card body. A missing head is
// an empty column. This path does not read an older list.

import { FkanbanError, type NodeClient, type RawResponse } from "./client.ts";
import { DEFAULT_COLUMNS } from "./schemas.ts";

export const LIST_HEAD_SCHEMA_KEY = "kanban_list_head";
export const LIST_HEAD_RANGE = "__head__";
export const LIST_HEAD_CAP = 20;

// Same bound as HASH_RANGE_KEYS_PER_READ in record.ts. That constant stays
// private there. A longer HashRangeKeys page is a short page, not an empty column.
const HEAD_KEYS_PER_READ = 256;

// Same column as TERMINAL_COLUMN in record.ts. resolveColumns ignores a board
// column list and always returns backlog, todo, doing, done. The board view
// keeps the tail of that last column.
const TERMINAL_HEAD_COLUMN = "done";

const HEAD_BACKPRESSURE_DELAYS_MS = [1000, 3000] as const;

export type HeadCard = {
  slug: string;
  title: string;
  column: string;
  position: string;
  assignee: string;
  tags: string[];
  deps: string[];
  kind: string;
  milestone: string;
  created_at: string;
};

export type HeadAtom = { cards: HeadCard[]; partial: boolean };

export type HeadKey = { board: string; column: string };

// `complete` is false when the column read does not match the column spine.
// A short page must not become a finished head.
export type HeadRefillResult = { cards: HeadCard[]; complete: boolean };

export type HeadRefill = (
  board: string,
  column: string,
  exclude: readonly string[],
) => Promise<HeadRefillResult>;

export type HeadHooks = { refill?: HeadRefill };

type HeadSource = {
  slug: string;
  title: string;
  board: string;
  column: string;
  position: string;
  assignee?: string;
  tags?: string[];
  deps?: string[];
  kind?: string;
  milestone?: string;
  created_at?: string;
};

type HeadWrite = { board: string; column: string; atom: HeadAtom };

type HeadQuery = {
  results?: Array<{ fields?: Record<string, unknown>; key?: { hash?: string | null } }>;
  has_more?: boolean;
};

export function columnHeadHash(board: string, column: string): string {
  return `col#${board}#${column}`;
}

export function headKeyId(board: string, column: string): string {
  return `${board}\u0000${column}`;
}

export function headCardFrom(card: HeadSource): HeadCard {
  return {
    slug: card.slug,
    title: card.title,
    column: card.column,
    position: card.position,
    assignee: card.assignee ?? "",
    tags: card.tags ?? [],
    deps: card.deps ?? [],
    kind: card.kind ?? "",
    milestone: card.milestone ?? "",
    created_at: card.created_at ?? "",
  };
}

// Same integer order as parsePosition + sortCards. Equal positions use
// created_at. An empty or non-numeric position sorts last.
function positionRank(position: string): number {
  const n = parseInt(position, 10);
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

function compareHead(a: HeadCard, b: HeadCard): number {
  const byPosition = positionRank(a.position) - positionRank(b.position);
  if (byPosition !== 0) return byPosition;
  return a.created_at.localeCompare(b.created_at);
}

function takeCapped(sorted: readonly HeadCard[], column: string, keepSlug?: string): HeadCard[] {
  const high = column === TERMINAL_HEAD_COLUMN;
  let kept = high
    ? sorted.slice(Math.max(0, sorted.length - LIST_HEAD_CAP))
    : sorted.slice(0, LIST_HEAD_CAP);
  if (!keepSlug || kept.some((card) => card.slug === keepSlug)) return [...kept];
  const must = sorted.find((card) => card.slug === keepSlug);
  if (!must) return [...kept];
  kept = high ? kept.slice(1) : kept.slice(0, -1);
  return [...kept, must].sort(compareHead);
}

function capComplete(cards: readonly HeadCard[], column: string, keepSlug?: string): HeadAtom {
  const sorted = [...cards].sort(compareHead);
  return {
    cards: takeCapped(sorted, column, keepSlug),
    partial: sorted.length > LIST_HEAD_CAP,
  };
}

function asStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

export function parseHeadAtom(raw: unknown): HeadAtom {
  if (typeof raw !== "string" || raw.length === 0) return { cards: [], partial: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { cards: [], partial: false };
  }
  if (!parsed || typeof parsed !== "object") return { cards: [], partial: false };
  const body = parsed as { cards?: unknown; partial?: unknown };
  const cards = Array.isArray(body.cards) ? body.cards : [];
  const out: HeadCard[] = [];
  for (const item of cards) {
    if (!item || typeof item !== "object") continue;
    const card = item as Partial<HeadCard>;
    if (typeof card.slug !== "string" || card.slug.length === 0) continue;
    out.push({
      slug: card.slug,
      title: typeof card.title === "string" ? card.title : "",
      column: typeof card.column === "string" ? card.column : "",
      position: typeof card.position === "string" ? card.position : "",
      assignee: typeof card.assignee === "string" ? card.assignee : "",
      tags: asStringList(card.tags),
      deps: asStringList(card.deps),
      kind: typeof card.kind === "string" ? card.kind : "",
      milestone: typeof card.milestone === "string" ? card.milestone : "",
      created_at: typeof card.created_at === "string" ? card.created_at : "",
    });
  }
  return { cards: out, partial: body.partial === true };
}

export function encodeHead(cards: readonly HeadCard[], column: string): HeadAtom {
  return capComplete(cards, column);
}

export function upsertHeadCard(current: HeadAtom | null, card: HeadCard): HeadAtom {
  const prior = current?.cards ?? [];
  const wasPresent = prior.some((item) => item.slug === card.slug);
  const next = [...prior.filter((item) => item.slug !== card.slug), card].sort(compareHead);
  if (next.length > LIST_HEAD_CAP) {
    // A new slug is the card this command added or moved, so the window keeps it.
    // A slug that was already stored is a position rewrite. Recompute the window.
    const keep = wasPresent ? undefined : card.slug;
    return { cards: takeCapped(next, card.column, keep), partial: true };
  }
  // Under the cap, a previous partial atom is still short. The caller refills.
  return { cards: next, partial: current?.partial === true };
}

export function removeHeadCard(current: HeadAtom | null, slug: string): HeadAtom {
  return {
    cards: (current?.cards ?? []).filter((item) => item.slug !== slug),
    partial: current?.partial === true,
  };
}

export function headFields(board: string, column: string, atom: HeadAtom): Record<string, string> {
  return {
    klh_h: columnHeadHash(board, column),
    klh_r: LIST_HEAD_RANGE,
    klh_page: JSON.stringify(atom),
  };
}

function columnHeadReadError(res: RawResponse): FkanbanError {
  const text = res.body.slice(0, 400);
  const lower = text.toLowerCase();
  const provision = lower.includes("node_not_provisioned");
  const busy = !provision && (
    res.status === 503 ||
    lower.includes("too many concurrent") ||
    lower.includes("overloaded") ||
    lower.includes("service_timeout")
  );
  if (busy) {
    return new FkanbanError({
      code: lower.includes("service_timeout") ? "service_timeout" : "node_overloaded",
      message: `column head read failed: ${res.status} ${text}`,
    });
  }
  return new FkanbanError({
    code: "column_head_read_failed",
    message: `column head read failed: ${res.status} ${text}`,
  });
}

function queryBody(res: RawResponse): HeadQuery {
  if (res.status < 200 || res.status >= 300) throw columnHeadReadError(res);
  if (!res.json || typeof res.json !== "object") return {};
  return res.json as HeadQuery;
}

function isHeadBackpressure(err: unknown): boolean {
  return err instanceof FkanbanError &&
    (err.code === "service_timeout" || err.code === "node_overloaded");
}

async function withHeadRetry<T>(work: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await work();
    } catch (err) {
      const wait = HEAD_BACKPRESSURE_DELAYS_MS[attempt];
      if (wait === undefined || !isHeadBackpressure(err)) throw err;
      const code = err instanceof FkanbanError ? err.code : "node_overloaded";
      console.error(
        `kanban: column head update hit node backpressure (${code}); retry ${attempt + 1}/${HEAD_BACKPRESSURE_DELAYS_MS.length} in ${wait}ms`,
      );
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
}

async function readHeadChunk(
  node: NodeClient,
  schemaHash: string,
  keys: readonly HeadKey[],
): Promise<Map<string, HeadAtom>> {
  const out = new Map<string, HeadAtom>();
  let res: RawResponse;
  try {
    res = await node.rawCall("POST", "/api/query", {
      schema_name: schemaHash,
      fields: ["klh_h", "klh_page"],
      filter: {
        HashRangeKeys: keys.map((key) => [columnHeadHash(key.board, key.column), LIST_HEAD_RANGE]),
      },
      limit: keys.length,
      offset: 0,
    });
  } catch (err) {
    if (err instanceof FkanbanError) throw err;
    throw new FkanbanError({
      code: "column_head_read_failed",
      message: `column head read failed: ${err instanceof Error ? err.message : String(err)}`,
      cause: err,
    });
  }
  const body = queryBody(res);
  if (body.has_more === true) {
    throw new FkanbanError({
      code: "column_head_read_failed",
      message: "column head read returned a short page",
    });
  }
  for (const row of body.results ?? []) {
    const hash = typeof row.fields?.klh_h === "string" ? row.fields.klh_h : row.key?.hash ?? "";
    const match = keys.find((key) => columnHeadHash(key.board, key.column) === hash);
    if (!match) continue;
    out.set(headKeyId(match.board, match.column), parseHeadAtom(row.fields?.klh_page));
  }
  return out;
}

export async function readColumnHeads(
  node: NodeClient,
  schemaHash: string,
  keys: readonly HeadKey[],
): Promise<Map<string, HeadAtom>> {
  const out = new Map<string, HeadAtom>();
  for (let i = 0; i < keys.length; i += HEAD_KEYS_PER_READ) {
    const page = await readHeadChunk(node, schemaHash, keys.slice(i, i + HEAD_KEYS_PER_READ));
    for (const [id, atom] of page) out.set(id, atom);
  }
  return out;
}

export async function readColumnHead(
  node: NodeClient,
  schemaHash: string,
  board: string,
  column: string,
): Promise<RawResponse> {
  return node.rawCall("POST", "/api/query", {
    schema_name: schemaHash,
    fields: ["klh_page"],
    filter: { HashRangeKey: { hash: columnHeadHash(board, column), range: LIST_HEAD_RANGE } },
    limit: 1,
    offset: 0,
  });
}

async function writeHeadAtoms(
  node: NodeClient,
  schemaHash: string,
  writes: readonly HeadWrite[],
): Promise<void> {
  if (writes.length === 0) return;
  if (!node.updateRecords) throw new Error("node has no batch write");
  const rows = writes.map((write) => ({
    schemaHash,
    keyHash: columnHeadHash(write.board, write.column),
    rangeKey: LIST_HEAD_RANGE,
    fields: headFields(write.board, write.column, write.atom),
  }));
  // Same request size as the card delete batch. One board is four column heads.
  for (let i = 0; i < rows.length; i += 48) {
    await node.updateRecords(rows.slice(i, i + 48));
  }
}

function sameAtom(a: HeadAtom, b: HeadAtom): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function emptyAtom(): HeadAtom {
  return { cards: [], partial: false };
}

async function refillShort(
  atom: HeadAtom,
  board: string,
  column: string,
  exclude: readonly string[],
  refill: HeadRefill | undefined,
  keep?: HeadCard,
): Promise<HeadAtom> {
  if (!atom.partial || atom.cards.length >= LIST_HEAD_CAP || !refill) return atom;
  const result = await refill(board, column, exclude);
  const live = result.cards.filter((card) => !exclude.includes(card.slug));
  const withKeep = keep ? [...live.filter((card) => card.slug !== keep.slug), keep] : live;
  // A short or empty read must not replace the stored titles or clear partial.
  if (!result.complete) return atom;
  const seen = new Set(withKeep.map((card) => card.slug));
  for (const card of atom.cards) {
    if (exclude.includes(card.slug) || card.slug === keep?.slug) continue;
    if (!seen.has(card.slug)) return atom;
  }
  if (
    live.length === 0 &&
    atom.cards.some((card) => !exclude.includes(card.slug) && card.slug !== keep?.slug)
  ) {
    return atom;
  }
  return capComplete(withKeep, column, keep?.slug);
}

function columnNames(board: string, card: HeadSource, previous: HeadSource | null): string[] {
  const names = new Set<string>(DEFAULT_COLUMNS);
  if (card.board === board && card.column) names.add(card.column);
  if (previous?.board === board && previous.column) names.add(previous.column);
  return [...names];
}

async function syncCardHeadOnce(
  node: NodeClient,
  schemaHash: string,
  card: HeadSource,
  previous: HeadSource | null,
  hooks?: HeadHooks,
): Promise<void> {
  if (!card.board || !card.column || !card.slug) return;
  const boards = [card.board];
  if (previous?.board && previous.board !== card.board) boards.push(previous.board);
  const head = headCardFrom(card);
  const writes: HeadWrite[] = [];
  for (const board of boards) {
    const columns = columnNames(board, card, previous);
    const found = await readColumnHeads(
      node,
      schemaHash,
      columns.map((column) => ({ board, column })),
    );
    for (const column of columns) {
      const before = found.get(headKeyId(board, column)) ?? null;
      const destination = board === card.board && column === card.column;
      let after: HeadAtom;
      if (destination) {
        after = upsertHeadCard(before, head);
        after = await refillShort(after, board, column, [], hooks?.refill, head);
      } else {
        if (!(before?.cards ?? []).some((item) => item.slug === card.slug)) continue;
        after = removeHeadCard(before, card.slug);
        after = await refillShort(after, board, column, [card.slug], hooks?.refill);
      }
      if (!sameAtom(after, before ?? emptyAtom())) writes.push({ board, column, atom: after });
    }
  }
  await writeHeadAtoms(node, schemaHash, writes);
}

export async function syncCardHead(
  node: NodeClient,
  schemaHash: string,
  card: HeadSource,
  previous: HeadSource | null,
  hooks?: HeadHooks,
): Promise<void> {
  await withHeadRetry(() => syncCardHeadOnce(node, schemaHash, card, previous, hooks));
}

async function removeCardsFromHeadsOnce(
  node: NodeClient,
  schemaHash: string,
  cards: readonly HeadSource[],
  hooks?: HeadHooks,
): Promise<void> {
  const byBoard = new Map<string, { slugs: string[]; columns: Set<string> }>();
  for (const card of cards) {
    if (!card.slug || !card.board) continue;
    const group = byBoard.get(card.board) ?? { slugs: [], columns: new Set<string>(DEFAULT_COLUMNS) };
    if (!group.slugs.includes(card.slug)) group.slugs.push(card.slug);
    if (card.column) group.columns.add(card.column);
    byBoard.set(card.board, group);
  }
  const writes: HeadWrite[] = [];
  for (const [board, group] of byBoard) {
    const columns = [...group.columns];
    const found = await readColumnHeads(
      node,
      schemaHash,
      columns.map((column) => ({ board, column })),
    );
    for (const column of columns) {
      const before = found.get(headKeyId(board, column)) ?? null;
      if (!(before?.cards ?? []).some((item) => group.slugs.includes(item.slug))) continue;
      let after = before;
      for (const slug of group.slugs) after = removeHeadCard(after, slug);
      after = await refillShort(after ?? emptyAtom(), board, column, group.slugs, hooks?.refill);
      if (!sameAtom(after, before ?? emptyAtom())) writes.push({ board, column, atom: after });
    }
  }
  await writeHeadAtoms(node, schemaHash, writes);
}

export async function removeCardsFromHeads(
  node: NodeClient,
  schemaHash: string,
  cards: readonly HeadSource[],
  hooks?: HeadHooks,
): Promise<void> {
  await withHeadRetry(() => removeCardsFromHeadsOnce(node, schemaHash, cards, hooks));
}

export async function writeColumnHead(
  node: NodeClient,
  schemaHash: string,
  board: string,
  column: string,
  cards: readonly HeadCard[],
): Promise<HeadAtom> {
  const atom = encodeHead(cards, column);
  await writeHeadAtoms(node, schemaHash, [{ board, column, atom }]);
  return atom;
}
