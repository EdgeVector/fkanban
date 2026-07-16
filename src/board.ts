// Render a kanban board to the terminal: one section per column, cards
// listed under their column in position order.

import { DEFAULT_BOARD_SLUG, resolveColumns } from "./schemas.ts";
import { normalizeKind, sortCards, type Board, type Card, type DepStatus } from "./record.ts";

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
  // Command prefix the empty-board first-touch hint prints — the global
  // `fkanban` shim when it's on PATH, else `bun run src/cli.ts` from the repo
  // (the fresh-clone default, before `bun run install-cli`). Threaded in by the
  // caller (`list.ts`, via `fkanbanInvocation()`) rather than computed here so
  // `board.ts` stays pure/testable. Defaults to the bare `fkanban` form, which
  // keeps existing pure-render tests unaffected. Mirrors init's Next-steps
  // shim-awareness (PR #69) so copy-pasting the hint never hits `command not
  // found: fkanban`.
  invocation?: string;
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

// The shared "colour on by default?" decision: ANSI is enabled when stdout is a
// TTY (and disabled when piped/redirected). Centralized so every renderer's
// `opts.color ?? …` fallback resolves identically.
function defaultColor(): boolean {
  return Boolean(process.stdout.isTTY);
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
  const color = opts.color ?? defaultColor();
  const allColumns = resolveColumns(board.columns);
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
    const invocation = opts.invocation ?? "fkanban";
    // On a non-default board, the hint must carry `--board <slug>` on both the
    // `add` and the follow-up `list` so a dev who copy-pastes it literally
    // lands their first card on the board they're VIEWING — not the default
    // board (where a bare `add` resolves). Default board keeps the bare,
    // byte-for-byte-unchanged form (no `--board` noise).
    const boardFlag = board.slug !== DEFAULT_BOARD_SLUG ? ` --board ${board.slug}` : "";
    lines.push("No cards yet. Create your first:");
    lines.push(
      paint(color, "cyan", `  ${invocation} add my-first-card --title "My first card"${boardFlag}`),
    );
    lines.push("");
    lines.push(
      paint(
        color,
        "dim",
        `(then \`${invocation} list${boardFlag}\` to see it, or \`${invocation} mcp\` to drive the board from an agent)`,
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
  const allColumns = resolveColumns(board.columns);
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

function cell(value: string | undefined): string {
  const s = value?.trim() ?? "";
  return s.length > 0 ? s : "-";
}

function pad(value: string, width: number): string {
  return value.padEnd(width, " ");
}

// Render a flat, fixed-width list for reconcile/pickup agents that need the
// structured fields without hand-formatting `list --json`.
export function renderWideTable(cards: Card[]): string {
  const headers = ["COLUMN", "SLUG", "REPO", "BASE", "PR", "UPDATED", "TITLE"];
  const rows = cards.map((c) => [
    cell(c.column),
    cell(c.slug),
    cell(c.repo),
    cell(c.base),
    cell(c.pr_url),
    cell(c.updated_at),
    cell(c.title || c.slug),
  ]);
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)),
  );
  const renderRow = (row: string[]) => row.map((v, i) => pad(v, widths[i] ?? v.length)).join("  ").trimEnd();
  return [renderRow(headers), ...rows.map(renderRow)].join("\n");
}

