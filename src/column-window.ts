// A bounded display window derived from the schema's named column key.
// This module has no stored payload or mutation path.
export const COLUMN_WINDOW_CAP = 20;

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

export function headKeyId(board: string, column: string): string {
  return `${board}\u0000${column}`;
}

export function headCardFrom(card: Pick<HeadCard, "slug" | "title" | "column" | "position"> & Partial<HeadCard>): HeadCard {
  return {
    slug: card.slug, title: card.title, column: card.column, position: card.position,
    assignee: card.assignee ?? "", tags: card.tags ?? [], deps: card.deps ?? [],
    kind: card.kind ?? "", milestone: card.milestone ?? "", created_at: card.created_at ?? "",
  };
}

function positionRank(position: string): number {
  const number = parseInt(position, 10);
  return Number.isFinite(number) ? number : Number.MAX_SAFE_INTEGER;
}

export function capComplete(cards: readonly HeadCard[], column: string): HeadAtom {
  const sorted = [...cards].sort((a, b) => {
    const position = positionRank(a.position) - positionRank(b.position);
    return position !== 0 ? position : a.created_at.localeCompare(b.created_at);
  });
  return {
    cards: column === "done" ? sorted.slice(-COLUMN_WINDOW_CAP) : sorted.slice(0, COLUMN_WINDOW_CAP),
    partial: sorted.length > COLUMN_WINDOW_CAP,
  };
}
