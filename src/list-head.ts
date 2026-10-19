// One column list is one exact key. The range is `__head__`. The atom holds
// at most 20 short cards and does not hold the card body. A missing head is
// an empty column. This path does not read an older list.

import type { NodeClient, RawResponse } from "./client.ts";

export const LIST_HEAD_SCHEMA_KEY = "kanban_list_head";
export const LIST_HEAD_RANGE = "__head__";
export const LIST_HEAD_CAP = 20;

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
};

export type HeadAtom = { cards: HeadCard[]; partial: boolean };

export type HeadKey = { board: string; column: string };

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
  };
}

function compareHead(a: HeadCard, b: HeadCard): number {
  if (a.position < b.position) return -1;
  if (a.position > b.position) return 1;
  if (a.slug < b.slug) return -1;
  if (a.slug > b.slug) return 1;
  return 0;
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
    });
  }
  return { cards: out, partial: body.partial === true };
}

export function encodeHead(cards: readonly HeadCard[]): HeadAtom {
  const sorted = [...cards].sort(compareHead);
  return {
    cards: sorted.slice(0, LIST_HEAD_CAP),
    partial: sorted.length > LIST_HEAD_CAP,
  };
}

export function upsertHeadCard(current: HeadAtom | null, card: HeadCard): HeadAtom {
  const prior = current?.cards ?? [];
  const next = [...prior.filter((item) => item.slug !== card.slug), card].sort(compareHead);
  return {
    cards: next.slice(0, LIST_HEAD_CAP),
    partial: next.length > LIST_HEAD_CAP || current?.partial === true,
  };
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

function queryBody(res: RawResponse): {
  results?: Array<{ fields?: Record<string, unknown>; key?: { hash?: string | null } }>;
} {
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`column head read failed: ${res.status} ${res.body.slice(0, 200)}`);
  }
  if (!res.json || typeof res.json !== "object") return {};
  return res.json as {
    results?: Array<{ fields?: Record<string, unknown>; key?: { hash?: string | null } }>;
  };
}

export async function readColumnHeads(
  node: NodeClient,
  schemaHash: string,
  keys: readonly HeadKey[],
): Promise<Map<string, HeadAtom>> {
  const out = new Map<string, HeadAtom>();
  if (keys.length === 0) return out;
  const res = await node.rawCall("POST", "/api/query", {
    schema_name: schemaHash,
    fields: ["klh_h", "klh_page"],
    filter: {
      HashRangeKeys: keys.map((key) => [columnHeadHash(key.board, key.column), LIST_HEAD_RANGE]),
    },
    limit: keys.length,
    offset: 0,
  });
  for (const row of queryBody(res).results ?? []) {
    const hash = typeof row.fields?.klh_h === "string" ? row.fields.klh_h : row.key?.hash ?? "";
    const match = keys.find((key) => columnHeadHash(key.board, key.column) === hash);
    if (!match) continue;
    out.set(headKeyId(match.board, match.column), parseHeadAtom(row.fields?.klh_page));
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

async function writeHeadAtom(
  node: NodeClient,
  schemaHash: string,
  board: string,
  column: string,
  atom: HeadAtom,
): Promise<void> {
  if (!node.updateRecords) throw new Error("node has no batch write");
  await node.updateRecords([{
    schemaHash,
    keyHash: columnHeadHash(board, column),
    rangeKey: LIST_HEAD_RANGE,
    fields: headFields(board, column, atom),
  }]);
}

async function loadHead(
  node: NodeClient,
  schemaHash: string,
  board: string,
  column: string,
): Promise<HeadAtom | null> {
  const found = await readColumnHeads(node, schemaHash, [{ board, column }]);
  return found.get(headKeyId(board, column)) ?? null;
}

export async function syncCardHead(
  node: NodeClient,
  schemaHash: string,
  card: HeadSource,
  previous: HeadSource | null,
): Promise<void> {
  if (!card.board || !card.column) return;
  const moved = previous !== null && (previous.board !== card.board || previous.column !== card.column);
  if (moved && previous.board && previous.column) {
    const current = await loadHead(node, schemaHash, previous.board, previous.column);
    await writeHeadAtom(
      node,
      schemaHash,
      previous.board,
      previous.column,
      removeHeadCard(current, card.slug),
    );
  }
  const current = await loadHead(node, schemaHash, card.board, card.column);
  await writeHeadAtom(
    node,
    schemaHash,
    card.board,
    card.column,
    upsertHeadCard(current, headCardFrom(card)),
  );
}

export async function removeCardsFromHeads(
  node: NodeClient,
  schemaHash: string,
  cards: readonly HeadSource[],
): Promise<void> {
  const groups = new Map<string, HeadKey & { slugs: string[] }>();
  for (const card of cards) {
    if (!card.board || !card.column || !card.slug) continue;
    const id = headKeyId(card.board, card.column);
    const group = groups.get(id) ?? { board: card.board, column: card.column, slugs: [] };
    group.slugs.push(card.slug);
    groups.set(id, group);
  }
  const keys = [...groups.values()];
  if (keys.length === 0) return;
  const found = await readColumnHeads(node, schemaHash, keys);
  if (!node.updateRecords) throw new Error("node has no batch write");
  await node.updateRecords(keys.map((key) => {
    let atom = found.get(headKeyId(key.board, key.column)) ?? null;
    for (const slug of key.slugs) atom = removeHeadCard(atom, slug);
    return {
      schemaHash,
      keyHash: columnHeadHash(key.board, key.column),
      rangeKey: LIST_HEAD_RANGE,
      fields: headFields(key.board, key.column, atom ?? { cards: [], partial: false }),
    };
  }));
}

export async function writeColumnHead(
  node: NodeClient,
  schemaHash: string,
  board: string,
  column: string,
  cards: readonly HeadCard[],
): Promise<HeadAtom> {
  const atom = encodeHead(cards);
  await writeHeadAtom(node, schemaHash, board, column, atom);
  return atom;
}