function cardMetaSuffix(c: Card, color: boolean): string {
  const meta: string[] = [];
  const kind = normalizeKind(c.kind);
  if (kind !== "pr") meta.push(`kind:${kind}`);
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

// The default number of search hits the text view renders before collapsing the
// rest behind a `… N more` overflow line. Search is a flat sorted list (unlike
// the per-column board), so it gets a single flat cap rather than `capPerColumn`.
export const DEFAULT_SEARCH_LIMIT = 20;

export type LimitOptions = {
  all?: boolean;
  limit?: number;
};

export function resolveLimits(
  opts: LimitOptions,
  defaultTextLimit: number,
): { textLimit: number; jsonLimit: number } {
  const hasExplicitLimit = Number.isFinite(opts.limit) && (opts.limit as number) >= 0;
  return {
    textLimit: opts.all ? 0 : hasExplicitLimit ? (opts.limit as number) : defaultTextLimit,
    jsonLimit: !opts.all && hasExplicitLimit ? (opts.limit as number) : 0,
  };
}

// Cap a flat, already-sorted card list, returning the first `limit`. `limit <= 0`
// (or `--all`) means no cap and returns the input unchanged. Mirrors
// `capPerColumn`'s contract for the flat search list so the text and `--json`
// views agree on which cards are shown.
export function capFlat<T extends Card>(cards: T[], limit: number): T[] {
  if (!(limit > 0)) return cards;
  return cards.slice(0, limit);
}

export const BODY_PREVIEW_CHARS = 200;

export function previewBody(body: string): { body: string; bodyTruncated: boolean } {
  const flattened = body.replace(/\s+/g, " ").trim();
  if (flattened.length <= BODY_PREVIEW_CHARS) {
    return { body: flattened, bodyTruncated: false };
  }
  return { body: flattened.slice(0, BODY_PREVIEW_CHARS), bodyTruncated: true };
}

export function previewCardBodies<T extends Card>(
  cards: T[],
  fullBody: boolean,
): Array<T & { bodyTruncated: boolean }> {
  if (fullBody) return cards.map((c) => ({ ...c, bodyTruncated: false }));
  return cards.map((c) => {
    const { body, bodyTruncated } = previewBody(c.body);
    return { ...c, body, bodyTruncated };
  });
}

// Render search hits as a flat list. Unlike the board view, matches can span
// columns and boards, so each line is annotated with its `[board/column]`.
// Caps the rendered matches at `limit` (default `DEFAULT_SEARCH_LIMIT`) and
// appends a dim `… N more` overflow line, mirroring how `renderBoard` caps each
// column — so a search on a busy board doesn't flood the terminal. `limit <= 0`
// disables the cap (the `--all` path).
export function renderSearchResults(
  cards: Card[],
  query: string,
  opts: { color?: boolean; blocked?: Set<string>; limit?: number } = {},
): string {
  const color = opts.color ?? defaultColor();
  if (cards.length === 0) return paint(color, "dim", `No cards match "${query}".`);

  const cap = opts.limit ?? DEFAULT_SEARCH_LIMIT;
  const sorted = sortCards(cards);
  const hidden = cap > 0 && sorted.length > cap ? sorted.length - cap : 0;
  const visible = hidden === 0 ? sorted : sorted.slice(0, cap);

  const lines: string[] = [];
  const count = `${cards.length} match${cards.length === 1 ? "" : "es"}`;
  lines.push(paint(color, "bold", `${count} for "${query}"`));
  lines.push("");
  for (const c of visible) {
    const loc = paint(color, "dim", `[${c.board}/${c.column}]`);
    const slug = paint(color, "cyan", c.slug);
    const marker = opts.blocked?.has(c.slug) ? paint(color, "yellow", "🔒 ") : "";
    lines.push(`  • ${marker}${loc} ${c.title || c.slug}  ${slug}${cardMetaSuffix(c, color)}`);
  }
  if (hidden > 0) {
    lines.push(paint(color, "dim", `  … ${hidden} more (use --limit N or --all)`));
  }
  return lines.join("\n");
}

export function renderCardDetail(
  c: Card,
  color = defaultColor(),
  status?: DepStatus,
): string {
  const lines: string[] = [];
  const blocked = status?.blocked ? paint(color, "yellow", " 🔒 blocked") : "";
  lines.push(paint(color, "bold", c.title || c.slug) + blocked);
  lines.push(paint(color, "dim", `${c.slug} · ${c.board}/${c.column}`));
  if (c.assignee) lines.push(`assignee: @${c.assignee}`);
  if (c.tags.length > 0) lines.push(`tags: ${c.tags.map((t) => `#${t}`).join(" ")}`);
  // Structured pickup fields — only shown when set, so plain cards stay terse.
  if (c.repo) lines.push(`repo: ${c.repo}${c.base ? ` (base ${c.base})` : ""}`);
  if (c.db) lines.push(`db: ${c.db}`);
  if (c.kind && c.kind !== "pr") lines.push(`kind: ${c.kind}`);
  if (c.block_status && c.block_status !== "none") {
    lines.push(
      paint(color, "yellow", `block: ${c.block_status}`) + (c.block_reason ? ` — ${c.block_reason}` : ""),
    );
  }
  if (c.north_star) lines.push(`north star: ${c.north_star}`);
  if (c.pr_url) lines.push(`pr: ${c.pr_url}`);
  if (c.branch) lines.push(`branch: ${c.branch}`);
  if (c.surfaces.length > 0) lines.push(`surfaces: ${c.surfaces.join(", ")}`);
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
