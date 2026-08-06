/** Unwrap CLI list/search/board-list --json envelopes in tests. */
export function cardsFromJson(out: string): any[] {
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed)) return parsed;
  if (parsed && Array.isArray(parsed.cards)) return parsed.cards;
  if (parsed && Array.isArray(parsed.boards)) return parsed.boards;
  if (parsed && Array.isArray(parsed.issues)) return parsed.issues;
  throw new Error(`unexpected json page shape: ${typeof parsed}`);
}

export function pageFromJson(out: string): { items: any[]; total?: number; truncated?: boolean; raw: any } {
  const parsed = JSON.parse(out);
  if (Array.isArray(parsed)) return { items: parsed, raw: parsed };
  if (parsed && Array.isArray(parsed.cards)) {
    return { items: parsed.cards, total: parsed.total, truncated: parsed.truncated, raw: parsed };
  }
  if (parsed && Array.isArray(parsed.boards)) {
    return { items: parsed.boards, total: parsed.total, truncated: parsed.truncated, raw: parsed };
  }
  throw new Error(`unexpected json page shape`);
}
