// Render a kanban board to the terminal: one section per column, cards
// listed under their column in position order.

import { DEFAULT_COLUMNS } from "./schemas.ts";
import { sortCards, type Board, type Card, type DepStatus } from "./record.ts";

export type RenderOptions = {
  // Restrict to a single column.
  column?: string;
  // ANSI colour. Defaults to on when stdout is a TTY.
  color?: boolean;
  // Slugs of cards currently blocked by an unfinished dependency — rendered
  // with a 🔒 marker.
  blocked?: Set<string>;
  // Max cards rendered per column; overflow collapses to a dim "… N more"
  // line so a long column (typically `done`) can't flood the terminal.
  // 0 or undefined → no cap. The terminal (last) column shows the most
  // RECENT N (tail); other columns show the first N (top of the column).
  limit?: number;
};

const COLORS: Record<string, string> = {
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  dim: "\x1b[2m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  blue: "\x1b[34m",
};

function paint(on: boolean, code: string, s: string): string {
  if (!on) return s;
  return `${COLORS[code] ?? ""}${s}${COLORS.reset}`;
}

const COLUMN_COLOR: Record<string, string> = {
  backlog: "dim",
  todo: "blue",
  doing: "yellow",
  review: "magenta",
  done: "green",
};

export function renderBoard(
  board: Board,
  cards: Card[],
  opts: RenderOptions = {},
): string {
  const color = opts.color ?? Boolean(process.stdout.isTTY);
  const allColumns = board.columns.length > 0 ? board.columns : [...DEFAULT_COLUMNS];
  // The terminal column (conventionally `done`) grows without bound, so it
  // gets tail-truncation; identify it from the full column order before any
  // single-column filter narrows the view.
  const terminalCol = allColumns[allColumns.length - 1];
  const columns = allColumns.filter((c) => !opts.column || c === opts.column);
  const cap = opts.limit && opts.limit > 0 ? opts.limit : 0;

  const lines: string[] = [];
  const heading = `${board.title || board.slug}  ${paint(color, "dim", `(${board.slug})`)}`;
  lines.push(paint(color, "bold", heading));
  lines.push("");

  // Whole-board-empty first-run nudge: a brand-new board (0 cards) viewed
  // without a `--column` filter gets a copy-pasteable getting-started hint
  // instead of the bare five-`—` column skeleton, which is a dead-end first
  // screen right after `init`. A single-column view (opts.column) is a
  // deliberate narrow look and keeps its `—`; a board with any card renders
  // normally.
  if (!opts.column && cards.length === 0) {
    lines.push("No cards yet. Create your first:");
    lines.push(paint(color, "cyan", `  fkanban add my-first-card --title "My first card"`));
    lines.push("");
    lines.push(
      paint(
        color,
        "dim",
        "(then `fkanban list` to see it, or `fkanban mcp` to drive the board from an agent)",
      ),
    );
    return lines.join("\n").replace(/\n+$/, "\n");
  }

  for (const col of columns) {
    const inCol = sortCards(cards.filter((c) => c.column === col));
    const colCode = COLUMN_COLOR[col] ?? "cyan";
    const header = `${col.toUpperCase()}  ${paint(color, "dim", `(${inCol.length})`)}`;
    lines.push(paint(color, colCode, header));
    if (inCol.length === 0) {
      lines.push(paint(color, "dim", "  —"));
    } else {
      const hidden = cap > 0 && inCol.length > cap ? inCol.length - cap : 0;
      // Show the most recent N for the terminal column (tail), the first N
      // otherwise (top-of-column is what you act on next).
      const visible = hidden === 0
        ? inCol
        : col === terminalCol
          ? inCol.slice(inCol.length - cap)
          : inCol.slice(0, cap);
      for (const c of visible) {
        lines.push(renderCardLine(c, color, opts.blocked?.has(c.slug) ?? false));
      }
      if (hidden > 0) {
        const word = col === terminalCol ? "earlier" : "more";
        lines.push(paint(color, "dim", `  … ${hidden} ${word} (--all)`));
      }
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

// Apply the per-column cap to a flat card list, returning a flat list in the
// same order. Mirrors the visible-card selection `renderBoard` does for text
// (head-of-column for most columns, tail for the terminal `done` column, since
// `done` grows by recency), so the structured `--json` view caps to the exact
// same cards the text view shows. `limit <= 0` (or `--all`) means no cap and
// returns the input unchanged.
export function capPerColumn<T extends Card>(
  board: Board,
  cards: T[],
  limit: number,
  column?: string,
): T[] {
  if (!(limit > 0)) return cards;
  const allColumns = board.columns.length > 0 ? board.columns : [...DEFAULT_COLUMNS];
  const terminalCol = allColumns[allColumns.length - 1];
  const columns = allColumns.filter((c) => !column || c === column);
  const out: T[] = [];
  for (const col of columns) {
    const inCol = sortCards(cards.filter((c) => c.column === col));
    const visible =
      inCol.length <= limit
        ? inCol
        : col === terminalCol
          ? inCol.slice(inCol.length - limit)
          : inCol.slice(0, limit);
    out.push(...visible);
  }
  return out;
}

function cardMetaSuffix(c: Card, color: boolean): string {
  const meta: string[] = [];
  if (c.assignee) meta.push(`@${c.assignee}`);
  if (c.deps.length > 0) meta.push(`deps:${c.deps.length}`);
  if (c.tags.length > 0) meta.push(c.tags.map((t) => `#${t}`).join(" "));
  return meta.length > 0 ? "  " + paint(color, "dim", meta.join("  ")) : "";
}

function renderCardLine(c: Card, color: boolean, blocked: boolean): string {
  const slug = paint(color, "cyan", c.slug);
  const marker = blocked ? paint(color, "yellow", "🔒 ") : "";
  return `  • ${marker}${c.title || c.slug}  ${slug}${cardMetaSuffix(c, color)}`;
}

// Render search hits as a flat list. Unlike the board view, matches can span
// columns and boards, so each line is annotated with its `[board/column]`.
export function renderSearchResults(
  cards: Card[],
  query: string,
  opts: { color?: boolean; blocked?: Set<string> } = {},
): string {
  const color = opts.color ?? Boolean(process.stdout.isTTY);
  if (cards.length === 0) return paint(color, "dim", `No cards match "${query}".`);

  const lines: string[] = [];
  const count = `${cards.length} match${cards.length === 1 ? "" : "es"}`;
  lines.push(paint(color, "bold", `${count} for "${query}"`));
  lines.push("");
  for (const c of sortCards(cards)) {
    const loc = paint(color, "dim", `[${c.board}/${c.column}]`);
    const slug = paint(color, "cyan", c.slug);
    const marker = opts.blocked?.has(c.slug) ? paint(color, "yellow", "🔒 ") : "";
    lines.push(`  • ${marker}${loc} ${c.title || c.slug}  ${slug}${cardMetaSuffix(c, color)}`);
  }
  return lines.join("\n");
}

export function renderCardDetail(
  c: Card,
  color = Boolean(process.stdout.isTTY),
  status?: DepStatus,
): string {
  const lines: string[] = [];
  const blocked = status?.blocked ? paint(color, "yellow", " 🔒 blocked") : "";
  lines.push(paint(color, "bold", c.title || c.slug) + blocked);
  lines.push(paint(color, "dim", `${c.slug} · ${c.board}/${c.column}`));
  if (c.assignee) lines.push(`assignee: @${c.assignee}`);
  if (c.tags.length > 0) lines.push(`tags: ${c.tags.map((t) => `#${t}`).join(" ")}`);
  if (c.deps.length > 0) {
    lines.push(`deps: ${c.deps.map((d) => renderDep(d, color, status)).join("  ")}`);
    if (status && status.missing.length > 0) {
      lines.push(paint(color, "dim", `  (no card found for: ${status.missing.join(", ")})`));
    }
  }
  lines.push(paint(color, "dim", `created ${c.created_at} · updated ${c.updated_at}`));
  if (c.body.trim().length > 0) {
    lines.push("");
    lines.push(c.body);
  }
  return lines.join("\n");
}

// One dependency slug, painted by its resolved state: green=done (satisfied),
// yellow=still blocking, dim=unknown (no status passed) or missing.
function renderDep(dep: string, color: boolean, status?: DepStatus): string {
  if (!status) return dep;
  if (status.missing.includes(dep)) return paint(color, "dim", `${dep}?`);
  if (status.blockedBy.includes(dep)) return paint(color, "yellow", dep);
  return paint(color, "green", `${dep}✓`);
}
