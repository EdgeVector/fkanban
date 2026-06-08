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
  const columns = (board.columns.length > 0 ? board.columns : [...DEFAULT_COLUMNS]).filter(
    (c) => !opts.column || c === opts.column,
  );

  const lines: string[] = [];
  const heading = `${board.title || board.slug}  ${paint(color, "dim", `(${board.slug})`)}`;
  lines.push(paint(color, "bold", heading));
  lines.push("");

  for (const col of columns) {
    const inCol = sortCards(cards.filter((c) => c.column === col));
    const colCode = COLUMN_COLOR[col] ?? "cyan";
    const header = `${col.toUpperCase()}  ${paint(color, "dim", `(${inCol.length})`)}`;
    lines.push(paint(color, colCode, header));
    if (inCol.length === 0) {
      lines.push(paint(color, "dim", "  —"));
    } else {
      for (const c of inCol) {
        lines.push(renderCardLine(c, color, opts.blocked?.has(c.slug) ?? false));
      }
    }
    lines.push("");
  }
  return lines.join("\n").replace(/\n+$/, "\n");
}

function renderCardLine(c: Card, color: boolean, blocked: boolean): string {
  const meta: string[] = [];
  if (c.assignee) meta.push(`@${c.assignee}`);
  if (c.deps.length > 0) meta.push(`deps:${c.deps.length}`);
  if (c.tags.length > 0) meta.push(c.tags.map((t) => `#${t}`).join(" "));
  const suffix = meta.length > 0 ? "  " + paint(color, "dim", meta.join("  ")) : "";
  const slug = paint(color, "cyan", c.slug);
  const marker = blocked ? paint(color, "yellow", "🔒 ") : "";
  return `  • ${marker}${c.title || c.slug}  ${slug}${suffix}`;
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
