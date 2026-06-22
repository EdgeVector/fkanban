// `fkanban list` — render a board (default board unless --board) as columns
// of cards. `--json` dumps the raw cards instead.

import { type NodeClient } from "../client.ts";
import { type Config } from "../config.ts";
import { blockedSlugSet, boardTerminalMap, depStatus, ensureColumn, findBoard, listBoards, listCards, requireBoard, sortCards, type Card, type Board } from "../record.ts";
import { capPerColumn, renderBoard, type RenderOptions } from "../board.ts";
import { fkanbanInvocation } from "../mcp/register.ts";
import { DEFAULT_COLUMNS } from "../schemas.ts";
import { type CardDetail } from "./show.ts";

// Cards shown per column before the rest collapse to a "… N more" line.
// Comfortably above a healthy active column; trims an unbounded `done`.
export const DEFAULT_COLUMN_LIMIT = 12;

export type ListOptions = {
  cfg: Config;
  node: NodeClient;
  board?: string;
  column?: string;
  // Exact filters — tag is a membership test, assignee an equality test. Both
  // are distinct from `search`'s fuzzy substring match. A tag/assignee need not
  // pre-exist; an unmatched value renders an empty board, never an error.
  tag?: string;
  assignee?: string;
  json?: boolean;
  // Per-column cap (defaults to DEFAULT_COLUMN_LIMIT). `all` removes the cap.
  limit?: number;
  all?: boolean;
};

// Both the human text and the structured (`--json`) payload, built from a
// single board+cards read. `listCmd` (CLI) returns one or the other; the MCP
// tool returns both, so it computes the data once and hands the structured
// `cards` array straight to `structuredContent`.
//
// `cards` is the FULL filtered set (the implicit DEFAULT_COLUMN_LIMIT is a
// text *display* affordance only — `renderBoard` applies it to `text` and
// shows a "… N more" footer, but the structured array stays complete so
// machine consumers get every card). An *explicit* `--limit`/`--all` is
// different: it's an intentional per-column cap that should mean the same
// thing on both surfaces, so it's surfaced as `jsonLimit` for callers that
// serialize `cards` (`listCmd` for `--json`) to apply via `capPerColumn`.
// `jsonLimit`: 0 = no cap (default, and `--all`); >0 = explicit `--limit` cap.
//
// Each returned card is enriched with its resolved dependency status (`blocked`,
// `blockedBy`, `missingDeps`) — the SAME shape `show --json` emits — so the
// structured/JSON surface tells a machine consumer which cards are blocked
// without re-deriving dep status or a per-card `show`. The text render is
// unchanged (it consumes only the 🔒 marker via `blockedSlugSet`).
export async function listResult(
  opts: ListOptions,
): Promise<{ text: string; cards: CardDetail[]; board: Board; jsonLimit: number }> {
  const boardSlug = opts.board ?? "default";
  // An explicitly-passed board must exist — a typo'd name should error loudly
  // (matching `add`), not silently render an empty default-column board. The
  // no-`--board` path defaults to `default`, which always exists, so it stays
  // on the cheap `findBoard` lookup with no extra read on the hot path.
  const board =
    opts.board !== undefined
      ? await requireBoard(opts.node, opts.cfg, boardSlug)
      : await findBoard(opts.node, opts.cfg, boardSlug);

  const resolvedBoard = board ?? {
    slug: boardSlug,
    title: boardSlug,
    body: "",
    columns: [...DEFAULT_COLUMNS],
    created_at: "",
    updated_at: "",
  };
  // An explicitly-passed `--column` must be a real column on the resolved
  // board — a typo'd name should error loudly (matching `move`/`add` via the
  // shared `ensureColumn`), not silently filter every card out and render an
  // empty board. Only checked when `--column` is set, so the no-`--column` hot
  // path is unchanged.
  if (opts.column !== undefined) ensureColumn(opts.column, resolvedBoard.columns);

  const allCards = await listCards(opts.node, opts.cfg);
  // Terminal column per board (board slug → last column) so a dep counts as
  // done at its OWN board's final column, not only a literal `done`. Resolved
  // against ALL boards because blocked status spans cross-board deps below.
  const boardTerminal = boardTerminalMap(await listBoards(opts.node, opts.cfg));
  const cards = sortCards(
    allCards.filter(
      (c) =>
        c.board === boardSlug &&
        (!opts.column || c.column === opts.column) &&
        (!opts.tag || c.tags?.includes(opts.tag)) &&
        (!opts.assignee || c.assignee === opts.assignee),
    ),
  );

  // Resolve blocked status against ALL live cards so cross-board deps count.
  // Text render cap: an explicit `--limit` (always >= 1 after flag parsing),
  // `--all` removes the cap (0), and the no-flag default falls back to
  // DEFAULT_COLUMN_LIMIT so a long column collapses to a "… N more" line.
  const limit = opts.all
    ? 0
    : Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : DEFAULT_COLUMN_LIMIT;
  // Print the empty-board first-touch hint in the form that actually runs for
  // THIS dev — the `fkanban` shim if it's on PATH, else `bun run src/cli.ts`
  // (the fresh-clone default). Mirrors how init injects its Next-steps
  // invocation (PR #69); board.ts stays pure and defaults to bare `fkanban`.
  const renderOpts: RenderOptions = {
    blocked: blockedSlugSet(cards, allCards, boardTerminal),
    limit,
    invocation: fkanbanInvocation(),
  };
  if (opts.column) renderOpts.column = opts.column;
  // Enrich each filtered card with its dependency status (resolved against ALL
  // live cards so cross-board deps count), matching show's CardDetail shape.
  const enriched: CardDetail[] = cards.map((c) => {
    const status = depStatus(c, allCards, boardTerminal);
    return { ...c, blocked: status.blocked, blockedBy: status.blockedBy, missingDeps: status.missing };
  });
  // JSON cap: ONLY an *explicit* `--limit` caps the structured array; `--all`
  // and the no-flag default leave it uncapped (0). The implicit
  // DEFAULT_COLUMN_LIMIT never applies to JSON.
  const jsonLimit =
    !opts.all && Number.isFinite(opts.limit) && (opts.limit as number) >= 0
      ? (opts.limit as number)
      : 0;
  return { text: renderBoard(resolvedBoard, cards, renderOpts), cards: enriched, board: resolvedBoard, jsonLimit };
}

export async function listCmd(opts: ListOptions): Promise<string> {
  const { text, cards, board, jsonLimit } = await listResult(opts);
  if (!opts.json) return text;
  // Honor an explicit `--limit` on the machine-readable surface too: cap each
  // column to the same cards the text view shows. No explicit limit (jsonLimit
  // 0) → the full filtered board, unchanged.
  const out = jsonLimit > 0 ? capPerColumn(board, cards, jsonLimit, opts.column) : cards;
  return JSON.stringify(out, null, 2);
}

export function summarize(cards: Card[]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const c of cards) out[c.column] = (out[c.column] ?? 0) + 1;
  return out;
}
